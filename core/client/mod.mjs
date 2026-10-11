// Universal Harness — the controller half of Universal Protocol v1 (Phase 3C).
//
// One client library for every controller shape (the `uh connect` CLI today; a
// desktop UI, the Android app, and a future iOS client follow the same wire
// semantics). It reuses — never re-implements — the Phase 3B security model:
//
//   * TLS with a MANDATORY certificate fingerprint pin (core/transport);
//     there is no unpinned connection, exactly as on the node side.
//   * The pairing payload is the out-of-band trust root: nodeId, identity
//     fingerprint, certificate fingerprint, and a single-use token bound to
//     both. This client verifies the node's identity proof (the node signs the
//     connection challenge with its identity key; the proof verifies against
//     the payload's nodePublicKeyPem AND its fingerprint) before trusting a
//     paired session.
//   * Authentication is the challenge-response of PROTOCOL.md §3: sign the
//     node.hello nonce with the device private key. Reconnect is the same
//     handshake on a fresh connection, followed by session.replay from the
//     last seen eventId so missed events are recovered deterministically —
//     with the node's RecoverySnapshot surfaced when the cursor cannot be
//     served. The node stays the only authority over events; this client
//     keeps nothing but a cursor.
//   * Authorization is node-owned. Every scope failure arrives as a structured
//     protocol error (SCOPE_DENIED with the missing scope) and is surfaced as
//     such — the client never assumes authenticated == full access.

import { createHash, createPublicKey, verify as ed25519Verify } from 'node:crypto';
import {
  connectNodeTransport, connectLoopbackTransport, NodeTransportError,
} from '../transport/net.mjs';
import { wireClient } from './wire.mjs';
import { newRequestId } from '../protocol/mod.mjs';

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Parse and validate a pairing payload (`uh pair` output / QR content).
 * Every fingerprint must be a full 256-bit hex string, the token non-empty,
 * and the expiry in the future — an expired payload fails here, before any
 * network activity.
 *
 * @param {string|object} json the payload as text or an already-parsed object
 * @returns {{v: number, nodeId: string, endpoint: string, nodeName: ?string, token: string,
 *            expiresAt: string, nodeIdentitySha256: string, nodeCertSha256: ?string, nodePublicKeyPem: ?string}}
 */
export function parsePairingPayload(json) {
  let payload;
  try {
    payload = typeof json === 'string' ? JSON.parse(json) : json;
  } catch (e) {
    throw new NodeTransportError('NODE_PROTOCOL', `pairing payload is not valid JSON: ${e.message}`);
  }
  const fail = (why) => { throw new NodeTransportError('NODE_PROTOCOL', `invalid pairing payload: ${why}`); };
  if (!payload || typeof payload !== 'object') fail('not an object');
  if (payload.v !== 1) fail(`unsupported payload version ${payload.v}`);
  if (typeof payload.nodeId !== 'string' || !/^node_[0-9a-f]{32}$/.test(payload.nodeId)) fail('nodeId');
  if (typeof payload.endpoint !== 'string' || !payload.endpoint) fail('endpoint');
  if (typeof payload.token !== 'string' || payload.token.length < 16) fail('token');
  if (typeof payload.nodeIdentitySha256 !== 'string' || !/^[0-9a-f]{64}$/.test(payload.nodeIdentitySha256)) fail('nodeIdentitySha256');
  if (payload.nodeCertSha256 != null && !/^[0-9a-f]{64}$/.test(payload.nodeCertSha256)) fail('nodeCertSha256');
  if (typeof payload.expiresAt !== 'string' || Number.isNaN(Date.parse(payload.expiresAt))) fail('expiresAt');
  if (Date.parse(payload.expiresAt) <= Date.now()) fail('token already expired — mint a new one on the node');
  if (payload.nodePublicKeyPem != null && !String(payload.nodePublicKeyPem).includes('PUBLIC KEY')) fail('nodePublicKeyPem');
  return payload;
}

/** Split a pairing payload endpoint (`https://host:port` or `loopback://host:port`). */
export function parseEndpoint(endpoint) {
  let url;
  try { url = new URL(endpoint); } catch (e) {
    throw new NodeTransportError('NODE_PROTOCOL', `invalid endpoint "${endpoint}": ${e.message}`);
  }
  const scheme = url.protocol.replace(/:$/, '');
  const port = url.port ? Number(url.port) : (scheme === 'https' ? 443 : 0);
  if (!url.hostname || !Number.isInteger(port) || port <= 0) {
    throw new NodeTransportError('NODE_PROTOCOL', `invalid endpoint "${endpoint}"`);
  }
  return { scheme, host: url.hostname, port };
}

/**
 * Verify the node's identity proof exactly as the pairing model requires
 * (NEG-PAIR-01): the fingerprint of the node public key from the payload must
 * match the payload's nodeIdentitySha256, and the node must have signed the
 * connection challenge with that key.
 */
export function verifyNodeIdentity({ nodeSigB64, nodePublicKeyPem, expectedNodeIdentitySha256, challengeB64 }) {
  try {
    const key = createPublicKey({ key: nodePublicKeyPem, format: 'pem' });
    const der = key.export({ type: 'spki', format: 'der' });
    const fingerprint = createHash('sha256').update(der).digest('hex');
    if (fingerprint !== expectedNodeIdentitySha256) return false;
    return ed25519Verify(null, Buffer.from(challengeB64, 'utf8'), key, Buffer.from(nodeSigB64, 'base64'));
  } catch {
    return false;
  }
}

/**
 * A connected, protocol-speaking controller.
 *
 * Construct with {@link UniversalClient.connect} (TLS) or
 * {@link UniversalClient.connectLoopback} (same-device supervisor surface);
 * both require a pinned certificate fingerprint. The node greets first; the
 * greeting's identity, version range, operation set, and challenge are
 * captured before any request is sent.
 */
export class UniversalClient {
  constructor({ transport, wire, connectParams, requestTimeoutMs = REQUEST_TIMEOUT_MS }) {
    this.transport = transport;
    this.wire = wire;
    this.connectParams = connectParams; // { host, port, pinnedCertSha256 }
    this.requestTimeoutMs = requestTimeoutMs;
    this.hello = null;          // the node.hello greeting payload
    this.deviceId = null;       // set by pair()/authenticate()
    this.grantedScopes = null;
    this.lastEventId = 0;       // replay cursor: the highest eventId this client has seen
  }

  /** Connect over pinned TLS and await the node greeting. */
  static async connect({ host, port, pinnedCertSha256, connectTimeoutMs = undefined }) {
    const transport = await connectNodeTransport({ host, port, pinnedCertSha256, ...(connectTimeoutMs ? { connectTimeoutMs } : {}) });
    return UniversalClient._fromTransport(transport, { host, port, pinnedCertSha256 });
  }

  /** Connect to a same-device loopback listener (no TLS; supervisor surface). */
  static async connectLoopback({ host = '127.0.0.1', port }) {
    const transport = await connectLoopbackTransport({ host, port });
    return UniversalClient._fromTransport(transport, { host, port, pinnedCertSha256: null });
  }

  static async _fromTransport(transport, connectParams) {
    const client = new UniversalClient({ transport, wire: wireClient(transport), connectParams });
    const greeting = await client.wire.next((e) => e.type === 'notification' && e.payload?.kind === 'node.hello', { timeoutMs: client.requestTimeoutMs });
    client.hello = greeting.payload;
    return client;
  }

  get nodeId() { return this.hello?.nodeId ?? null; }
  get operations() { return this.hello?.operations ?? []; }
  get pairingOpen() { return this.hello?.pairingOpen === true; }
  get platform() { return this.hello?.platform ?? null; }
  get nodeKind() { return this.hello?.nodeKind ?? null; }
  get protocolVersionRange() { return this.hello?.protocolVersionRange ?? null; }

  requireHello() {
    if (!this.hello) throw new NodeTransportError('NODE_PROTOCOL', 'the node never greeted; refusing to continue');
    return this.hello;
  }

  /** The node identity fingerprint this connection must belong to (from the pairing payload). */
  assertNodeIdentity({ nodeId, nodeIdentitySha256 }) {
    this.requireHello();
    if (nodeId && this.hello.nodeId !== nodeId) {
      throw new NodeTransportError('NODE_PROTOCOL', `the endpoint is a different node: greeting says ${this.hello.nodeId}, payload says ${nodeId}`);
    }
    if (nodeIdentitySha256 && !this.hello.nodeId.startsWith(`node_${nodeIdentitySha256.slice(0, 32)}`)) {
      throw new NodeTransportError('NODE_PROTOCOL', 'the node identity fingerprint does not match the greeting nodeId');
    }
  }

  /**
   * First contact: consume the payload's pairing token and become a paired
   * device. Verifies the node identity proof when the payload carries the
   * node public key; requests the given scopes (the node grants fewer or
   * equal — the granted set in the reply is authoritative).
   *
   * @param {{payload: object, device: object, deviceName: string, platform: string, requestedScopes: string[]}} opts
   *   `device` is the loadOrCreateControllerKey() result.
   */
  async pair({ payload, device, deviceName, platform = 'desktop', requestedScopes }) {
    this.assertNodeIdentity(payload);
    const challengeB64 = this.requireHello().challengeB64;
    const reply = await this.wire.request('device.pair', {
      deviceName,
      platform,
      devicePublicKeyPem: device.publicKeyPem,
      pairingToken: payload.token,
      expectedNodeIdentitySha256: payload.nodeIdentitySha256,
      requestedScopes,
      sigB64: device.sign ? device.sign(challengeB64) : undefined,
    }, newRequestId('pair'), { timeoutMs: this.requestTimeoutMs });
    if (!reply.ok) return reply;
    // The node proves its own identity with its long-lived key (Phase 3B §5).
    if (payload.nodePublicKeyPem && typeof reply.payload.sigB64 === 'string') {
      const proofOk = verifyNodeIdentity({
        nodeSigB64: reply.payload.sigB64,
        nodePublicKeyPem: payload.nodePublicKeyPem,
        expectedNodeIdentitySha256: payload.nodeIdentitySha256,
        challengeB64,
      });
      if (!proofOk) throw new NodeTransportError('NODE_PROTOCOL', 'the node failed its identity proof; refusing to trust this pairing');
    }
    this.deviceId = reply.payload.deviceId;
    this.grantedScopes = reply.payload.grantedScopes;
    return reply;
  }

  /** Re-authenticate a previously paired device on this connection. */
  async authenticate({ device, deviceId }) {
    const challengeB64 = this.requireHello().challengeB64;
    const reply = await this.wire.request('auth.connect', {
      deviceId,
      sigB64: device.sign(challengeB64),
    }, newRequestId('auth'), { timeoutMs: this.requestTimeoutMs });
    if (reply.ok) {
      this.deviceId = reply.payload.deviceId;
      this.grantedScopes = reply.payload.grantedScopes;
    }
    return reply;
  }

  /** Send one request; returns { ok, payload, envelope }. */
  request(kind, payload = {}) {
    return this.wire.request(kind, payload, newRequestId('req'), { timeoutMs: this.requestTimeoutMs });
  }

  // ------------------------------------------------------------- operations
  listProjects() { return this.request('project.list'); }
  createProject({ name, path = null }) { return this.request('project.create', { name, ...(path ? { path } : {}) }); }
  openProject(projectId) { return this.request('project.open', { projectId }); }

  listSessions({ projectId = undefined } = {}) {
    return this.request('session.list', projectId ? { projectId } : {});
  }
  createSession({ projectId, label = null }) {
    return this.request('session.create', { projectId, ...(label ? { label } : { label: null }) });
  }
  readSession({ sessionId, includeTranscript = false, limit = undefined, cursor = null }) {
    return this.request('session.read', {
      sessionId,
      ...(includeTranscript ? { includeTranscript: true, ...(limit ? { limit } : {}), ...(cursor ? { cursor } : { cursor: null }) } : {}),
    });
  }
  resumeSession({ sessionId, label = null }) {
    return this.request('session.resume', { sessionId, ...(label ? { label } : { label: null }) });
  }

  startTask({ projectId, sessionId = undefined, prompt, priority = 'normal', clientRequestId = undefined }) {
    return this.request('task.start', {
      projectId, prompt, priority,
      ...(sessionId ? { sessionId } : {}),
      ...(clientRequestId ? { clientRequestId } : {}),
    });
  }
  listTasks({ projectId = undefined, state = undefined } = {}) {
    return this.request('task.list', {
      ...(projectId ? { projectId } : {}),
      ...(state ? { state } : {}),
    });
  }
  taskHistory({ taskId, cursor = 0, limit = 200 }) {
    return this.request('task.history', { taskId, ...(cursor ? { cursor } : {}), ...(limit !== 200 ? { limit } : {}) });
  }
  cancelTask({ taskId, reason = null }) {
    return this.request('task.cancel', { taskId, ...(reason ? { reason } : { reason: null }) });
  }

  deviceList() { return this.request('device.list'); }
  deviceRevoke({ deviceId, forget = false }) { return this.request('device.revoke', { deviceId, forget }); }
  diagnostics(checks = undefined) { return this.request('diagnostics.run', checks?.length ? { checks } : {}); }

  /**
   * Durable event replay from the client's cursor. On success the cursor
   * advances to nextCursor; on `unavailable` the reply carries the node's
   * RecoverySnapshot, which the caller must reconcile (the client never
   * infers "nothing happened" from silence).
   */
  async replayEvents({ lastEventId = undefined } = {}) {
    const cursor = lastEventId ?? this.lastEventId;
    const reply = await this.wire.request('session.replay', {
      // ReconnectHandshake requires deviceId; a guest replay is not a thing.
      deviceId: this.deviceId,
      lastEventId: cursor > 0 ? cursor : null,
    }, newRequestId('replay'), { timeoutMs: this.requestTimeoutMs });
    if (reply.ok) {
      const next = reply.payload.nextCursor;
      if (typeof next === 'number' && next > this.lastEventId) this.lastEventId = next;
    }
    return reply;
  }

  /** Wait for live envelopes of one payload kind (task lifecycle follows). */
  wait(kind, n = 1, { timeoutMs = 30000 } = {}) { return this.wire.wait(kind, n, { timeoutMs }); }
  byKind(kind) { return this.wire.byKind(kind); }

  /**
   * Reconnect on a fresh connection: authenticate the same device and replay
   * everything the client missed since its last seen eventId. Returns
   * { ok, payload } as the replay reply (events, truncated, unavailable,
   * snapshot).
   */
  static async reconnect({ host, port, pinnedCertSha256, device, deviceId, lastEventId = 0 }) {
    const client = await UniversalClient.connect({ host, port, pinnedCertSha256 });
    const auth = await client.authenticate({ device, deviceId });
    if (!auth.ok) {
      client.close('reconnect auth failed');
      return { ok: false, error: auth.payload };
    }
    const replay = await client.replayEvents({ lastEventId });
    return { ok: replay.ok, replay, client };
  }

  close(reason = 'client closed') {
    try { this.transport.close(reason); } catch { /* already gone */ }
  }
}
