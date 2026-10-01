// Shared Phase 2 test fixture: a temp Universal Harness root with a fully wired
// node stack (identity, auth, events, workspace) plus a paired memory client.
//
// Every suite that needs a server uses this so the object graph is built once,
// the same way the CLI builds it, and cleanup removes the temp tree.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';

import { portablePaths } from '../../core/paths/mod.mjs';
import { loadOrCreateNodeIdentity } from '../../core/identity/mod.mjs';
import { createAuthStore } from '../../core/auth/mod.mjs';
import { createEventStore } from '../../core/events/mod.mjs';
import { createWorkspaceStore } from '../../core/workspace/mod.mjs';
import { createWorkspaceApi } from '../../core/workspace-api/mod.mjs';
import { createNodeServer } from '../../core/server/mod.mjs';
import { createMemoryTransportPair } from '../../core/transport/mod.mjs';
import { createFakeExecutor } from './fake-executor.mjs';
import { wireClient } from './wire.mjs';

const SCOPES = ['read-only', 'project-session-control', 'task-control', 'file-modify'];

/** A temp root + the same collaborator set `uh serve` builds. */
export async function buildStack({ executorOptions = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uh-test-'));
  // The device-local tree is isolated under the temp root so parallel test
  // files never share — or pollute — the real OS device store.
  const p = { ...portablePaths(root), device: path.join(root, 'device-local') };
  for (const d of [p.data, p.state, p.sessions, p.projects, p.workspace]) {
    fs.mkdirSync(d, { recursive: true });
  }
  const identity = await loadOrCreateNodeIdentity({ p });
  const auth = createAuthStore({ p, identity });
  const events = createEventStore({ p });
  const store = createWorkspaceStore({ root, p });
  store.init({});
  const workspace = createWorkspaceApi({ root, p, store });
  const executorFactory = () => createFakeExecutor(executorOptions);
  return { root, p, identity, auth, events, store, workspace, executorFactory };
}

export function disposeStack({ root }) {
  fs.rmSync(root, { recursive: true, force: true });
}

/**
 * A paired in-process client + server over a memory transport pair, ready to
 * send authorized requests. `deviceKey` is the client's long-lived keypair.
 */
export async function buildPairedSession(stack, { scopes = SCOPES } = {}) {
  const server = createNodeServer({
    root: stack.root, p: stack.p,
    identity: stack.identity, auth: stack.auth, events: stack.events,
    workspace: stack.workspace, executorFactory: stack.executorFactory,
    uhVersion: '0.3.0',
  });
  const pairing = stack.auth.mintPairingPayload({ endpoint: 'memory://test' });
  const { client, node } = createMemoryTransportPair();
  const wire = wireClient(client);
  const id = server.handleConnection(node);

  const hello = await wire.next((e) => e.payload?.kind === 'node.hello');
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const devicePublicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  const sigB64 = sign(null, Buffer.from(hello.payload.challengeB64, 'utf8'), privateKey).toString('base64');

  const reply = await wire.request('device.pair', {
    deviceName: 'test-device',
    platform: 'desktop',
    devicePublicKeyPem,
    pairingToken: pairing.token,
    expectedNodeIdentitySha256: pairing.nodeIdentitySha256,
    requestedScopes: scopes,
    sigB64,
  }, 'req_pair');

  if (!reply.ok) throw new Error(`pairing failed in fixture: ${JSON.stringify(reply.payload)}`);
  return {
    server, client, wire, id,
    deviceId: reply.payload.deviceId,
    grantedScopes: reply.payload.grantedScopes,
    devicePrivateKey: privateKey,
    devicePublicKeyPem,
    /** A second connection for the same device (reconnect tests). */
    async reconnect() {
      const pair2 = createMemoryTransportPair();
      const wire2 = wireClient(pair2.client);
      server.handleConnection(pair2.node);
      const hello2 = await wire2.next((e) => e.payload?.kind === 'node.hello');
      const sig2 = sign(null, Buffer.from(hello2.payload.challengeB64, 'utf8'), privateKey).toString('base64');
      const authReply = await wire2.request('auth.connect', {
        deviceId: reply.payload.deviceId,
        sigB64: sig2,
      }, 'req_auth');
      if (!authReply.ok) throw new Error(`reconnect auth failed: ${JSON.stringify(authReply.payload)}`);
      return { client: pair2.client, wire: wire2 };
    },
  };
}

/** A client keypair for tests that need to sign challenges manually. */
export function newDeviceKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    privateKey,
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
    sign: (data) => sign(null, Buffer.from(data, 'utf8'), privateKey).toString('base64'),
  };
}

export { SCOPES };
