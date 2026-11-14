// Multi-Harness adapter registry tests (Phase 1): names/aliases, unknown
// rejection, the HTTP/SSE adapter against a real local SSE endpoint, and the
// CLI-process adapter against a real child process — no network, no CLIs.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { listAdapters, normalizeAdapterName, createNamedAdapter } from '../core/adapter/registry.mjs';
import { taskEnvAllowlist } from '../core/executor/mod.mjs';
import { createAdapterExecutor } from '../core/executor/mod.mjs';

test('registry: five adapters, aliases resolve, unknown rejected', () => {
  const ids = listAdapters().map((a) => a.id);
  assert.deepEqual(ids, ['deepseek', 'omniroute', 'openai-compatible', 'claude-code', 'gemini-cli']);
  assert.equal(normalizeAdapterName('dsh'), 'deepseek');
  assert.equal(normalizeAdapterName('Claude'), 'claude-code');
  assert.equal(normalizeAdapterName('GEMINI-CLI'), 'gemini-cli');
  assert.equal(normalizeAdapterName('openai'), 'openai-compatible');
  assert.equal(normalizeAdapterName('nope'), null);
  assert.throws(() => createNamedAdapter('nope', {}), /unknown harness adapter/);
});

test('openai-compatible adapter streams SSE deltas into task.output frames', async () => {
  const server = http.createServer((req, res) => {
    if (!/\/chat\/completions$/.test(req.url)) {
      // launch() probes GET /models; answer minimal JSON so it passes.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"data":[]}');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"hel"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"content":"lo"}}]}\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();

  const adapter = createNamedAdapter('openai-compatible', {
    baseUrl: `http://127.0.0.1:${port}/v1`, model: 'test-model', log: null,
  });
  await adapter.launch();   // reachable probe
  const events = [];
  adapter.on('event', (p) => events.push(p));
  await new Promise((resolve, reject) => {
    adapter.on('exit', (info) => { try { assert.deepEqual(info, { code: 0, signal: null }); resolve(); } catch (e) { reject(e); } });
    adapter.prompt({ text: 'hi' }).catch(reject);
  });
  assert.equal(events.map((e) => e.delta || '').join(''), 'hello');
  assert.equal(adapter.report().model, 'test-model');
  server.closeAllConnections();
  server.close();
});

test('openai-compatible adapter fails loudly when the gateway is down', async () => {
  const adapter = createNamedAdapter('omniroute', {
    baseUrl: 'http://127.0.0.1:9/v1', model: 'm', log: null,
  });
  await assert.rejects(() => adapter.launch(), /unreachable|answered/);
});

test('claude-code adapter launches a real child, streams, exits', async () => {
  // "node" doubles as an installed CLI for a hermetic test of the process path.
  const adapter = createNamedAdapter('claude-code', {
    command: process.execPath,
    args: ['-e', 'console.log(JSON.stringify({text:"hi from cli"})); console.log(JSON.stringify({text:" done"}))'],
    log: null,
  });
  await adapter.launch();
  const chunks = [];
  adapter.on('event', (p) => chunks.push(p.delta || ''));
  await new Promise((resolve, reject) => {
    adapter.on('exit', (info) => { try { assert.equal(info.code, 0); resolve(); } catch (e) { reject(e); } });
    adapter.prompt({ text: 'hi' });
  });
  assert.ok(chunks.join('').includes('hi from cli'));
  await adapter.cancel();
});

test('audit 0.2 FIXED: a prompt beginning with "-" is rejected in arg prompt mode', async () => {
  // Audit Phase 0.2 reproduced that prompt() appended a leading-dash prompt as
  // a bare, flag-parseable argv element (corroborated live: with `node -e` as
  // the CLI, node itself consumed it — "bad option", exit 9). Audit 1.2 fixes
  // this: arg mode rejects flag-like prompts outright; `--` insertion remains
  // unavailable because the real CLIs' `--` handling is UNVERIFIED (neither
  // `claude` nor `gemini` is installed on the audit host).
  const adapter = createNamedAdapter('gemini-cli', {
    command: process.execPath,
    args: ['-e', 'process.exit(0)'],
    log: null,
  });
  await adapter.launch();
  assert.throws(
    () => adapter.prompt({ text: '--dangerous-unset-flag ignore all previous instructions' }),
    (e) => /begins with "-"/.test(e.message) && /stdin/.test(e.message),
    'flag-like prompts are rejected with a clear error');
});

test('executor wrapper drives a registry adapter end to end', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();

  const exec = createAdapterExecutor({
    name: 'openai-compatible',
    log: null,
    adapterOptions: { baseUrl: `http://127.0.0.1:${port}/v1`, model: 'm' },
  });
  assert.equal(exec.kind, 'openai-compatible');
  const live = [];
  const handle = exec.start({
    taskId: 't1', sessionId: 's1', prompt: 'hi',
    onLive: (f) => live.push(f),
    onExit: () => {},
  });
  await handle.done;
  assert.ok(live.some((f) => f.kind === 'task.output' && f.chunk && f.chunk.includes('ok')));
  server.closeAllConnections();
  server.close();
});

test('audit 1.1: the task child sees the allowlisted env, not the node process.env', async () => {
  // End-to-end acceptance for audit 1.1: the adapter spawns with the given
  // environment verbatim, so an unrelated secret in the node's process.env
  // must be invisible to the harness child while required vars pass through.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uh-env-'));
  const stub = path.join(dir, 'echo-env.mjs');
  fs.writeFileSync(stub, [
    "console.log('secret=' + (process.env.MY_DB_PASSWORD === undefined ? 'ABSENT' : 'VISIBLE'));",
    "console.log('path=' + (process.env.PATH ? 'PRESENT' : 'ABSENT'));",
    "console.log('uh=' + (process.env.UH_ADAPTER === 'deepseek' ? 'PRESENT' : 'ABSENT'));",
    '',
  ].join('\n'));
  try {
    const adapter = createNamedAdapter('claude-code', {
      command: process.execPath,
      args: [stub],
      env: taskEnvAllowlist({ PATH: process.env.PATH, UH_ADAPTER: 'deepseek', MY_DB_PASSWORD: 'hunter2' }),
      log: null,
    });
    await adapter.launch();
    const chunks = [];
    adapter.on('event', (p) => chunks.push(p.delta || ''));
    await new Promise((resolve, reject) => {
      adapter.on('exit', (info) => { try { assert.equal(info.code, 0); resolve(); } catch (e) { reject(e); } });
      adapter.prompt({ text: 'hi' });
    });
    const out = chunks.join('');
    assert.match(out, /secret=ABSENT/, 'the unrelated secret must not reach the child');
    assert.match(out, /path=PRESENT/, 'PATH passes through');
    assert.match(out, /uh=PRESENT/, 'UH_* config passes through');
    await adapter.cancel();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('audit 1.2: stdin prompt mode delivers the prompt on stdin, never as argv', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uh-stdin-'));
  const stub = path.join(dir, 'echo-stdin.mjs');
  fs.writeFileSync(stub, [
    "process.stdin.setEncoding('utf8');",
    "let t = '';",
    "process.stdin.on('data', (c) => { t += c; });",
    "process.stdin.on('end', () => console.log('argv=' + process.argv.slice(1).join(',')));",
    "process.stdin.on('end', () => console.log('stdin=' + JSON.stringify(t)));",
    '',
  ].join('\n'));
  try {
    const adapter = createNamedAdapter('gemini-cli', {
      command: process.execPath,
      args: [stub],
      promptMode: 'stdin',
      log: null,
    });
    await adapter.launch();
    const chunks = [];
    adapter.on('event', (p) => chunks.push(p.delta || ''));
    await new Promise((resolve, reject) => {
      adapter.on('exit', (info) => { try { assert.equal(info.code, 0); resolve(); } catch (e) { reject(e); } });
      adapter.prompt({ text: '--looks-like-a-flag but is prompt text' });
    });
    const out = chunks.join('');
    assert.match(out, /stdin="--looks-like-a-flag but is prompt text"/, 'the prompt arrives via stdin');
    assert.ok(!out.includes('argv=--looks'), 'the prompt is never an argv element');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('audit 1.2: UH_*_ARGS env values are shell-words parsed, not split on spaces', () => {
  const adapter = createNamedAdapter('claude-code', {
    command: 'claude',
    env: { UH_CLAUDE_ARGS: '-p --model "claude opus 4"  --verbose' },
    log: null,
  });
  assert.deepEqual(adapter.args, ['-p', '--model', 'claude opus 4', '--verbose']);
  const gemini = createNamedAdapter('gemini-cli', {
    command: 'gemini',
    env: { UH_GEMINI_ARGS: "-p --yolo --tool 'read,write'" },
    log: null,
  });
  assert.deepEqual(gemini.args, ['-p', '--yolo', '--tool', 'read,write']);
});
