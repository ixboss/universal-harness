// Phase 3C — bounded connection management on the network listeners.
//
// The node accepts at most `maxConnections` sockets (an over-cap peer is
// dropped before its TLS handshake completes) and reaps an established stream
// that stays silent in BOTH directions for `idleTimeoutMs`. Neither bound may
// disturb task execution: tasks are node-owned and outlive connections, and a
// controller receiving a steady stream of events is never idle.

import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

import { buildNetStack } from './fixtures/net.mjs';
import { connectNodeTransport } from '../core/transport/net.mjs';
import { wireClient } from './fixtures/wire.mjs';

async function withNetStack(fn, { listener: listenerOpts } = {}) {
  const net = await buildNetStack({ listenerOptions: listenerOpts });
  try { return await fn(net); } finally { await net.dispose(); }
}

test('connection cap: an over-cap connection is rejected deterministically', async () => {
  await withNetStack(async (net) => {
    const { host, port } = net.tlsEndpoint();
    const pairing = net.mintPairing();
    const first = await connectNodeTransport({ host, port, pinnedCertSha256: pairing.nodeCertSha256 });
    const wire = wireClient(first); // attach before any await: the greeting is already in flight
    try {
      // The listener was built with maxConnections: 1 — the second socket must
      // be dropped before it can even start a TLS handshake.
      await assert.rejects(
        () => connectNodeTransport({ host, port, pinnedCertSha256: pairing.nodeCertSha256, connectTimeoutMs: 3000 }),
        (e) => /NODE_UNREACHABLE|NODE_TIMEOUT|ECONNRESET|EPIPE|socket/.test(`${e.code || ''} ${e.message || ''}`),
        'the over-cap connection must fail',
      );
      assert.equal(net.tlsListener.stats().rejectedConnections, 1);
      // The legitimate connection is untouched and still serves requests.
      const greeting = await wire.next((e) => e.payload?.kind === 'node.hello', { timeoutMs: 2000 });
      assert.ok(greeting, 'the admitted connection is healthy');
    } finally { first.close('test done'); }
  }, { listener: { maxConnections: 1 } });
});

test('connection cap: freed slots admit new connections', async () => {
  await withNetStack(async (net) => {
    const { host, port } = net.tlsEndpoint();
    const pairing = net.mintPairing();
    const first = await connectNodeTransport({ host, port, pinnedCertSha256: pairing.nodeCertSha256 });
    first.close('freeing the slot');
    await delay(100);
    const second = await connectNodeTransport({ host, port, pinnedCertSha256: pairing.nodeCertSha256 });
    assert.ok(second, 'a connection after a clean close is admitted');
    second.close('test done');
  }, { listener: { maxConnections: 1 } });
});

test('idle timeout: a silent stream is reaped, and the client observes the close', async () => {
  await withNetStack(async (net) => {
    const { host, port } = net.tlsEndpoint();
    const pairing = net.mintPairing();
    const transport = await connectNodeTransport({ host, port, pinnedCertSha256: pairing.nodeCertSha256 });
    const closed = new Promise((resolve) => transport.onClose(resolve));
    // idleTimeoutMs=200 on this listener; stay completely silent.
    const reason = await Promise.race([closed, delay(3000).then(() => 'not closed')]);
    assert.notEqual(reason, 'not closed', 'the idle connection must be reaped');
    assert.equal(net.tlsListener.stats().idleReaps >= 1, true, 'the reap is visible in listener stats');
  }, { listener: { idleTimeoutMs: 200 } });
});

test('idle timeout: an active connection is never reaped; traffic counts both ways', async () => {
  await withNetStack(async (net) => {
    const { host, port } = net.tlsEndpoint();
    const pairing = net.mintPairing();
    const transport = await connectNodeTransport({ host, port, pinnedCertSha256: pairing.nodeCertSha256 });
    const wire = wireClient(transport);
    // idleTimeoutMs=250; ping the node with authenticated-free handshake ops
    // every 100ms for ~1.2s (far beyond the idle window) and stay served.
    for (let i = 0; i < 12; i++) {
      const reply = await wire.request('node.hello', {}, `req_idle_${String(i).padStart(4, '0')}`, { timeoutMs: 2000 });
      assert.equal(reply.ok, true, `request ${i} must be served on a kept-alive connection`);
      await delay(100);
    }
    transport.close('test done');
  }, { listener: { idleTimeoutMs: 250 } });
});

test('idle reaping never touches task execution: the task completes after its controller is reaped', async () => {
  await withNetStack(async (net) => {
    const { host, port } = net.tlsEndpoint();
    const pairing = net.mintPairing();
    const transport = await connectNodeTransport({ host, port, pinnedCertSha256: pairing.nodeCertSha256 });
    const wire = wireClient(transport);
    const greeting = await wire.next((e) => e.payload?.kind === 'node.hello');
    // Pair quickly, start a task, then go silent and let the reaper take the
    // connection — the task must still run to completion node-side.
    const { generateKeyPairSync, sign } = await import('node:crypto');
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const paired = await wire.request('device.pair', {
      deviceName: 'idle-task-controller',
      platform: 'desktop',
      devicePublicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
      pairingToken: pairing.token,
      expectedNodeIdentitySha256: pairing.nodeIdentitySha256,
      requestedScopes: ['read-only', 'project-session-control', 'task-control', 'file-modify'],
      sigB64: sign(null, Buffer.from(greeting.payload.challengeB64, 'utf8'), privateKey).toString('base64'),
    }, 'req_idle_pair');
    assert.equal(paired.ok, true, JSON.stringify(paired.payload));
    const proj = await wire.request('project.create', { name: 'idle-task' }, 'req_idle_proj');
    assert.equal(proj.ok, true);
    const started = await wire.request('task.start', { projectId: proj.payload.projectId, prompt: 'outlive me' }, 'req_idle_start');
    assert.equal(started.ok, true, JSON.stringify(started.payload));

    // Silence: the 200ms idle reaper closes this connection mid-task.
    const closed = new Promise((resolve) => transport.onClose(resolve));
    await Promise.race([closed, delay(2000).then(() => 'not closed')]);

    // Reconnect as the same device and read the task's durable outcome.
    const fresh = await connectNodeTransport({ host, port, pinnedCertSha256: pairing.nodeCertSha256 });
    const wire2 = wireClient(fresh);
    const greeting2 = await wire2.next((e) => e.payload?.kind === 'node.hello');
    const auth = await wire2.request('auth.connect', {
      deviceId: paired.payload.deviceId,
      sigB64: sign(null, Buffer.from(greeting2.payload.challengeB64, 'utf8'), privateKey).toString('base64'),
    }, 'req_idle_auth');
    assert.equal(auth.ok, true);
    const hist = await wire2.request('task.history', { taskId: started.payload.taskId }, 'req_idle_hist');
    assert.equal(hist.ok, true, JSON.stringify(hist.payload));
    const kinds = hist.payload.events.map((e) => e.payload.kind);
    assert.ok(kinds.includes('task.completed') || kinds.includes('task.failed'),
      'the task reached a durable terminal state without its controller');
    fresh.close('test done');
  }, { listener: { idleTimeoutMs: 200 } });
});
