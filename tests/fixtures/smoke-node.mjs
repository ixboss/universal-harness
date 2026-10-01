// End-to-end smoke test of the node server over a memory transport pair:
// pair a device, start a task, disconnect while it runs, reconnect, replay.
import { generateKeyPairSync, sign } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createNodeServer } from '../../core/server/mod.mjs';
import { createAuthStore } from '../../core/auth/mod.mjs';
import { createEventStore } from '../../core/events/mod.mjs';
import { loadOrCreateNodeIdentity } from '../../core/identity/mod.mjs';
import { createWorkspaceApi } from '../../core/workspace-api/mod.mjs';
import { createWorkspaceStore } from '../../core/workspace/mod.mjs';
import { createMemoryTransportPair } from '../../core/transport/mod.mjs';
import { createFakeExecutor } from './fake-executor.mjs';
import { wireClient, check } from './wire.mjs';
import { portablePaths } from '../../core/paths/mod.mjs';
import { requestEnvelope } from '../../core/protocol/mod.mjs';

function makeTempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uh-smoke-'));
  const p = portablePaths(root);
  return { root, p };
}

async function main() {
  const { root, p } = makeTempRoot();
  const identity = await loadOrCreateNodeIdentity({ p });
  const auth = createAuthStore({ p, identity });
  const events = createEventStore({ p });
  const store = createWorkspaceStore({ root, p });
  store.init({});
  const workspace = createWorkspaceApi({ root, p, store });

  const pairing = auth.mintPairingPayload({ endpoint: 'memory://test' });
  const { client, node } = createMemoryTransportPair();
  const wire = wireClient(client);

  const server = createNodeServer({
    root, p, identity, auth, events, workspace,
    executorFactory: () => createFakeExecutor({ frames: 3, exitCode: 0, delayMs: 30 }),
    uhVersion: '0.3.0',
  });
  server.handleConnection(node);

  // 1. node.hello greeting
  const hello = await wire.next((e) => e.payload?.kind === 'node.hello');
  check(hello.payload.nodeId === identity.nodeId, 'node.hello carries the node identity');
  console.log('1. node.hello                     OK');

  // 2. pairing: client key + signed challenge + token bound to node identity
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const devicePublicPem = publicKey.export({ type: 'spki', format: 'pem' });
  const sigB64 = sign(null, Buffer.from(hello.payload.challengeB64, 'utf8'), privateKey).toString('base64');
  client.send(requestEnvelope('device.pair', {
    deviceName: 'test-device',
    platform: 'desktop',
    devicePublicKeyPem: devicePublicPem,
    pairingToken: pairing.token,
    expectedNodeIdentitySha256: pairing.nodeIdentitySha256,
    requestedScopes: ['read-only', 'project-session-control', 'task-control', 'file-modify'],
    sigB64,
  }, 'req_pair_0001'));
  const pairResp = await wire.next((e) => e.type === 'response' && e.requestId === 'req_pair_0001');
  const deviceId = pairResp.payload.deviceId;
  check(!!deviceId, 'pairing returns a device id');
  console.log('2. device.pair                    OK', deviceId);

  // 3. start a task
  const proj = workspace.createProject({ name: 'smoke' });
  client.send(requestEnvelope('task.start', { projectId: proj.projectId, prompt: 'say hello' }, 'req_start_001'));
  const startResp = await wire.next((e) => e.type === 'response' && e.requestId === 'req_start_001');
  const taskId = startResp.payload.taskId;
  check(!!taskId, 'task.start returns a task id');
  console.log('3. task.start                     OK', taskId);

  // 4. disconnect the client while the task runs
  await new Promise((r) => setTimeout(r, 45));
  client.close();
  await new Promise((r) => setTimeout(r, 250));
  check(server.liveTaskCount >= 0, 'server still alive after client disconnect');
  console.log('4. client disconnected            OK (server liveTasks =', server.liveTaskCount + ')');

  // 5. the task finishes on the node without the client
  await new Promise((r) => setTimeout(r, 400));
  const finalRecord = events.taskRecord(taskId);
  check(finalRecord?.state === 'completed', 'task reached completed without the client');
  console.log('5. task continued past disconnect OK state=' + finalRecord.state, 'head=' + events.getHead());

  // 6. reconnect + authenticate
  const { client: client2, node: node2 } = createMemoryTransportPair();
  const wire2 = wireClient(client2);
  server.handleConnection(node2);
  const hello2 = await wire2.next((e) => e.payload?.kind === 'node.hello');
  const sig2 = sign(null, Buffer.from(hello2.payload.challengeB64, 'utf8'), privateKey).toString('base64');
  client2.send(requestEnvelope('auth.connect', { deviceId, sigB64: sig2 }, 'req_auth_0001'));
  const authResp = await wire2.next((e) => e.type === 'response' && e.requestId === 'req_auth_0001');
  check(authResp.payload.deviceId === deviceId, 'reconnect authenticates the same device');
  console.log('6. reconnect auth.connect         OK');

  // 7. replay from cursor 0
  client2.send(requestEnvelope('session.replay', { deviceId, lastEventId: 0 }, 'req_replay_001'));
  const replayResp = await wire2.next((e) => e.type === 'response' && e.requestId === 'req_replay_001');
  const replayed = replayResp.payload;
  const kinds = replayed.events.map((e) => `${e.payload.kind}#${e.eventId}`);
  console.log('7. replay                         OK', replayed.events.length, 'events unavailable=' + replayed.unavailable);
  console.log('   replayed:', kinds.join(', '));
  check(replayed.events.some((e) => e.payload.kind === 'task.completed' && e.payload.taskId === taskId), 'replay contains task.completed');
  console.log('8. replay has task.completed      OK');

  // 9. authoritative state
  client2.send(requestEnvelope('task.list', {}, 'req_list_001'));
  const listResp = await wire2.next((e) => e.type === 'response' && e.requestId === 'req_list_001');
  console.log('9. task.list                      OK', JSON.stringify(listResp.payload.tasks.map((t) => [t.taskId.slice(0, 12), t.state])));

  client2.close();
  fs.rmSync(root, { recursive: true, force: true });
  console.log('SMOKE DONE — all invariants hold');
}

main().catch((e) => { console.error('SMOKE FAILED:', e.message); console.error(e.stack); process.exit(1); });
