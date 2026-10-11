// Phase 3C — the UniversalClient (core/client) end to end over real TLS.
//
// The client is the production controller library: pinning, pairing with node
// identity verification, challenge-response authentication, capabilities,
// sessions, tasks with idempotent submission, event replay with reconnect.
// The controller registry and device-key storage are checked for the ownership
// split: secrets under the device-local tree only, never the portable tree.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { buildNetStack } from './fixtures/net.mjs';
import { UniversalClient, parsePairingPayload, parseEndpoint, verifyNodeIdentity } from '../core/client/mod.mjs';
import { createControllerRegistry } from '../core/client/registry.mjs';
import { loadOrCreateControllerKey, deviceIdFromPem, signBytes } from '../core/client/keys.mjs';
import { createSecureStorage } from '../core/secrets/mod.mjs';

const SCOPES = ['read-only', 'project-session-control', 'task-control', 'file-modify'];

async function withNetStack(fn) {
  const net = await buildNetStack();
  try { return await fn(net); } finally { await net.dispose(); }
}

/** A controller profile rooted in the net stack's temp device-local tree. */
function controllerCtx(net, profile = 'default') {
  const p = { ...net.stack.p, device: net.stack.p.device || path.join(net.stack.root, 'device-local') };
  return { p, secureStorage: createSecureStorage({ root: net.stack.root, p }) };
}

test('client: pairing payload parsing rejects malformed and expired payloads', () => {
  assert.throws(() => parsePairingPayload('not json'), /not valid JSON|invalid/);
  assert.throws(() => parsePairingPayload({ v: 2 }), /version/);
  assert.throws(() => parsePairingPayload({ v: 1, nodeId: 'node_x' }), /nodeId/);
  assert.throws(() => parsePairingPayload({
    v: 1, nodeId: `node_${'a'.repeat(32)}`, endpoint: 'https://x:1', token: '0123456789abcdef0123456789abcdef', // uh-secret-fixture (not a real token)
    expiresAt: new Date(Date.now() - 1000).toISOString(), nodeIdentitySha256: '0'.repeat(64),
  }), /expired/);
  const ok = parsePairingPayload({
    v: 1, nodeId: `node_${'a'.repeat(32)}`, endpoint: 'https://x:7437', token: '0123456789abcdef0123456789abcdef', // uh-secret-fixture (not a real token)
    expiresAt: new Date(Date.now() + 50_000).toISOString(), nodeIdentitySha256: '0'.repeat(64),
  });
  assert.equal(ok.nodeId, `node_${'a'.repeat(32)}`);
  assert.deepEqual(parseEndpoint('https://192.168.1.9:7437'), { scheme: 'https', host: '192.168.1.9', port: 7437 });
});

test('client: connect requires a pin and refuses a mismatched certificate', async () => {
  await withNetStack(async (net) => {
    const { host, port } = net.tlsEndpoint();
    await assert.rejects(() => UniversalClient.connect({ host, port, pinnedCertSha256: null }), /pinned/i);
    await assert.rejects(
      () => UniversalClient.connect({ host, port, pinnedCertSha256: '0'.repeat(64) }),
      /does not match the fingerprint/,
      'a wrong pin must never be traded for a connection',
    );
  });
});

test('client: pair verifies node identity, stores pins, and the registry stays secret-free', async () => {
  await withNetStack(async (net) => {
    const { host, port } = net.tlsEndpoint();
    const pairing = net.mintPairing();
    const { p, secureStorage } = controllerCtx(net);
    const device = await loadOrCreateControllerKey({ p, profile: 'default', secureStorage });
    const client = await UniversalClient.connect({ host, port, pinnedCertSha256: pairing.nodeCertSha256 });
    try {
      assert.equal(client.nodeId, pairing.nodeId, 'the greeting identity matches the payload');
      assert.ok(client.operations.includes('session.list'), 'capabilities are available before auth');

      const reply = await client.pair({
        payload: parsePairingPayload(pairing), device,
        deviceName: 'client-test', platform: 'desktop', requestedScopes: SCOPES,
      });
      assert.equal(reply.ok, true, JSON.stringify(reply.payload));
      assert.equal(client.deviceId, reply.payload.deviceId);
      assert.deepEqual([...client.grantedScopes].sort(), [...SCOPES].sort());
      assert.equal(device.deviceId, reply.payload.deviceId, 'deviceId derives from the controller public key');
      assert.equal(client.nodeKind, 'desktop');
    } finally { client.close('test done'); }

    // Registry: pins and metadata only. The private key lives elsewhere.
    const registry = createControllerRegistry({ p, profile: 'default' });
    registry.upsert({
      nodeId: pairing.nodeId, endpoint: pairing.endpoint, host, port,
      nodeIdentitySha256: pairing.nodeIdentitySha256, nodeCertSha256: pairing.nodeCertSha256,
      deviceId: device.deviceId, name: pairing.nodeName, grantedScopes: SCOPES,
    });
    const raw = fs.readFileSync(registry.filePath, 'utf8');
    assert.ok(!raw.includes('PRIVATE KEY'), 'no private key in the registry');
    assert.ok(raw.includes(pairing.nodeCertSha256), 'the certificate pin is stored for reconnects');

    // The key file lives under the device-local tree, never the portable data/.
    const keyFile = path.join(p.device, 'controller', 'default', 'controller-key.private.pem');
    if (secureStorage.describe().backend === 'unavailable') {
      assert.equal(fs.existsSync(keyFile), true, 'without an OS keystore the 0600 fallback file exists');
    }
    const portableData = net.stack.p.data;
    assert.ok(!fs.existsSync(path.join(portableData, 'controller')), 'nothing controller-owned in the portable tree');
  });
});

test('client: a tampered node identity proof is refused', async () => {
  const challenge = ' challenge ';
  assert.equal(verifyNodeIdentity({
    nodeSigB64: Buffer.from('bogus').toString('base64'),
    nodePublicKeyPem: 'not a pem',
    expectedNodeIdentitySha256: '0'.repeat(64),
    challengeB64: challenge,
  }), false);
});

test('client: full controller flow — pair, sessions, idempotent task, events, reconnect+replay', async () => {
  await withNetStack(async (net) => {
    const { host, port } = net.tlsEndpoint();
    const pairing = net.mintPairing();
    const { p, secureStorage } = controllerCtx(net);
    const device = await loadOrCreateControllerKey({ p, profile: 'flow', secureStorage });
    const client = await UniversalClient.connect({ host, port, pinnedCertSha256: pairing.nodeCertSha256 });
    const paired = await client.pair({
      payload: parsePairingPayload(pairing), device, deviceName: 'flow-test', platform: 'desktop', requestedScopes: SCOPES,
    });
    assert.equal(paired.ok, true, JSON.stringify(paired.payload));

    // Capabilities + projects + sessions.
    assert.ok(client.operations.includes('session.create'));
    const proj = requireOk(await client.createProject({ name: 'flow' }), 'project.create');
    const created = requireOk(await client.createSession({ projectId: proj.projectId, label: 'flow-session' }), 'session.create');
    const listed = requireOk(await client.listSessions({ projectId: proj.projectId }), 'session.list');
    assert.equal(listed.sessions.length, 1);
    const resumed = requireOk(await client.resumeSession({ sessionId: created.session.sessionId, label: 'continuation' }), 'session.resume');
    assert.equal(resumed.resumedFromSessionId, created.session.sessionId);
    assert.equal(resumed.session.priorSessionId, created.session.sessionId);

    // Idempotent task start; events follow live.
    const started = requireOk(await client.startTask({
      projectId: proj.projectId, sessionId: created.session.sessionId,
      prompt: 'flow work', clientRequestId: 'flow-req-0001',
    }), 'task.start');
    const replayed = requireOk(await client.startTask({
      projectId: proj.projectId, sessionId: created.session.sessionId,
      prompt: 'flow work', clientRequestId: 'flow-req-0001',
    }), 'task.start retry');
    assert.equal(replayed.taskId, started.taskId, 'clientRequestId replay returns the same task');
    const terminal = await Promise.race([
      client.wire.next((e) => e.type === 'event' && ['task.completed', 'task.failed'].includes(e.payload?.kind) && e.payload.taskId === started.taskId, { timeoutMs: 5000 }),
      new Promise((resolve) => setTimeout(() => resolve(null), 5000)),
    ]);
    assert.ok(terminal, 'the task lifecycle arrives as live durable events');

    // History via the client helper.
    const hist = requireOk(await client.taskHistory({ taskId: started.taskId, limit: 200 }), 'task.history');
    assert.ok(hist.events.length >= 4);

    // Reconnect: same device, fresh TLS, replay from the cursor.
    const lastEventId = client.lastEventId;
    const reconnected = await UniversalClient.reconnect({
      host, port, pinnedCertSha256: pairing.nodeCertSha256, device, deviceId: client.deviceId, lastEventId,
    });
    assert.equal(reconnected.ok, true, JSON.stringify(reconnected.error || {}));
    const events = requireOk(reconnected.replay, 'session.replay');
    // A fresh client saw everything up to its cursor, so nothing new is required;
    // the invariant is the replay is well-formed and the cursor advanced.
    assert.equal(events.unavailable, false);
    assert.ok(Array.isArray(events.events));
    reconnected.client.close('flow done');
    client.close('flow done');
  });
});

test('client: reconnect surfaces a structured auth failure for an unknown device', async () => {
  await withNetStack(async (net) => {
    const { host, port } = net.tlsEndpoint();
    const pairing = net.mintPairing();
    const { p, secureStorage } = controllerCtx(net);
    const device = await loadOrCreateControllerKey({ p, profile: 'stranger', secureStorage });
    const reconnected = await UniversalClient.reconnect({
      host, port, pinnedCertSha256: pairing.nodeCertSha256,
      device, deviceId: device.deviceId, // never paired
      lastEventId: 0,
    });
    assert.equal(reconnected.ok, false);
    assert.equal(reconnected.error.code, 'CHALLENGE_FAILED', 'constant-failure, no information leak');
  });
});

function requireOk(reply, what) {
  if (reply.ok) return reply.payload;
  throw new Error(`${what} failed: ${JSON.stringify(reply.payload)}`);
}
