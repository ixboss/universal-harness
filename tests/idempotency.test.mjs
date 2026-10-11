// Phase 3C — clientRequestId idempotency for task.start.
//
// A controller retrying after a network timeout must never create a duplicate
// task. Contract: same authenticated device + same clientRequestId + same
// semantic request => the SAME task (idempotentReplay), while the same id with
// a materially different request is a CONFLICT. Records live in the durable
// task store, so they survive a node restart for the event-log retention
// window — there is no second idempotency database.

import test from 'node:test';
import assert from 'node:assert/strict';
import { sign } from 'node:crypto';

import { createNodeServer } from '../core/server/mod.mjs';
import { createMemoryTransportPair } from '../core/transport/mod.mjs';
import { buildStack, disposeStack, buildPairedSession } from './fixtures/stack.mjs';
import { wireClient } from './fixtures/wire.mjs';

async function withStack(fn) {
  const stack = await buildStack();
  try { return await fn(stack); } finally { disposeStack(stack); }
}

async function makeProject(wire, name, requestId) {
  const r = await wire.request('project.create', { name }, requestId);
  assert.equal(r.ok, true);
  return r.payload.projectId;
}

const REQ_ID = 'idem-req-0001';

test('idempotency: the first request creates, an identical retry returns the SAME task', async () => {
  await withStack(async (stack) => {
    const session = await buildPairedSession(stack);
    const projectId = await makeProject(session.wire, 'idem', 'req_i1_proj');

    const first = await session.wire.request('task.start', { projectId, prompt: 'same', clientRequestId: REQ_ID }, 'req_i1_a');
    assert.equal(first.ok, true, JSON.stringify(first.payload));
    assert.equal(first.payload.idempotentReplay, undefined, 'the first request is not a replay');

    const retry = await session.wire.request('task.start', { projectId, prompt: 'same', clientRequestId: REQ_ID }, 'req_i1_b');
    assert.equal(retry.ok, true, JSON.stringify(retry.payload));
    assert.equal(retry.payload.taskId, first.payload.taskId, 'a retry never creates a second task');
    assert.equal(retry.payload.idempotentReplay, true);
    assert.equal(retry.payload.sessionId, first.payload.sessionId);
  });
});

test('idempotency: a retry after controller disconnect returns the same task', async () => {
  await withStack(async (stack) => {
    const session = await buildPairedSession(stack);
    const projectId = await makeProject(session.wire, 'idem-dc', 'req_i2_proj');
    const first = await session.wire.request('task.start', { projectId, prompt: 'survives', clientRequestId: REQ_ID }, 'req_i2_a');
    assert.equal(first.ok, true);
    const taskEvents = session.wire.byKind('task.completed').length + session.wire.byKind('task.failed').length;

    // The connection drops mid-task and a fresh connection authenticates.
    const fresh = await session.reconnect();
    const retry = await fresh.wire.request('task.start', { projectId, prompt: 'survives', clientRequestId: REQ_ID }, 'req_i2_b');
    assert.equal(retry.ok, true, JSON.stringify(retry.payload));
    assert.equal(retry.payload.taskId, first.payload.taskId, 'the retry hits the same durable task');
    assert.equal(retry.payload.idempotentReplay, true);
  });
});

test('idempotency: concurrent duplicates on two connections resolve to one task', async () => {
  await withStack(async (stack) => {
    const session = await buildPairedSession(stack);
    const projectId = await makeProject(session.wire, 'idem-race', 'req_i3_proj');
    const fresh = await session.reconnect();

    const [a, b] = await Promise.all([
      session.wire.request('task.start', { projectId, prompt: 'race', clientRequestId: REQ_ID }, 'req_i3_a'),
      fresh.wire.request('task.start', { projectId, prompt: 'race', clientRequestId: REQ_ID }, 'req_i3_b'),
    ]);
    assert.equal(a.ok && b.ok, true, JSON.stringify([a.payload, b.payload]));
    assert.equal(a.payload.taskId, b.payload.taskId, 'the register-before-return update makes the race deterministic');
  });
});

test('idempotency: the same id with a materially different request is a CONFLICT', async () => {
  await withStack(async (stack) => {
    const session = await buildPairedSession(stack);
    const projectId = await makeProject(session.wire, 'idem-conflict', 'req_i4_proj');
    const first = await session.wire.request('task.start', { projectId, prompt: 'original prompt', clientRequestId: REQ_ID }, 'req_i4_a');
    assert.equal(first.ok, true);

    const different = await session.wire.request('task.start', { projectId, prompt: 'a DIFFERENT prompt', clientRequestId: REQ_ID }, 'req_i4_b');
    assert.equal(different.ok, false);
    assert.equal(different.payload.code, 'CONFLICT');
    assert.match(different.payload.message, /clientRequestId/);

    // Different priority is also a materially different request.
    const priorityClash = await session.wire.request('task.start', { projectId, prompt: 'original prompt', priority: 'urgent', clientRequestId: REQ_ID }, 'req_i4_c');
    assert.equal(priorityClash.ok, false);
    assert.equal(priorityClash.payload.code, 'CONFLICT');

    // The original retry still replays after the conflict.
    const stillSame = await session.wire.request('task.start', { projectId, prompt: 'original prompt', clientRequestId: REQ_ID }, 'req_i4_d');
    assert.equal(stillSame.ok, true);
    assert.equal(stillSame.payload.taskId, first.payload.taskId);
  });
});

test('idempotency: different authenticated devices may reuse the same id independently', async () => {
  await withStack(async (stack) => {
    const deviceA = await buildPairedSession(stack);
    const projectId = await makeProject(deviceA.wire, 'idem-multi', 'req_i5_proj');

    // A second device pairs with its own key.
    const pairing = stack.auth.mintPairingPayload({ endpoint: 'memory://test' });
    const { client, node } = createMemoryTransportPair();
    const wireB = wireClient(client);
    deviceA.server.handleConnection(node);
    const hello = await wireB.next((e) => e.payload?.kind === 'node.hello');
    const { generateKeyPairSync } = await import('node:crypto');
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const pairB = await wireB.request('device.pair', {
      deviceName: 'controller-b',
      platform: 'desktop',
      devicePublicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
      pairingToken: pairing.token,
      expectedNodeIdentitySha256: pairing.nodeIdentitySha256,
      requestedScopes: ['read-only', 'project-session-control', 'task-control', 'file-modify'],
      sigB64: sign(null, Buffer.from(hello.payload.challengeB64, 'utf8'), privateKey).toString('base64'),
    }, 'req_i5_pair');
    assert.equal(pairB.ok, true, JSON.stringify(pairB.payload));

    const a = await deviceA.wire.request('task.start', { projectId, prompt: 'from a', clientRequestId: REQ_ID }, 'req_i5_a');
    const b = await wireB.request('task.start', { projectId, prompt: 'from b', clientRequestId: REQ_ID }, 'req_i5_b');
    assert.equal(a.ok && b.ok, true);
    assert.notEqual(a.payload.taskId, b.payload.taskId, 'the idempotency key is scoped to the authenticated device');
    assert.equal(a.payload.idempotentReplay, undefined);
  });
});

test('idempotency: records survive a node restart', async () => {
  await withStack(async (stack) => {
    const session = await buildPairedSession(stack);
    const projectId = await makeProject(session.wire, 'idem-restart', 'req_i6_proj');
    const first = await session.wire.request('task.start', { projectId, prompt: 'durable idempotency', clientRequestId: REQ_ID }, 'req_i6_a');
    assert.equal(first.ok, true);
    await session.wire.wait('task.completed', 1, { timeoutMs: 5000 });

    // A brand-new server over the same durable state (a node restart).
    const server2 = createNodeServer({
      root: stack.root, p: stack.p,
      identity: stack.identity, auth: stack.auth, events: stack.events,
      workspace: stack.workspace, executorFactory: stack.executorFactory,
      uhVersion: '0.3.0',
    });
    const pair2 = createMemoryTransportPair();
    const wire2 = wireClient(pair2.client);
    server2.handleConnection(pair2.node);
    const hello2 = await wire2.next((e) => e.payload?.kind === 'node.hello');
    const auth2 = await wire2.request('auth.connect', {
      deviceId: session.deviceId,
      sigB64: sign(null, Buffer.from(hello2.payload.challengeB64, 'utf8'), session.devicePrivateKey).toString('base64'),
    }, 'req_i6_auth');
    assert.equal(auth2.ok, true);

    const retry = await wire2.request('task.start', { projectId, prompt: 'durable idempotency', clientRequestId: REQ_ID }, 'req_i6_b');
    assert.equal(retry.ok, true, JSON.stringify(retry.payload));
    assert.equal(retry.payload.taskId, first.payload.taskId, 'the idempotency record was rebuilt from the durable log');
    assert.equal(retry.payload.idempotentReplay, true);
    assert.equal(retry.payload.state, 'completed', 'the replay reports the task current state');

    const clash = await wire2.request('task.start', { projectId, prompt: 'different after restart', clientRequestId: REQ_ID }, 'req_i6_c');
    assert.equal(clash.ok, false);
    assert.equal(clash.payload.code, 'CONFLICT');
  });
});
