// Universal Harness CLI — `uh serve` and `uh pair` (Phase 2, extended in 3B).
//
// `uh serve` runs the node server speaking the Universal Protocol v1. Two
// surfaces, same server:
//   - default: the process's own stdin/stdout (the local/desktop transport);
//   - `--listen`: a network listener (Phase 3B). `tls://host:port` is the
//     single authenticated node endpoint; `loopback://host:port` is a
//     same-device-only plain socket for a supervisor such as the Android
//     foreground service. Either way the connection is handed to the same
//     node server through the same Transport contract — there is no second
//     protocol implementation.
//
// `uh pair` mints the short-lived pairing payload and prints it as JSON. Since
// Phase 3B the payload carries the node TLS certificate fingerprint, so a
// controller can pin the channel out of band before it authenticates. The
// identity fingerprint binding is what makes the token non-transferable.

import { createNodeServer } from '../../core/server/mod.mjs';
import { createAuthStore } from '../../core/auth/mod.mjs';
import { createEventStore } from '../../core/events/mod.mjs';
import { loadOrCreateNodeIdentity } from '../../core/identity/mod.mjs';
import { loadOrCreateNodeTlsCertificate } from '../../core/transport/cert.mjs';
import { createWorkspaceApi } from '../../core/workspace-api/mod.mjs';
import { createWorkspaceStore } from '../../core/workspace/mod.mjs';
import {
  createStreamTransport,
} from '../../core/transport/mod.mjs';
import { createNetworkNodeListener, createLoopbackNodeListener } from '../../core/transport/net.mjs';
import { createDshExecutor } from '../../core/executor/mod.mjs';
import { createRuntimeManager } from '../../core/runtime/mod.mjs';
import { createSecureStorage } from '../../core/secrets/mod.mjs';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { devicePaths } from '../paths/mod.mjs';

const SERVE_USAGE = `Usage: uh serve [--listen tls://host:port | loopback://host:port]
                 [--platform android] [--arch arm64] [--node-kind android]

Runs the Universal Harness node server speaking Universal Protocol v1
(newline-delimited JSON envelopes).

Without --listen the server speaks the protocol on this process's
stdin/stdout. That interface is complete on its own and is not reachable over
the network.

With --listen the node accepts connections from Universal Harness controllers:
  tls://host:port      the single authenticated endpoint. TLS is mandatory;
                       there is no plaintext listener. The node certificate is
                       self-signed and its fingerprint is what a paired
                       controller pins (see \`uh pair\`).
  loopback://host:port a plain socket bound to a loopback address only, for a
                       supervisor on this device. It refuses any other host.

A supervised node (the Android runtime) declares what it actually is with
--platform/--arch/--node-kind, or the UH_NODE_PLATFORM / UH_NODE_ARCH /
UH_NODE_KIND environment variables, because a process inside the guest cannot
detect the host.

Tasks started through the server outlive the client connection that created
them.`;

/**
 * Build the server's collaborators from a root. Exported so tests and a future
 * launcher construct the same object graph instead of a second one.
 */
export async function buildNodeStack({ root, p, log, runtimeManager, secureStorage }) {
  const identity = await loadOrCreateNodeIdentity({ p, secureStorage, log });
  const auth = createAuthStore({ p, log, identity });
  const events = createEventStore({ p, log });
  const store = createWorkspaceStore({ root, p, log });
  const workspace = createWorkspaceApi({ root, p, store, log });
  return { identity, auth, events, store, workspace };
}

export async function cmdServe(args, { root, p, log }) {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`${SERVE_USAGE}\n`);
    return 0;
  }

  const secureStorage = createSecureStorage({ root, p });
  const runtimeManager = createRuntimeManager({ root, p, log });
  const stack = await buildNodeStack({ root, p, log, runtimeManager, secureStorage });
  const nodeDescriptor = parseNodeDescriptor(args);

  const server = createNodeServer({
    root, p,
    identity: stack.identity,
    auth: stack.auth,
    events: stack.events,
    workspace: stack.workspace,
    executorFactory: () => createDshExecutor({
      rm: runtimeManager,
      log,
      dshHome: process.env.DSH_HOME || null,
      cwd: root,
      env: process.env,
    }),
    log,
    uhVersion: (await import('../../package.json', { with: { type: 'json' } }).catch(() => ({ default: { version: 'dev' } }))).default.version,
    runtimeManager,
    nodeDescriptor,
  });

  // Startup recovery runs before the first client can connect, so the state a
  // client reads on reconnect is already reconciled (brief §15).
  const recovery = server.recover();
  if (recovery.resolved) log.info(`startup recovery resolved ${recovery.resolved} interrupted task(s)`);

  const listenSpec = findListenSpec(args);
  if (listenSpec) return runListenMode({ server, stack, listenSpec, args, p, secureStorage, log });

  // ---- local stdio mode (unchanged since Phase 2) ----
  const transport = createStreamTransport({
    input: process.stdin,
    output: process.stdout,
    name: 'uh-serve:stdio',
  });

  const id = server.handleConnection(transport);
  log.info(`node server ready on stdio (connection ${id}, node ${stack.identity.nodeId})`, {
    nodeId: stack.identity.nodeId,
  });

  // Keep the process alive for the transport's benefit and exit cleanly when
  // the client disconnects or asks to shut down.
  await new Promise((resolve) => {
    transport.onClose((reason) => {
      log.info(`stdio transport closed (${String(reason).slice(0, 200)})`);
      resolve();
    });
  });

  log.info('node server shutting down');
  return 0;
}

function usageError(message) {
  const err = new Error(message);
  err.code = 'USAGE';
  return err;
}

function findListenSpec(args) {
  const i = args.indexOf('--listen');
  if (i < 0) return null;
  const value = args[i + 1];
  if (!value || value.startsWith('--')) {
    throw usageError('--listen requires a URL such as tls://0.0.0.0:7437 or loopback://127.0.0.1:7437');
  }
  return value;
}

function parseNodeDescriptor(args) {
  const descriptor = {};
  const flag = (name) => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
  };
  const platform = flag('--platform');
  const architecture = flag('--arch');
  const nodeKind = flag('--node-kind');
  if (platform) descriptor.platform = platform;
  if (architecture) descriptor.architecture = architecture;
  if (nodeKind) descriptor.nodeKind = nodeKind;
  return Object.keys(descriptor).length ? descriptor : null;
}

/**
 * Listen mode: the node's network surface. Exactly one listener is created and
 * every accepted connection is handed to the same node server. The process
 * stays alive until the listener is closed or the process is signaled.
 */
async function runListenMode({ server, stack, listenSpec, p, secureStorage, log }) {
  const url = parseListenUrl(listenSpec);
  const { certPem, privateKeyPem, fingerprintSha256 } = url.scheme === 'tls'
    ? await loadOrCreateNodeTlsCertificate({ p, secureStorage, log })
    : { certPem: null, privateKeyPem: null, fingerprintSha256: null };

  const listener = url.scheme === 'tls'
    ? await createNetworkNodeListener({ server, certPem, keyPem: privateKeyPem, host: url.host, port: url.port, log })
    : await createLoopbackNodeListener({ server, host: url.host, port: url.port, log });

  const addr = listener.address();
  const endpoint = `${url.scheme === 'tls' ? 'https' : 'loopback'}://${addr.address}:${addr.port}`;
  log.info(`node ${stack.identity.nodeId} listening on ${endpoint}`, {
    nodeId: stack.identity.nodeId,
    nodeFingerprint: stack.identity.fingerprint,
    ...(fingerprintSha256 ? { certFingerprint: fingerprintSha256 } : {}),
  });

  // Announce the bound endpoint where a same-device supervisor can read it. The
  // port may be ephemeral (port 0), so a supervisor cannot assume it; this file
  // is how the Android foreground service learns where the node is. It is
  // rewritten atomically and removed on a clean shutdown.
  const announcement = await announceEndpoint(p, {
    scheme: url.scheme,
    host: addr.address,
    port: addr.port,
    nodeId: stack.identity.nodeId,
    nodeFingerprint: stack.identity.fingerprint,
    certFingerprintSha256: fingerprintSha256,
  }).catch((e) => log.warn?.(`could not write the node endpoint announcement: ${e.message}`));

  await new Promise((resolve) => {
    let done = false;
    const finish = (signal) => {
      if (done) return;
      done = true;
      try { listener.close(signal); } catch {}
      if (announcement) fs.rmSync(announcement, { force: true });
      resolve();
    };
    process.on('SIGTERM', () => finish('SIGTERM'));
    process.on('SIGINT', () => finish('SIGINT'));
  });

  log.info('node server shutting down');
  return 0;
}

/**
 * Write the node's bound endpoint into the device-state directory, atomically.
 * A supervisor on the same device (the Android foreground service) polls this
 * to learn where the node is listening, because the bind may use an ephemeral
 * port. Returns the path written, or rejects when the directory is unusable.
 */
async function announceEndpoint(p, info) {
  const dir = devicePaths(p).identity;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'node-endpoint.json');
  const tmp = path.join(dir, 'node-endpoint.json.tmp');
  const payload = {
    v: 1,
    scheme: info.scheme,
    host: info.host,
    port: info.port,
    endpoint: `${info.scheme === 'tls' ? 'https' : 'loopback'}://${info.host}:${info.port}`,
    nodeId: info.nodeId,
    nodeIdentitySha256: info.nodeFingerprint,
    certSha256: info.certFingerprintSha256 || null,
    startedAt: new Date().toISOString(),
  };
  await fs.promises.writeFile(tmp, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  return file;
}

function parseListenUrl(spec) {
  let url;
  try { url = new URL(spec); } catch (e) {
    throw usageError(`--listen: ${e.message}`);
  }
  // WHATWG URL exposes `protocol` ("tls:"), not `scheme`.
  const scheme = url.protocol.replace(/:$/, '');
  if (scheme !== 'tls' && scheme !== 'loopback') {
    throw usageError(`--listen: unsupported scheme "${scheme}" (use tls:// or loopback://)`);
  }
  const host = url.hostname || (scheme === 'tls' ? '0.0.0.0' : '127.0.0.1');
  const port = url.port ? Number(url.port) : 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw usageError(`--listen: invalid port in ${spec}`);
  }
  return { scheme, host, port };
}

const PAIR_USAGE = `Usage: uh pair [--endpoint https://host:port]

Mints a single-use pairing payload binding a short-lived token to this node's
persistent identity fingerprint and TLS certificate fingerprint, and prints it
as JSON. A client verifies both out of band before trusting this node; the
token alone authorises nothing.

When --endpoint is omitted the payload targets the local stdio interface. With
--endpoint the payload names the node's TLS endpoint and carries the
certificate fingerprint a controller pins during pairing.

The payload is what a pairing UI encodes (QR/clipboard); the UI itself is not
implemented in this phase.`;

export async function cmdPair(args, { root, p, log }) {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`${PAIR_USAGE}\n`);
    return 0;
  }

  const secureStorage = createSecureStorage({ root, p });
  const { auth } = await buildNodeStack({ root, p, log, secureStorage });

  const endpointIndex = args.indexOf('--endpoint');
  const endpoint = endpointIndex >= 0 ? args[endpointIndex + 1] : null;
  if (endpointIndex >= 0 && (!endpoint || endpoint.startsWith('--'))) {
    process.stdout.write('usage: uh pair --endpoint https://host:port\n');
    return 2;
  }

  let nodeCertSha256 = null;
  if (endpoint) {
    // The TLS certificate must exist for the fingerprint to be meaningful; it
    // is issued here if the node has never listened.
    const cert = await loadOrCreateNodeTlsCertificate({ p, secureStorage, log });
    nodeCertSha256 = cert.fingerprintSha256;
  }

  const payload = auth.mintPairingPayload({
    endpoint: endpoint || 'stdio://localhost',
    nodeCertSha256,
    nodeName: os.hostname(),
  });

  // Print the payload to stdout for a caller to consume; the fingerprints are
  // safe to show, the private keys never are.
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  log.info('pairing payload minted', {
    nodeId: payload.nodeId,
    endpoint: payload.endpoint,
    expiresAt: payload.expiresAt,
    certFingerprint: nodeCertSha256 ? nodeCertSha256.slice(0, 16) + '…' : null,
  });
  return 0;
}
