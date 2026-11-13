// Multi-Harness adapter registry tests (Phase 1): names/aliases, unknown
// rejection, the HTTP/SSE adapter against a real local SSE endpoint, and the
// CLI-process adapter against a real child process — no network, no CLIs.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { listAdapters, normalizeAdapterName, createNamedAdapter } from '../core/adapter/registry.mjs';
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
