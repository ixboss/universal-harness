// Phase 3C — the protocol diagnostics.run operation.
//
// diagnostics.run is wired to the doctor's building blocks (runtime status,
// storage probes, redaction) without the live dsh process check. Invariants:
// structured DiagnosticRecords, honest severities, safe subset selection,
// and — above all — no secret material anywhere in a response.

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildStack, disposeStack, buildPairedSession } from './fixtures/stack.mjs';

async function withStack(fn) {
  const stack = await buildStack();
  try { return await fn(stack); } finally { disposeStack(stack); }
}

test('diagnostics: the operation returns structured checks with the required fields', async () => {
  await withStack(async (stack) => {
    const session = await buildPairedSession(stack);
    const r = await session.wire.request('diagnostics.run', {}, 'req_diag_full');
    assert.equal(r.ok, true, JSON.stringify(r.payload));
    const checks = r.payload.checks;
    assert.ok(Array.isArray(checks) && checks.length >= 5, `expected several checks, got ${checks.length}`);
    const ids = checks.map((c) => c.id);
    for (const expected of ['node.identity', 'events.store', 'tasks.engine', 'server.state', 'security.devices']) {
      assert.ok(ids.includes(expected), `${expected} must be part of the node health report`);
    }
    for (const c of checks) {
      assert.equal(typeof c.id, 'string');
      assert.ok(['ok', 'warn', 'fail'].includes(c.severity), `severity of ${c.id} is structured`);
      assert.equal(typeof c.component, 'string');
      assert.equal(typeof c.condition, 'string');
      assert.equal(typeof c.recommendedAction, 'string');
    }
  });
});

test('diagnostics: no secret material ever appears in a response', async () => {
  await withStack(async (stack) => {
    const session = await buildPairedSession(stack);
    const r = await session.wire.request('diagnostics.run', {}, 'req_diag_secret');
    assert.equal(r.ok, true);
    const wireText = JSON.stringify(r.envelope);
    assert.ok(!wireText.includes('PRIVATE KEY'), 'no private key material');
    assert.ok(!wireText.includes('BEGIN'), 'no PEM blocks');
    assert.ok(!session.wire.all.some((e) => String(JSON.stringify(e)).includes(session.devicePublicKeyPem && 'PRIVATE')),
      'nothing secret-shaped leaks through diagnostics');
    // The pairing token itself must never appear: no key material, no PEM,
    // and no pending-token file paths.
    const minted = stack.auth.mintPairingPayload({ endpoint: 'memory://canary' });
    assert.ok(!wireText.includes(minted.token), 'a live pairing token value never appears in diagnostics');
    assert.ok(!wireText.includes('pending-pairing'), 'no token-store paths in diagnostics');
  });
});

test('diagnostics: a requested subset selects exactly those ids', async () => {
  await withStack(async (stack) => {
    const session = await buildPairedSession(stack);
    const r = await session.wire.request('diagnostics.run', { checks: ['tasks.engine', 'events.store'] }, 'req_diag_subset');
    assert.equal(r.ok, true);
    assert.deepEqual(r.payload.checks.map((c) => c.id).sort(), ['events.store', 'tasks.engine']);
  });
});

test('diagnostics: degraded nodes report honest severities instead of failing the operation', async () => {
  await withStack(async (stack) => {
    const session = await buildPairedSession(stack);
    // No runtimeManager on this fixture stack: runtime integrity must be a
    // warn/fail record, and the operation itself must still succeed.
    const r = await session.wire.request('diagnostics.run', {}, 'req_diag_degraded');
    assert.equal(r.ok, true, JSON.stringify(r.payload));
    const runtime = r.payload.checks.find((c) => c.id === 'runtime.status');
    assert.ok(runtime, 'the missing runtime manager is reported');
    assert.equal(runtime.severity, 'warn');

    const dsh = r.payload.checks.find((c) => c.id === 'dsh.available');
    assert.ok(dsh, 'dsh availability is reported');
    assert.equal(dsh.severity, 'warn', 'dsh absence is a warning, not an operation failure');

    // A fake executor completed task is visible in the task engine state.
    const proj = await session.wire.request('project.create', { name: 'diag' }, 'req_diag_proj');
    const started = await session.wire.request('task.start', { projectId: proj.payload.projectId, prompt: 'x' }, 'req_diag_task');
    await session.wire.wait('task.completed', 1, { timeoutMs: 5000 });
    const engine = await session.wire.request('diagnostics.run', { checks: ['tasks.engine'] }, 'req_diag_engine');
    const condition = engine.payload.checks[0].condition;
    assert.match(condition, /1 task\(s\) total/, 'the task count is real');
  });
});

test('diagnostics: a guest (unauthenticated) connection is refused like every other operation', async () => {
  await withStack(async (stack) => {
    const session = await buildPairedSession(stack);
    const { createMemoryTransportPair } = await import('../core/transport/mod.mjs');
    const { wireClient } = await import('./fixtures/wire.mjs');
    const pair = createMemoryTransportPair();
    const wire = wireClient(pair.client);
    session.server.handleConnection(pair.node);
    await wire.next((e) => e.payload?.kind === 'node.hello');
    const r = await wire.request('diagnostics.run', {}, 'req_diag_guest');
    assert.equal(r.ok, false);
    assert.equal(r.payload.code, 'AUTH_REQUIRED');
  });
});
