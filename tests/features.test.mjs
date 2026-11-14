// Audit-round feature tests: the harness resilience chain, the node.status
// protocol operation, `uh config` deep-merge semantics, and the executor
// shutdown-teardown seam. Lean, hermetic, no network beyond loopback SSE.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { adapterChainFromConfig, createResilientAdapter, normalizeAdapterName } from '../core/adapter/registry.mjs';
import { ADVERTISED_OPERATIONS, KINDS } from '../core/protocol/mod.mjs';
import { buildStack, disposeStack, buildPairedSession } from './fixtures/stack.mjs';

test('registry: the resilience chain dedups and order-stabilizes', () => {
  assert.deepEqual(adapterChainFromConfig('omniroute', { adapter: { harnessChain: ['deepseek', 'dsh', 'omniroute'] } }),
    ['omniroute', 'deepseek']);
  assert.deepEqual(adapterChainFromConfig('deepseek', { adapter: { harnessChain: [] } }), ['deepseek']);
  assert.equal(normalizeAdapterName('openai'), 'openai-compatible');
});

test('registry: a dead primary degrades the task to the next harness', async () => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"data":[]}');
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const { port } = upstream.address();

  const adapter = createResilientAdapter({
    names: ['omniroute', 'openai-compatible'],
    resolveOptions: (name) => name === 'omniroute'
      ? { baseUrl: 'http://127.0.0.1:9/v1', model: 'm' } // unreachable port
      : { baseUrl: `http://127.0.0.1:${port}/v1`, model: 'm' },
    log: null,
    timeouts: { startup: 3000 },
  });
  await adapter.launch();
  assert.equal(adapter.chosen, 'openai-compatible');
  // report() names the harness that actually served, and always carries the
  // chain context for diagnostics.
  assert.equal(adapter.report().adapter, 'openai-compatible');
  assert.deepEqual(adapter.report().chain, ['omniroute', 'openai-compatible']);
  assert.equal(adapter.report().chosen, 'openai-compatible');
  adapter.close();
  upstream.closeAllConnections();
  upstream.close();
});

test('registry: an all-dead chain fails loudly with every start error', async () => {
  const adapter = createResilientAdapter({
    names: ['omniroute', 'openai-compatible'],
    resolveOptions: () => ({ baseUrl: 'http://127.0.0.1:9/v1', model: 'm' }),
    log: null,
    timeouts: { startup: 3000 },
  });
  await assert.rejects(() => adapter.launch(), /no harness adapter in the chain could start/);
});

test('protocol: node.status is advertised and served with live health', async () => {
  assert.ok(ADVERTISED_OPERATIONS.includes(KINDS.NODE_STATUS));
  const stack = await buildStack({});
  try {
    const conn = await buildPairedSession(stack);
    const { wire } = conn;
    const reply = await wire.request('node.status', {}, 'req_status_001');
    assert.equal(reply.ok, true);
    const payload = reply.payload;
    assert.equal(payload.nodeId, stack.identity.nodeId);
    assert.equal(typeof payload.platform, 'string');
    assert.equal(typeof payload.uptimeSeconds, 'number');
    assert.equal(typeof payload.connections, 'number');
    assert.deepEqual(payload.tasks, { live: 0, recorded: 0 });
  } finally { disposeStack(stack); }
});

test('config: `uh config set` deep-merges instead of clobbering sections', async () => {
  // A throwaway root: cmdConfig writes only under data/config.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uh-config-'));
  try {
    const { cmdConfig } = await import('../core/cli/registry.mjs');
    const { portablePaths } = await import('../core/paths/mod.mjs');
    const p = portablePaths(root);
    const log = { info() {}, warn() {}, error() {}, debug() {} };
    fs.mkdirSync(p.config, { recursive: true });

    // Seed a section with two fields, then set one — the other must survive.
    const created = await cmdConfig(['set', 'adapter.omniroute.baseUrl', 'http://127.0.0.1:8090/v1'], { root, p, log });
    assert.equal(created, 0);
    const set2 = await cmdConfig(['set', 'adapter.harness', 'omniroute'], { root, p, log });
    assert.equal(set2, 0);

    const loaded = JSON.parse(fs.readFileSync(path.join(p.config, 'config.json'), 'utf8'));
    assert.equal(loaded.adapter.harness, 'omniroute');
    assert.equal(loaded.adapter.omniroute.baseUrl, 'http://127.0.0.1:8090/v1');
    // Defaults survived the round-trip (merge kept unknown/default keys).
    assert.equal(loaded.adapter.omniroute.model, null);
    assert.equal(loaded.server.maxConnections, 32);
    assert.equal(loaded.schemaVersion, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('server: shutdown() cancels every live task executor', async () => {
  const stack = await buildStack({});
  try {
    const conn = await buildPairedSession(stack, { scopes: ['read-only', 'project-session-control', 'task-control'] });
    const { wire, server } = conn;
    const proj = await wire.request('project.create', { name: 'shutdown-test' }, 'req_proj_001');
    assert.equal(proj.ok, true, proj.error || 'project.create');
    const start = await wire.request('task.start', { projectId: proj.payload.projectId, prompt: 'long work' }, 'req_start_001');
    assert.equal(start.ok, true, start.error || 'task.start');
    const taskId = start.payload.taskId;
    const cancelled = await server.shutdown();
    assert.equal(cancelled, 1);
    const record = stack.events.taskRecord(taskId);
    assert.equal(record.state, 'cancelled');
  } finally { disposeStack(stack); }
});
