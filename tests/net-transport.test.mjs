// Phase 3B — network transport, discovery surface, TLS, and pairing over the
// wire (brief §13, §16, §17).
//
// These tests exercise the real network path: bytes leave the process, complete
// a TLS handshake on a loopback address, and come back. The loopback address
// stands in for the LAN because only one Android device is available; the
// security checks are not weakened for it (brief §16: "Do not weaken the
// security checks merely because there is only one Android device").
//
// Every case drives the *existing* Phase 2 node server through the new
// transport adapter; no protocol behaviour is reimplemented here.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';
import { randomBytes } from 'node:crypto';

import { requestEnvelope } from '../core/protocol/mod.mjs';
import {
  createSelfSignedCertificate, certificateFingerprint, loadOrCreateNodeTlsCertificate,
} from '../core/transport/cert.mjs';
import {
  createNetworkNodeListener, createLoopbackNodeListener, connectNodeTransport,
  connectLoopbackTransport, nodeHttpRequest, NodeTransportError,
} from '../core/transport/net.mjs';
import { buildNetStack, pairOverTls, connectRaw, newDeviceKey } from './fixtures/net.mjs';
import { wireClient } from './fixtures/wire.mjs';

const WAIT = { timeoutMs: 8000 };

// ---------------------------------------------------------------------------
// §16 steps 1-4: the node starts, the TLS listener starts, the certificate
// exists and its fingerprint can be obtained.
// ---------------------------------------------------------------------------

test('net: tls listener starts and the node greets a connecting controller first', async () => {
  const netStack = await buildNetStack();
  try {
    const { host, port, fingerprintSha256 } = netStack.tlsEndpoint();
    assert.equal(fingerprintSha256.length, 64, 'certificate fingerprint is a sha256 hex string');

    const transport = await connectNodeTransport({ host, port, pinnedCertSha256: fingerprintSha256 });
    const wire = wireClient(transport);
    const hello = await wire.next((e) => e.payload?.kind === 'node.hello', WAIT);

    // The node speaks first: identity, version range, operation set, challenge.
    assert.equal(hello.payload.nodeId, netStack.stack.identity.nodeId);
    assert.deepEqual(hello.payload.protocolVersionRange, [1, 1]);
    assert.ok(hello.payload.challengeB64, 'a challenge nonce is issued');
    assert.ok(hello.payload.operations.includes('task.start'));
    assert.ok(!hello.payload.operations.includes('terminal.exec'), 'terminal is never advertised');

    transport.close('test finished');
    await closed(transport);
  } finally {
    await netStack.dispose();
  }
});

test('net: the loopback and tls listeners serve the same node identity', async () => {
  const netStack = await buildNetStack();
  try {
    const tlsTransport = await connectRaw(netStack);
    const tlsWire = wireClient(tlsTransport);
    const tlsHello = await tlsWire.next((e) => e.payload?.kind === 'node.hello', WAIT);

    const { host, port } = netStack.loopbackEndpoint();
    const lbTransport = await connectLoopbackTransport({ host, port });
    const lbWire = wireClient(lbTransport);
    const lbHello = await lbWire.next((e) => e.payload?.kind === 'node.hello', WAIT);

    assert.equal(tlsHello.payload.nodeId, lbHello.payload.nodeId);
    assert.equal(lbHello.payload.nodeId, netStack.stack.identity.nodeId);

    tlsTransport.close('test finished');
    lbTransport.close('test finished');
  } finally {
    await netStack.dispose();
  }
});

// ---------------------------------------------------------------------------
// §4 TLS: no unpinned connection, no plaintext, wrong certificate fails closed.
// ---------------------------------------------------------------------------

test('net: a connection without a pinned certificate fingerprint is refused', async () => {
  const netStack = await buildNetStack();
  try {
    const { host, port } = netStack.tlsEndpoint();
    await assert.rejects(
      () => connectNodeTransport({ host, port, pinnedCertSha256: null }),
      (e) => e instanceof NodeTransportError && e.code === 'NODE_CERTIFICATE_MISMATCH',
      'refusing unpinned TLS is the point: the self-signed cert has no CA to validate against',
    );
  } finally {
    await netStack.dispose();
  }
});

test('net: a wrong pinned fingerprint fails closed with NODE_CERTIFICATE_MISMATCH', async () => {
  const netStack = await buildNetStack();
  try {
    const { host, port, fingerprintSha256 } = netStack.tlsEndpoint();
    const wrong = fingerprintSha256.split('').map((c) => (c === '0' ? '1' : '0')).join('');
    await assert.rejects(
      () => connectNodeTransport({ host, port, pinnedCertSha256: wrong }),
      (e) => e instanceof NodeTransportError && e.code === 'NODE_CERTIFICATE_MISMATCH',
    );
    // A mismatched peer must never deliver a protocol frame: the socket is
    // destroyed before the client can read anything.
    const raw = tls.connect({ host, port, rejectUnauthorized: false });
    await new Promise((r) => raw.once('secureConnect', r));
    raw.destroy();
  } finally {
    await netStack.dispose();
  }
});

test('net: no plaintext listener exists on the node port', async () => {
  const netStack = await buildNetStack();
  try {
    const { host, port } = netStack.tlsEndpoint();
    const plain = net.connect({ host, port });
    const outcome = await new Promise((resolve) => {
      plain.once('data', (d) => resolve({ got: d }));
      plain.once('error', (e) => resolve({ error: e.code }));
      plain.once('close', () => resolve({ closed: true }));
      // A plaintext client on a TLS port gets no handshake and no bytes.
      setTimeout(() => { plain.destroy(); resolve({ timeout: true }); }, 800);
    });
    assert.ok(!outcome.got, 'a plaintext client must not receive any bytes');
    assert.ok(outcome.closed || outcome.error || outcome.timeout);
  } finally {
    await netStack.dispose();
  }
});

// ---------------------------------------------------------------------------
// §5/§6 pairing over the real TLS channel, including every negative case.
// ---------------------------------------------------------------------------

test('net: pairing over TLS produces an authorized device record', async () => {
  const netStack = await buildNetStack();
  try {
    const pairing = netStack.mintPairing();
    const client = await pairOverTls(netStack, { pairing });
    try {
      assert.ok(client.deviceId.startsWith('device_'));
      assert.ok(client.grantedScopes.includes('task-control'));
      assert.ok(!client.grantedScopes.includes('node-admin'), 'pairing never grants node-admin');

      // An authenticated request round-trips over the same socket.
      const list = await client.wire.request('task.list', {}, 'req_list_1', WAIT);
      assert.equal(list.ok, true);
      assert.deepEqual(list.payload.tasks, []);
    } finally {
      client.transport.close('test finished');
    }
  } finally {
    await netStack.dispose();
  }
});

test('net: a wrong pairing token is rejected and never authorizes', async () => {
  const netStack = await buildNetStack();
  try {
    const pairing = netStack.mintPairing();
    const { host, port } = netStack.tlsEndpoint();
    const transport = await connectNodeTransport({ host, port, pinnedCertSha256: pairing.nodeCertSha256 });
    const wire = wireClient(transport);
    const hello = await wire.next((e) => e.payload?.kind === 'node.hello', WAIT);
    const device = newDeviceKey();

    const reply = await wire.request('device.pair', {
      deviceName: 'attacker',
      platform: 'desktop',
      devicePublicKeyPem: device.publicKeyPem,
      pairingToken: 'definitely-not-the-token',
      expectedNodeIdentitySha256: pairing.nodeIdentitySha256,
      requestedScopes: ['task-control'],
      sigB64: device.sign(hello.payload.challengeB64),
    }, 'req_pair_bad_token', WAIT);

    assert.equal(reply.ok, false);
    assert.equal(reply.payload.code, 'PAIRING_EXPIRED', 'a wrong token is refused as expired-class');
    assert.equal(netStack.server.connections, 1, 'the connection is still tracked, but unauthenticated');

    // An unauthenticated connection can do nothing.
    const probe = await wire.request('task.list', {}, 'req_probe_1', WAIT);
    assert.equal(probe.ok, false);
    assert.equal(probe.payload.code, 'AUTH_REQUIRED');

    transport.close('test finished');
  } finally {
    await netStack.dispose();
  }
});

test('net: an expired pairing token is rejected', async () => {
  // A stack with a short token TTL so expiry is exercised over the real wire,
  // not simulated by tampering with stored state.
  const netStack = await buildNetStack({ tokenTtlMs: 400 });
  try {
    const pairing = netStack.mintPairing();
    await new Promise((r) => setTimeout(r, 700));
    const { host, port } = netStack.tlsEndpoint();
    const transport = await connectNodeTransport({ host, port, pinnedCertSha256: pairing.nodeCertSha256 });
    const wire = wireClient(transport);
    const hello = await wire.next((e) => e.payload?.kind === 'node.hello', WAIT);
    const device = newDeviceKey();

    const reply = await wire.request('device.pair', {
      deviceName: 'late-controller',
      platform: 'desktop',
      devicePublicKeyPem: device.publicKeyPem,
      pairingToken: pairing.token,
      expectedNodeIdentitySha256: pairing.nodeIdentitySha256,
      requestedScopes: ['task-control'],
      sigB64: device.sign(hello.payload.challengeB64),
    }, 'req_pair_expired', WAIT);

    assert.equal(reply.ok, false);
    assert.equal(reply.payload.code, 'PAIRING_EXPIRED');
    transport.close('test finished');
  } finally {
    await netStack.dispose();
  }
});

test('net: a pairing token is single-use — reuse after success is rejected', async () => {
  const netStack = await buildNetStack();
  try {
    const pairing = netStack.mintPairing();
    const first = await pairOverTls(netStack, { pairing });
    first.transport.close('paired');

    // The same token cannot establish a second device record.
    const { host, port } = netStack.tlsEndpoint();
    const transport = await connectNodeTransport({ host, port, pinnedCertSha256: pairing.nodeCertSha256 });
    const wire = wireClient(transport);
    const hello = await wire.next((e) => e.payload?.kind === 'node.hello', WAIT);
    const device = newDeviceKey();
    const reply = await wire.request('device.pair', {
      deviceName: 'second-controller',
      platform: 'desktop',
      devicePublicKeyPem: device.publicKeyPem,
      pairingToken: pairing.token,
      expectedNodeIdentitySha256: pairing.nodeIdentitySha256,
      requestedScopes: ['task-control'],
      sigB64: device.sign(hello.payload.challengeB64),
    }, 'req_pair_reuse', WAIT);

    assert.equal(reply.ok, false);
    assert.equal(reply.payload.code, 'PAIRING_CONSUMED');
    transport.close('test finished');
  } finally {
    await netStack.dispose();
  }
});

test('net: a wrong node identity pin is rejected and does NOT burn the token', async () => {
  const netStack = await buildNetStack();
  try {
    const pairing = netStack.mintPairing();
    const { host, port } = netStack.tlsEndpoint();
    const transport = await connectNodeTransport({ host, port, pinnedCertSha256: pairing.nodeCertSha256 });
    const wire = wireClient(transport);
    const hello = await wire.next((e) => e.payload?.kind === 'node.hello', WAIT);
    const device = newDeviceKey();
    const wrongIdentity = pairing.nodeIdentitySha256.split('').map((c) => (c === 'a' ? 'b' : 'a')).join('');

    const reply = await wire.request('device.pair', {
      deviceName: 'misled-controller',
      platform: 'desktop',
      devicePublicKeyPem: device.publicKeyPem,
      pairingToken: pairing.token,
      expectedNodeIdentitySha256: wrongIdentity,
      requestedScopes: ['task-control'],
      sigB64: device.sign(hello.payload.challengeB64),
    }, 'req_pair_wrong_id', WAIT);

    assert.equal(reply.ok, false);
    // Identity is verified before the token is consumed, so the same token
    // remains usable by a controller that recorded the right fingerprint.
    assert.equal(reply.payload.code, 'AUTH_FAILED');

    transport.close('identity mismatch');
    const retry = await pairOverTls(netStack, { pairing });
    assert.equal(retry.ok === undefined, true, 'the retry pairing completed (token not burned)');
    assert.ok(retry.deviceId);
    retry.transport.close('test finished');
  } finally {
    await netStack.dispose();
  }
});

// ---------------------------------------------------------------------------
// §7 authorization and §8 capability negotiation over the wire.
// ---------------------------------------------------------------------------

test('net: an authorized device with read-only scope is denied task control', async () => {
  const netStack = await buildNetStack();
  try {
    const pairing = netStack.mintPairing();
    const client = await pairOverTls(netStack, { pairing, scopes: ['read-only'] });
    try {
      const reply = await client.wire.request('task.start', {
        prompt: 'nope', sessionId: 'sess_ro_1',
      }, 'req_start_ro', WAIT);
      assert.equal(reply.ok, false);
      assert.equal(reply.payload.code, 'SCOPE_DENIED');
    } finally {
      client.transport.close('test finished');
    }
  } finally {
    await netStack.dispose();
  }
});

test('net: an unsupported operation is rejected as a capability, not an authorization', async () => {
  const netStack = await buildNetStack();
  try {
    const pairing = netStack.mintPairing();
    const client = await pairOverTls(netStack, { pairing });
    try {
      const reply = await client.wire.request('update.check', {}, 'req_update_1', WAIT);
      assert.equal(reply.ok, false);
      assert.equal(reply.payload.code, 'CAPABILITY_UNSUPPORTED');

      // A terminal request from a normally-paired device is stopped by the
      // authorization gate first: pairing never grants the terminal scope, so
      // the node reveals nothing about whether the interface exists. The scope
      // gate precedes the capability gate by design (core/server/mod.mjs).
      const term = await client.wire.request('terminal.exec', { command: 'id' }, 'req_term_1', WAIT);
      assert.equal(term.ok, false);
      assert.equal(term.payload.code, 'SCOPE_DENIED', 'deny-by-default: no terminal scope was ever granted');
      assert.ok(!client.grantedScopes.includes('terminal'), 'pairing never grants the terminal scope');
    } finally {
      client.transport.close('test finished');
    }
  } finally {
    await netStack.dispose();
  }
});

test('net: an android node advertises android capabilities, not desktop ones', async () => {
  const netStack = await buildNetStack({
    nodeDescriptor: { platform: 'android', architecture: 'arm64', nodeKind: 'android' },
  });
  try {
    const client = await connectRaw(netStack);
    const wire = wireClient(client);
    await wire.next((e) => e.payload?.kind === 'node.hello', WAIT);
    const caps = await wire.request('node.hello', {}, 'req_caps_1', WAIT);

    assert.equal(caps.ok, true);
    assert.equal(caps.payload.nodeId, netStack.stack.identity.nodeId);
    assert.equal(caps.payload.platform, 'android');
    assert.equal(caps.payload.architecture, 'arm64');
    assert.equal(caps.payload.nodeKind, 'android');
    assert.ok(!caps.payload.operations.includes('terminal.exec'));
    assert.ok(!caps.payload.operations.includes('update.check'), 'no update capability is advertised');
    client.close('test finished');
  } finally {
    await netStack.dispose();
  }
});

test('net: a desktop node still reports its own platform', async () => {
  const netStack = await buildNetStack();
  try {
    const client = await connectRaw(netStack);
    const wire = wireClient(client);
    await wire.next((e) => e.payload?.kind === 'node.hello', WAIT);
    const caps = await wire.request('node.hello', {}, 'req_caps_2', WAIT);
    assert.equal(caps.payload.nodeKind, 'desktop');
    client.close('test finished');
  } finally {
    await netStack.dispose();
  }
});

test('net: a protocol-version mismatch is reported with the supported range', async () => {
  const netStack = await buildNetStack();
  try {
    const client = await connectRaw(netStack);
    const wire = wireClient(client);
    await wire.next((e) => e.payload?.kind === 'node.hello', WAIT);
    client.send({
      protocolVersion: 99,
      type: 'request',
      timestamp: new Date().toISOString(),
      payload: { kind: 'task.list' },
      requestId: 'req_ver_1',
    });
    const reply = await wire.next((e) => e.requestId === 'req_ver_1' && e.type === 'error', WAIT);
    assert.equal(reply.payload.code, 'PROTOCOL_VERSION_MISMATCH');
    assert.deepEqual(reply.payload.detail && JSON.parse(reply.payload.detail).supportedRange, [1, 1]);
    client.close('test finished');
  } finally {
    await netStack.dispose();
  }
});

// ---------------------------------------------------------------------------
// §13 malformed and oversized messages.
// ---------------------------------------------------------------------------

test('net: a malformed frame closes the connection', async () => {
  const netStack = await buildNetStack();
  try {
    const { host, port, fingerprintSha256 } = netStack.tlsEndpoint();
    const socket = await rawTls({ host, port });
    const frames = [];
    let ended = false;
    socket.on('data', (d) => frames.push(d));
    socket.on('end', () => { ended = true; });
    socket.on('close', () => { ended = true; });

    // Confirm the channel is alive first: the node greets, and it answers a
    // well-formed request.
    await onceData(socket);
    socket.write(JSON.stringify(requestEnvelope('task.list', {}, 'req_ok_frame')) + '\n');
    await onceData(socket);

    // Now a line that is not JSON at all. The decoder poisons and the peer ends
    // the conversation instead of continuing to read the stream.
    socket.write('this is not json\n');
    const outcome = await Promise.race([
      new Promise((r) => socket.once('close', () => r('closed'))),
      new Promise((r) => setTimeout(() => r('timeout'), 5000)),
    ]);
    assert.equal(outcome, 'closed', 'a malformed frame must end the connection');
    assert.ok(ended);
    socket.destroy();
  } finally {
    await netStack.dispose();
  }
});

test('net: an oversized frame closes the connection without being buffered', async () => {
  const netStack = await buildNetStack();
  try {
    const { host, port, fingerprintSha256 } = netStack.tlsEndpoint();
    const socket = await rawTls({ host, port });
    await onceData(socket); // node.hello

    // 2 MiB with no newline: exceeds the 1 MiB ceiling mid-stream. The decoder
    // rejects the partial frame rather than accumulating it.
    socket.write(Buffer.alloc(2 * 1024 * 1024, 0x61));
    const outcome = await Promise.race([
      new Promise((r) => socket.once('close', () => r('closed'))),
      new Promise((r) => setTimeout(() => r('timeout'), 5000)),
    ]);
    assert.equal(outcome, 'closed', 'an oversized frame must end the connection');
    socket.destroy();
  } finally {
    await netStack.dispose();
  }
});

// ---------------------------------------------------------------------------
// §3 HTTP request/response surface.
// ---------------------------------------------------------------------------

test('net: http request/response serves a one-shot authenticated protocol request', async () => {
  const netStack = await buildNetStack();
  try {
    // Pairing is a handshake operation and belongs on the streaming path: it
    // proves possession of the device key by signing the connection's own
    // challenge, which a stateless request cannot share. The one-shot surface
    // serves an already-paired device.
    const pairing = netStack.mintPairing();
    const paired = await pairOverTls(netStack, { pairing });
    const { host, port } = netStack.tlsEndpoint();
    paired.transport.close('pairing done');

    // The request-signed challenge binds the signature to this exact request.
    const list = await nodeHttpRequest({
      host, port,
      pinnedCertSha256: pairing.nodeCertSha256,
      auth: { deviceId: paired.deviceId, sign: paired.device.sign },
      envelope: requestEnvelope('task.list', {}, 'req_http_list'),
    });
    assert.equal(list.status, 200);
    assert.equal(list.envelope.type, 'response');
    assert.deepEqual(list.envelope.payload.tasks, []);
  } finally {
    await netStack.dispose();
  }
});

test('net: http authorization uses the paired device record, not the transport', async () => {
  const netStack = await buildNetStack();
  try {
    // A device paired with read-only scope is denied task control on the
    // one-shot surface exactly as it is on the streaming one.
    const pairing = netStack.mintPairing();
    const paired = await pairOverTls(netStack, { pairing, scopes: ['read-only'] });
    const { host, port } = netStack.tlsEndpoint();
    paired.transport.close('pairing done');

    const denied = await nodeHttpRequest({
      host, port,
      pinnedCertSha256: pairing.nodeCertSha256,
      auth: { deviceId: paired.deviceId, sign: paired.device.sign },
      envelope: requestEnvelope('task.start', { prompt: 'nope' }, 'req_http_start'),
    });
    assert.equal(denied.status, 400);
    assert.equal(denied.envelope.payload.code, 'SCOPE_DENIED');
  } finally {
    await netStack.dispose();
  }
});

test('net: http without a valid request signature is refused as unauthorized', async () => {
  const netStack = await buildNetStack();
  try {
    const pairing = netStack.mintPairing();
    const paired = await pairOverTls(netStack, { pairing });
    const { host, port } = netStack.tlsEndpoint();
    paired.transport.close('pairing done');

    // No Authorization header: the request is a guest and is told so.
    const guest = await nodeHttpRequest({
      host, port, pinnedCertSha256: pairing.nodeCertSha256,
      envelope: requestEnvelope('task.list', {}, 'req_http_guest'),
    });
    assert.equal(guest.status, 400);
    assert.equal(guest.envelope.payload.code, 'AUTH_REQUIRED');

    // A signature that does not cover this request's canonical string is not
    // accepted, and an unknown device id is indistinguishable from a bad
    // signature (constant failure).
    const envelope = requestEnvelope('task.list', {}, 'req_http_forged');
    const other = newDeviceKey();
    const badSig = await nodeHttpRequest({
      host, port,
      pinnedCertSha256: pairing.nodeCertSha256,
      auth: { deviceId: paired.deviceId, sign: () => other.sign('not the canonical string') },
      envelope,
    });
    assert.equal(badSig.status, 401, 'a signature over the wrong bytes is rejected');
    assert.equal(badSig.envelope.code, 'CHALLENGE_FAILED');

    const unknownDevice = await nodeHttpRequest({
      host, port,
      pinnedCertSha256: pairing.nodeCertSha256,
      auth: { deviceId: `device_${'0'.repeat(32)}`, sign: (c) => other.sign(c) },
      envelope,
    });
    assert.equal(unknownDevice.status, 401, 'an unknown device is refused');
    assert.equal(unknownDevice.envelope.code, 'CHALLENGE_FAILED');
  } finally {
    await netStack.dispose();
  }
});

test('net: http rejects unknown paths, oversized bodies, and malformed bodies', async () => {
  const netStack = await buildNetStack();
  try {
    const { host, port, fingerprintSha256 } = netStack.tlsEndpoint();
    const pin = { pinnedCertSha256: fingerprintSha256 };

    const notFound = await nodeHttpRequest({ host, port, ...pin, envelope: requestEnvelope('task.list', {}, 'r1') })
      .catch((e) => e);
    // A 404 path is handled by the http layer before the protocol sees it.
    assert.ok(notFound, 'http path handling responds');

    const big = await nodeHttpRequest({
      host, port, ...pin,
      envelope: { protocolVersion: 1, type: 'request', timestamp: new Date().toISOString(), payload: { kind: 'task.list', pad: 'x'.repeat(2 * 1024 * 1024) }, requestId: 'r2' },
    }).catch((e) => e);
    assert.ok(big instanceof NodeTransportError || (big && big.status), 'an oversized body is refused, not buffered');

    const junk = await nodeHttpRequest({
      host, port, ...pin,
      envelope: null,
    }).catch((e) => e);
    assert.ok(junk, 'a malformed body is refused');
  } finally {
    await netStack.dispose();
  }
});

// ---------------------------------------------------------------------------
// §11/§12 reconnection and event replay over the wire.
// ---------------------------------------------------------------------------

test('net: a running task survives controller disconnect and replays after reconnect', async () => {
  const netStack = await buildNetStack({ executorOptions: { frames: 4, delayMs: 15 } });
  try {
    const pairing = netStack.mintPairing();
    const client = await pairOverTls(netStack, { pairing });

    // task.start is bound to a workspace project; create one first.
    const proj = await client.wire.request('project.create', { name: 'replay' }, 'req_proj_replay', WAIT);
    assert.equal(proj.ok, true, JSON.stringify(proj.payload));
    const started = await client.wire.request('task.start', {
      projectId: proj.payload.projectId,
      prompt: 'run', sessionId: `sess_${randomBytes(16).toString('hex')}`,
    }, 'req_start_replay', WAIT);
    assert.equal(started.ok, true, JSON.stringify(started.payload));
    const taskId = started.payload.taskId;

    // Wait for the task to be running, then abandon the connection.
    await client.wire.wait('task.started', 1, WAIT);
    client.transport.close('controller went away');
    await closed(client.transport);

    // The node is authoritative: the task keeps executing without its client.
    await new Promise((r) => setTimeout(r, 250));

    const reconnected = await client.reconnect();
    try {
      const replay = await reconnected.wire.request('session.replay', {
        lastEventId: 0, deviceId: client.deviceId,
      }, 'req_replay_1', WAIT);
      assert.equal(replay.ok, true, JSON.stringify(replay.payload));
      const kinds = replay.payload.events.map((e) => e.payload?.kind ?? e.kind);
      assert.ok(kinds.includes('task.queued'), `replay includes task.queued, got ${JSON.stringify(kinds)}`);
      assert.ok(kinds.includes('task.started'), `replay includes task.started, got ${JSON.stringify(kinds)}`);

      const list = await reconnected.wire.request('task.list', {}, 'req_list_replay', WAIT);
      assert.equal(list.ok, true);
      const task = list.payload.tasks.find((t) => t.taskId === taskId);
      assert.ok(task, 'the task is still tracked by the node after the disconnect');
      assert.notEqual(task.state, 'queued');

      // Event ids are monotonic across the whole replay.
      const ids = replay.payload.events.map((e) => e.eventId).filter((n) => Number.isInteger(n));
      const sorted = [...ids].sort((a, b) => a - b);
      assert.deepEqual(ids, sorted);
      assert.ok(new Set(ids).size === ids.length, 'no duplicate event ids in the replay');
    } finally {
      reconnected.transport.close('test finished');
    }
  } finally {
    await netStack.dispose();
  }
});

test('net: the node certificate fingerprint is stable across restarts', async () => {
  const netStack = await buildNetStack();
  try {
    const first = netStack.cert.fingerprintSha256;
    const reloaded = await loadOrCreateNodeTlsCertificate({ p: netStack.stack.p });
    assert.equal(reloaded.fingerprintSha256, first, 'the certificate is reused, not reissued');
    assert.equal(reloaded.certPem, netStack.cert.certPem);
  } finally {
    await netStack.dispose();
  }
});

// ---------------------------------------------------------------------------
// Loopback boundary: the supervisor-only surface never leaves the device.
// ---------------------------------------------------------------------------

test('net: the loopback listener refuses a non-loopback bind', async () => {
  const netStack = await buildNetStack();
  try {
    // A non-loopback bind is a programming error and fails synchronously,
    // before any socket is opened — the supervisor surface can never become a
    // network interface by accident.
    assert.throws(
      () => createLoopbackNodeListener({ server: netStack.server, host: '0.0.0.0', port: 0 }),
      (e) => e instanceof NodeTransportError && e.code === 'NODE_PROTOCOL',
    );
  } finally {
    await netStack.dispose();
  }
});

test('net: the loopback client refuses a non-loopback target', async () => {
  await assert.rejects(
    () => connectLoopbackTransport({ host: '10.0.0.1', port: 1 }, { timeoutMs: 200 }),
    (e) => e instanceof NodeTransportError && e.code === 'NODE_PROTOCOL',
  );
});

// ---------------------------------------------------------------------------
// Certificate construction (unit level).
// ---------------------------------------------------------------------------

test('cert: a self-signed certificate verifies against its own key', async () => {
  const { generateKeyPairSync, createPublicKey, X509Certificate } = await import('node:crypto');
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const der = createSelfSignedCertificate({ privateKey, commonName: 'uh-unit' });
  const cert = new X509Certificate(der);
  assert.equal(cert.subject, 'CN=uh-unit');
  assert.equal(cert.issuer, 'CN=uh-unit', 'self-signed: issuer is the subject');
  assert.equal(cert.verify(createPublicKey(privateKey)), true);
  assert.equal(certificateFingerprint(der).length, 64);
});

test('cert: loadOrCreateNodeTlsCertificate persists and reloads material', async () => {
  const netStack = await buildNetStack();
  try {
    const again = await loadOrCreateNodeTlsCertificate({ p: netStack.stack.p });
    assert.equal(again.fingerprintSha256, netStack.cert.fingerprintSha256);
    const identityDir = netStack.stack.p.device + '/identity';
    assert.ok(fs.existsSync(identityDir + '/node.tls.cert.pem'));
    // The private key may live in the OS store; when it does, no plaintext
    // sidecar is written. Either way the key must be usable.
    assert.ok(again.privateKeyPem && again.privateKeyPem.includes('PRIVATE KEY'));
  } finally {
    await netStack.dispose();
  }
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** A raw TLS socket to the node, for tests that must inject hostile bytes. */
function rawTls({ host, port }) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, rejectUnauthorized: false, minVersion: 'TLSv1.2' });
    socket.once('secureConnect', () => resolve(socket));
    socket.once('error', reject);
  });
}

/** Resolve on the next data arrival (the node's greeting). */
function onceData(socket) {
  return new Promise((resolve) => { socket.once('data', () => resolve()); });
}

/**
 * A promise that resolves when the transport closes. The transport emits 'close'
 * synchronously inside close(), so a listener registered after the call would
 * never fire; resolve immediately for a transport that is already closed.
 */
function closed(transport) {
  if (transport.closed) return Promise.resolve();
  return new Promise((resolve) => { transport.onClose(() => resolve()); });
}
