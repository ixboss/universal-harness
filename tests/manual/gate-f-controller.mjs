// Phase 3C — Gate F: real controller → real node, over the real network.
//
// The workstation acts as TWO independent UniversalClient controllers (the
// exact library `uh connect` uses) against a live node — the physical Android
// device over Wi-Fi, or a desktop `uh serve --listen` process. Each controller
// pairs with its own single-use payload and its own device key/profile.
//
// A node holds ONE unconsumed pairing token at a time (pending-pairing.json is
// a single record), so the two pairings must interleave with token minting.
// The gate therefore runs in two phases sharing a state file:
//
//   node tests/manual/gate-f-controller.mjs phase-a <payload-1.json> --state <file> [--expect-kind android|desktop]
//   node tests/manual/gate-f-controller.mjs phase-b <payload-2.json> --state <file>
//
// Mint payload-1, run phase-a, mint payload-2, run phase-b. Evidence lines
// (UH-GATE-F) accumulate in <state>.evidence.txt across both phases.
//
// Provider-backed task completion is blocked by R-21 (unfunded credential):
// the task is expected to settle at the provider boundary (failed). That is
// the honest outcome and is recorded as such — the gate verifies the
// transport, pairing, sessions, task lifecycle, replay, and lineage.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { parsePairingPayload, UniversalClient } from '../../core/client/mod.mjs';
import { loadOrCreateControllerKey } from '../../core/client/keys.mjs';
import { createControllerRegistry } from '../../core/client/registry.mjs';
import { createSecureStorage } from '../../core/secrets/mod.mjs';

const SCOPES = ['read-only', 'project-session-control', 'task-control', 'file-modify'];
const evidenceLines = [];

function evidence(line) {
  const stamped = `[UH-GATE-F] ${new Date().toISOString()} ${line}`;
  evidenceLines.push(stamped);
  console.log(stamped);
}

function ok(cond, message) {
  evidence(`${cond ? 'PASS' : 'FAIL'}: ${message}`);
  if (!cond) process.exitCode = 1;
  return cond;
}

function argValue(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
}

function parseEndpointSafe(endpoint) {
  const url = new URL(endpoint);
  return { scheme: url.protocol.replace(/:$/, ''), host: url.hostname, port: Number(url.port) };
}

/** A controller with its own key + registry profile, paired from a payload file. */
async function makeController(root, p, profile, payloadFile) {
  const payload = parsePairingPayload(fs.readFileSync(payloadFile, 'utf8'));
  const { scheme, host, port } = parseEndpointSafe(payload.endpoint);
  if (scheme !== 'https') throw new Error(`unexpected endpoint scheme: ${scheme}`);
  const secureStorage = createSecureStorage({ root, p });
  const device = await loadOrCreateControllerKey({ p, profile, secureStorage });
  const client = await UniversalClient.connect({ host, port, pinnedCertSha256: payload.nodeCertSha256 });
  const reply = await client.pair({
    payload, device, deviceName: `gate-f-${profile}`, platform: 'desktop', requestedScopes: SCOPES,
  });
  if (!reply.ok) {
    client.close('pairing failed');
    throw new Error(`pairing failed for ${profile}: ${JSON.stringify(reply.payload)}`);
  }
  const registry = createControllerRegistry({ p, profile });
  registry.upsert({
    nodeId: payload.nodeId, endpoint: payload.endpoint, host, port,
    nodeIdentitySha256: payload.nodeIdentitySha256, nodeCertSha256: payload.nodeCertSha256,
    deviceId: reply.payload.deviceId, name: payload.nodeName, grantedScopes: reply.payload.grantedScopes,
  });
  return { client, device, payload, profile, host, port };
}

async function phaseA(argv) {
  const payloadPath = argv[0];
  const statePath = argValue(argv, '--state');
  const expectKind = argValue(argv, '--expect-kind');
  if (!payloadPath || !statePath) {
    console.error('usage: gate-f-controller.mjs phase-a <payload-1.json> --state <file> [--expect-kind android|desktop]');
    process.exit(2);
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uh-gate-f-'));
  const p = { device: path.join(root, 'device-local') };

  evidence(`gate F phase A start: payload=${payloadPath}${expectKind ? ', expect-kind=' + expectKind : ''}`);

  const a = await makeController(root, p, 'gatef-a', payloadPath);
  evidence(`A: paired as ${a.client.deviceId} scopes=[${a.client.grantedScopes.join(',')}] nodeId=${a.client.nodeId}`);
  ok(a.client.operations.includes('session.create'), 'A: the node advertises session.create');
  if (expectKind) ok(a.client.nodeKind === expectKind, `A: the node reports nodeKind=${expectKind} (got ${a.client.nodeKind})`);

  const proj = await a.client.createProject({ name: `gate-f-${Date.now()}` });
  ok(proj.ok, 'A: project.create over the network');
  const projectId = proj.payload.projectId;

  const created = await a.client.createSession({ projectId, label: 'gate-f session' });
  ok(created.ok, 'A: session.create over the network');
  const sessionId = created.payload.session.sessionId;
  ok(created.payload.session.dshAvailable === false, 'A: fresh session honestly reports dshAvailable=false');
  const read = await a.client.readSession({ sessionId });
  ok(read.ok && read.payload.dsh.available === false, 'A: session.read separates UH metadata from dsh store state');
  evidence(`A: session.list returned ${(await a.client.listSessions({ projectId })).payload.sessions.length} session(s)`);

  // Task lifecycle with idempotent submission.
  const clientRequestId = `gatef-${Date.now()}`.slice(0, 32).replace(/[^A-Za-z0-9_-]/g, '-').padEnd(12, '0');
  const started = await a.client.startTask({
    projectId, sessionId, prompt: 'Gate F controller task', clientRequestId,
  });
  ok(started.ok, `A: task.start over the network (${JSON.stringify(started.payload || {})})`);
  const taskId = started.payload.taskId;
  const retry = await a.client.startTask({
    projectId, sessionId, prompt: 'Gate F controller task', clientRequestId,
  });
  ok(retry.ok && retry.payload.taskId === taskId && retry.payload.idempotentReplay === true,
    'A: identical retry with the same clientRequestId returns the SAME task (idempotentReplay)');
  const clash = await a.client.startTask({
    projectId, sessionId, prompt: 'a DIFFERENT prompt', clientRequestId,
  });
  ok(!clash.ok && clash.payload.code === 'CONFLICT', 'A: same clientRequestId with a materially different request is CONFLICT');

  const terminalKinds = ['task.completed', 'task.failed', 'task.cancelled'];
  const sawQueued = a.client.wire.byKind('task.queued').some((e) => e.payload.taskId === taskId);
  ok(sawQueued, 'A: task.queued event received live');
  const terminal = await Promise.race([
    a.client.wire.next((e) => e.type === 'event' && terminalKinds.includes(e.payload?.kind) && e.payload.taskId === taskId, { timeoutMs: 90_000 })
      .then((e) => e.payload).catch(() => null),
    new Promise((r) => setTimeout(() => r(null), 90_000)),
  ]);
  if (terminal) {
    evidence(`A: task settled durably: ${terminal.kind} reason=${JSON.stringify(terminal.reason ?? null)} (R-21 provider boundary expected for a real dsh)`);
  } else {
    evidence('A: task not settled within 90s — recorded honestly; lifecycle events still verified');
  }

  a.client.close('gate F: controller A disconnects');
  evidence('A: disconnected deliberately');

  // Reconnect: auth + replay + paginated history.
  const a2 = await UniversalClient.connect({ host: a.host, port: a.port, pinnedCertSha256: a.payload.nodeCertSha256 });
  const auth = await a2.authenticate({ device: a.device, deviceId: a.client.deviceId });
  ok(auth.ok, `A: reconnected and authenticated (${JSON.stringify(auth.payload || {})})`);
  const replay = await a2.replayEvents({ lastEventId: 0 });
  ok(replay.ok && replay.payload.unavailable === false, 'A: full event replay after reconnect');
  const replayIds = replay.payload.events.map((e) => e.eventId);
  ok(replayIds.length >= 4, `A: replay returned ${replayIds.length} durable events`);
  ok(new Set(replayIds).size === replayIds.length, 'A: replay eventIds are unique');

  const histPage1 = await a2.taskHistory({ taskId, limit: 2 });
  ok(histPage1.ok && histPage1.payload.events.length <= 2, 'A: task.history page 1 bounded');
  let cursor = histPage1.payload.nextCursor;
  const allHist = histPage1.payload.events.map((e) => e.eventId);
  for (let i = 0; i < 50 && histPage1.payload.truncated; i++) {
    const page = await a2.taskHistory({ taskId, cursor, limit: 2 });
    allHist.push(...page.payload.events.map((e) => e.eventId));
    if (!page.payload.truncated) break;
    cursor = page.payload.nextCursor;
  }
  ok(new Set(allHist).size === allHist.length, 'A: paginated history has no duplicate events');
  // A settled task has >= 4 durable events (queued, starting, running, terminal);
  // a task still in flight has >= 3 — both prove the pagination walk.
  ok(allHist.length >= 3, `A: full paginated history assembled (${allHist.length} events)`);
  ok(allHist.every((id) => replayIds.includes(id)), 'A: task history is a subset of the durable replay');

  // Linked continuation.
  const resumed = await a2.resumeSession({ sessionId, label: 'gate-f continuation' });
  ok(resumed.ok && resumed.payload.resumedFromSessionId === sessionId, 'A: session.resume returns the linked continuation');
  ok(resumed.payload.session.priorSessionId === sessionId, 'A: the continuation session carries priorSessionId');
  const contRead = await a2.readSession({ sessionId: resumed.payload.session.sessionId });
  ok(contRead.ok && contRead.payload.session.priorSessionId === sessionId, 'A: lineage readable via session.read');
  const contTask = await a2.startTask({
    projectId, sessionId: resumed.payload.session.sessionId, prompt: 'continue on the continuation session',
    clientRequestId: `${clientRequestId}-c`,
  });
  ok(contTask.ok && contTask.payload.sessionId === resumed.payload.session.sessionId,
    'A: task against the continuation runs under the NEW session id (dsh conversation not reopened)');
  a2.close('gate F: controller A reconnect done');

  const state = {
    root, p, host: a.host, port: a.port, pinnedCertSha256: a.payload.nodeCertSha256,
    nodeId: a.client.nodeId, deviceIdA: a.client.deviceId,
    projectId, taskId, sessionId, clientRequestId, replayIds, allHist,
  };
  saveState(statePath, state);
  writeEvidence(statePath);
}

async function phaseB(argv) {
  const payloadPath = argv[0];
  const statePath = argValue(argv, '--state');
  if (!payloadPath || !statePath || !fs.existsSync(statePath)) {
    console.error('usage: gate-f-controller.mjs phase-b <payload-2.json> --state <file-from-phase-a>');
    process.exit(2);
  }
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const root = state.root;
  const p = { device: path.join(root, 'device-local') };

  evidence('gate F phase B start: second controller');
  const b = await makeController(root, p, 'gatef-b', payloadPath);
  evidence(`B: paired independently as ${b.client.deviceId} (different device key)`);
  ok(b.client.deviceId !== state.deviceIdA, 'B: controller B has its own deviceId');
  ok(!b.client.grantedScopes.includes('node-admin') && !b.client.grantedScopes.includes('terminal'),
    'B: elevated scopes were never granted');
  const bReplay = await b.client.replayEvents({ lastEventId: 0 });
  ok(bReplay.ok, 'B: replays the same durable event log from the start');
  const bIds = bReplay.payload.events.map((e) => e.eventId);
  ok(state.taskId && bIds.length >= state.replayIds.length,
    `B: the replay carries everything A saw (${bIds.length} events vs A's ${state.replayIds.length})`);
  const bHist = await b.client.taskHistory({ taskId: state.taskId });
  ok(bHist.ok && bHist.payload.events.length >= 3, 'B: inspects the SAME task started by A');
  // The same clientRequestId under B's device identity must never collide with
  // A's task: the idempotency key is scoped to the authenticated device.
  const bSameId = await b.client.startTask({
    projectId: state.projectId, sessionId: state.sessionId,
    prompt: 'Gate F controller task', clientRequestId: state.clientRequestId,
  });
  ok(bSameId.ok && bSameId.payload.taskId !== state.taskId,
    'B: the same clientRequestId under B device created its own task (device-scoped idempotency)');
  if (bSameId.ok) evidence(`B: same id created its own task ${bSameId.payload.taskId} (expected, device-scoped)`);
  b.client.close('gate F: controller B done');
  writeEvidence(statePath);
}

function saveState(statePath, state) {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
}

function writeEvidence(statePath) {
  const out = `${statePath}.evidence.txt`;
  fs.appendFileSync(out, evidenceLines.join('\n') + '\n');
  console.log(`\nGate F evidence appended to ${out}`);
  if (process.exitCode) process.exit(process.exitCode);
}

async function main() {
  const [phase, payloadPath, ...rest] = process.argv.slice(2);
  if (phase === 'phase-a') return phaseA([payloadPath, ...rest]);
  if (phase === 'phase-b') return phaseB([payloadPath, ...rest]);
  console.error('usage: node tests/manual/gate-f-controller.mjs phase-a <payload-1.json> --state <file> [--expect-kind android|desktop]\n' +
    '       node tests/manual/gate-f-controller.mjs phase-b <payload-2.json> --state <file>');
  process.exit(2);
}

main().catch((e) => {
  evidence(`gate F aborted: ${e?.stack || e}`);
  process.exit(1);
});
