#!/usr/bin/env node
/**
 * Phase 3B host-side real-device verification (Gate E, controller half on the workstation).
 *
 * This is a hardware-in-the-loop script, NOT part of `npm test`: it drives a *physical device's*
 * node server over the real LAN from this workstation, using the repository's own controller
 * transport. It is the cross-device complement of UhGateEInstrumentedTest, which runs the same
 * matrix on the device itself.
 *
 * Prerequisites (in order):
 *   1. The debug APK is installed on the device and the runtime is installed (Gate D).
 *   2. `UhGateEInstrumentedTest` ran with `-e uhMintPayload true`, minting a pairing payload at
 *      files/uh-state/pairing-payload-host.json inside the app's private storage.
 *   3. This workstation and the device are on the same LAN.
 *
 * Usage:
 *   adb shell run-as com.jarves.mh cat files/uh-state/pairing-payload-host.json > payload.json
 *   node tests/manual/gate-e-host.mjs --payload payload.json
 *
 * The `run-as` pull of the payload IS the out-of-band channel: in production the operator scans
 * the payload off the device screen. Nothing here weakens the pin, the token check, the
 * challenge-response, or the scope gates — every denial printed below was produced by the node.
 */

import fs from 'node:fs';
import crypto from 'node:crypto';
import { connectNodeTransport, nodeHttpRequest, canonicalRequestString } from '../../core/transport/net.mjs';
import { wireClient } from '../fixtures/wire.mjs';

const args = process.argv.slice(2);
function arg(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}

const payloadPath = arg('--payload');
if (!payloadPath) {
  process.stderr.write('usage: node tests/manual/gate-e-host.mjs --payload <pairing-payload.json> [--host <ip>]\n');
  process.exit(2);
}
const payload = JSON.parse(fs.readFileSync(payloadPath, 'utf8'));
const host = arg('--host') || new URL(payload.endpoint).hostname;
const port = Number(new URL(payload.endpoint).port);
const WAIT = 15_000;

let step = 0;
const failures = [];
function evidence(line) {
  console.log(`UH-GATE-E-HOST ${String(++step).padStart(2, '0')}: ${line}`);
}
function check(cond, message) {
  if (cond) { evidence(`PASS: ${message}`); return true; }
  failures.push(message);
  evidence(`FAIL: ${message}`);
  return false;
}
function newDeviceKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    privateKey,
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
    sign: (data) => crypto.sign(null, Buffer.from(data, 'utf8'), privateKey).toString('base64'),
  };
}

// ---------------------------------------------------------------------------
// 1. TLS transport, pinned to the certificate the payload binds (over the LAN).
// ---------------------------------------------------------------------------
const transport = await connectNodeTransport({ host, port, pinnedCertSha256: payload.nodeCertSha256 });
evidence(`tls: connected to ${host}:${port} over the LAN; certificate pin matched ${payload.nodeCertSha256.slice(0, 16)}…`);
const wire = wireClient(transport);

// 2. Greeting: the node names itself and offers a challenge nonce.
const hello = await wire.next((e) => e.payload?.kind === 'node.hello', { timeoutMs: WAIT });
check(hello.payload.nodeId === payload.nodeId, `greeting nodeId matches the pairing payload (${payload.nodeId})`);
check(Boolean(hello.payload.challengeB64), 'greeting carries a single-use challenge nonce');
check(hello.payload.operations?.includes('task.start'), 'node advertises task.start');
evidence(`greeting: platform=${hello.payload.platform} nodeKind=${hello.payload.nodeKind} operations=${hello.payload.operations.length}`);

// 3. Secure pairing: consume the token, verify the node's identity proof.
const device = newDeviceKey();
const pairReply = await wire.request('device.pair', {
  deviceName: 'workstation-controller',
  platform: 'desktop',
  devicePublicKeyPem: device.publicKeyPem,
  pairingToken: payload.token,
  expectedNodeIdentitySha256: payload.nodeIdentitySha256,
  requestedScopes: ['read-only', 'project-session-control', 'task-control', 'file-modify'],
  sigB64: device.sign(hello.payload.challengeB64),
}, 'req_pair', { timeoutMs: WAIT });
check(pairReply.ok, `device.pair accepted the genuine token and returned a deviceId (${pairReply.payload?.deviceId})`);
const deviceId = pairReply.payload.deviceId;
const grantedScopes = pairReply.payload.grantedScopes || [];
evidence(`pairing: grantedScopes=${JSON.stringify(grantedScopes)}`);
check(!grantedScopes.includes('terminal') && !grantedScopes.includes('node-admin'),
  'terminal/node-admin scopes are never auto-granted from pairing');

const nodePem = payload.nodePublicKeyPem;
const nodeDer = crypto.createPublicKey(nodePem).export({ type: 'spki', format: 'der' });
const identityHash = crypto.createHash('sha256').update(nodeDer).digest('hex');
check(identityHash === payload.nodeIdentitySha256,
  'sha256(node public key DER) equals the payload-bound identity fingerprint');
const identityOk = crypto.verify(
  null, Buffer.from(hello.payload.challengeB64, 'utf8'),
  crypto.createPublicKey(nodePem), Buffer.from(pairReply.payload.sigB64, 'base64'),
);
check(identityOk, 'the node proved possession of the identity key (signature over the challenge)');

// 4. Deny-by-default on the same connection: no terminal scope, no terminal.exec.
const denied = await wire.request('terminal.exec', { sessionId: 'sess_host_deny', command: 'id' }, 'req_deny', { timeoutMs: WAIT });
check(!denied.ok && denied.payload.code === 'SCOPE_DENIED',
  `terminal.exec denied by the scope gate (code=${denied.payload?.code})`);

// 5. Authenticated protocol request.
const tasks = await wire.request('task.list', {}, 'req_tasks', { timeoutMs: WAIT });
check(tasks.ok, 'task.list succeeds for the authenticated device');

// 6. Task flow over the LAN, then controller disconnect; the node stays authoritative.
const proj = await wire.request('project.create', { name: 'host-verify' }, 'req_proj', { timeoutMs: WAIT });
check(proj.ok, `project.create ok (${proj.payload?.projectId})`);
const started = await wire.request('task.start', {
  projectId: proj.payload.projectId,
  prompt: 'host-side verification task',
  sessionId: `sess_${crypto.randomBytes(16).toString('hex')}`,
}, 'req_task', { timeoutMs: WAIT });
check(started.ok, `task.start ok (taskId=${started.payload?.taskId})`);
const queued = await wire.next((e) => e.type === 'event' && e.payload?.kind === 'task.queued', { timeoutMs: WAIT });
const running = await wire.next((e) => e.type === 'event' && e.payload?.kind === 'task.started', { timeoutMs: WAIT });
check(Boolean(queued && running), 'task.queued and task.started events arrive over the LAN');
evidence(`events: task.queued eventId=${queued?.eventId} task.started eventId=${running?.eventId}`);
transport.close('host verification: controller disconnects deliberately');
await new Promise((r) => setTimeout(r, 2_500));
evidence('disconnect: controller closed the TLS connection; node keeps running the task');

// 7. Reconnect + authenticate + durable replay.
const t2 = await connectNodeTransport({ host, port, pinnedCertSha256: payload.nodeCertSha256 });
const w2 = wireClient(t2);
const hello2 = await w2.next((e) => e.payload?.kind === 'node.hello', { timeoutMs: WAIT });
const authReply = await w2.request('auth.connect', {
  deviceId,
  sigB64: device.sign(hello2.payload.challengeB64),
}, 'req_auth', { timeoutMs: WAIT });
check(authReply.ok, 'reconnect: auth.connect authenticates the same deviceId over a fresh TLS connection');
const replay = await w2.request('session.replay', { lastEventId: 0, deviceId }, 'req_replay', { timeoutMs: WAIT });
const kinds = (replay.payload?.events || []).map((e) => e.payload?.kind ?? e.kind);
const eventIds = (replay.payload?.events || []).map((e) => e.eventId).filter(Number.isInteger);
check(replay.ok && kinds.includes('task.queued') && kinds.includes('task.started'),
  `durable replay includes task.queued + task.started (${kinds.filter((k) => k.startsWith('task.')).join(', ')})`);
check(eventIds.every((id, i) => i === 0 || id > eventIds[i - 1]), 'replay event ids are monotonic');
const list = await w2.request('task.list', {}, 'req_list', { timeoutMs: WAIT });
const tracked = (list.payload?.tasks || []).find((t) => t.taskId === started.payload.taskId);
check(Boolean(tracked) && tracked.state !== 'queued',
  `the node kept tracking the task without any controller (state=${tracked?.state})`);
t2.close('host verification: second connection closed');

// 8. One-shot HTTP path over the same TLS port (ALPN http/1.1), request-signed.
const envelope = {
  protocolVersion: 1, type: 'request', timestamp: new Date().toISOString(),
  requestId: 'req_http_host', payload: { kind: 'task.list' },
};
const http = await nodeHttpRequest({
  host, port, envelope, pinnedCertSha256: payload.nodeCertSha256,
  auth: { deviceId, sign: (canonical) => device.sign(canonical) },
}, { timeoutMs: WAIT });
check(http.status === 200 && http.envelope?.type === 'response',
  `one-shot HTTP request over the LAN succeeded (Authorization: UH signing, status=${http.status}, kind=${http.envelope?.payload?.kind})`);

// ---------------------------------------------------------------------------
console.log('UH-GATE-E-HOST ============================================');
if (failures.length > 0) {
  console.log(`UH-GATE-E-HOST RESULT: ${failures.length} FAILURE(S)`);
  for (const f of failures) console.log(`UH-GATE-E-HOST   - ${f}`);
  process.exit(1);
}
console.log(`UH-GATE-E-HOST RESULT: ALL ${step} CHECKS PASSED (device ${host}:${port})`);
