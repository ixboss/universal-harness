// Universal Harness CLI — `uh serve` and `uh pair` (Phase 2).
//
// `uh serve` runs the node server speaking the Universal Protocol v1 on its own
// stdin/stdout. It is the local/desktop transport only (brief §4): no socket,
// no discovery, no TLS — the interface is complete without them.
//
// `uh pair` mints the short-lived pairing payload and prints it as JSON (a QR
// code UI is a Phase 3 concern; the payload is what a future UI encodes). The
// identity fingerprint binding is what makes the token non-transferable.

import { createNodeServer } from '../../core/server/mod.mjs';
import { createAuthStore } from '../../core/auth/mod.mjs';
import { createEventStore } from '../../core/events/mod.mjs';
import { loadOrCreateNodeIdentity } from '../../core/identity/mod.mjs';
import { createWorkspaceApi } from '../../core/workspace-api/mod.mjs';
import { createWorkspaceStore } from '../../core/workspace/mod.mjs';
import { createStreamTransport } from '../../core/transport/mod.mjs';
import { createDshExecutor } from '../../core/executor/mod.mjs';
import { createRuntimeManager } from '../../core/runtime/mod.mjs';
import { createSecureStorage } from '../../core/secrets/mod.mjs';
import os from 'node:os';

const SERVE_USAGE = `Usage: uh serve

Runs the Universal Harness node server on this process's stdin/stdout,
speaking Universal Protocol v1 (newline-delimited JSON envelopes).

The server is local-only: it does not open a socket and is not reachable
over the network. Tasks started through it outlive the client connection
that created them.`;

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
  });

  // Startup recovery runs before the first client can connect, so the state a
  // client reads on reconnect is already reconciled (brief §15).
  const recovery = server.recover();
  if (recovery.resolved) log.info(`startup recovery resolved ${recovery.resolved} interrupted task(s)`);

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

const PAIR_USAGE = `Usage: uh pair

Mints a single-use pairing payload binding a short-lived token to this node's
persistent identity fingerprint, and prints it as JSON. A client verifies the
binding out-of-band before trusting this node; the token alone authorises
nothing.

The payload is what a pairing UI encodes (QR/clipboard); the UI itself is not
implemented in this phase.`;

export async function cmdPair(args, { root, p, log }) {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`${PAIR_USAGE}\n`);
    return 0;
  }

  const secureStorage = createSecureStorage({ root, p });
  const { auth } = await buildNodeStack({ root, p, log, secureStorage });

  const payload = auth.mintPairingPayload({
    endpoint: 'stdio://localhost',
    nodeCertSha256: null, // no TLS transport in v1; the identity binding stands
    nodeName: os.hostname(),
  });

  // Print the payload to stdout for a caller to consume; the node identity
  // fingerprint is safe to show, the private key never is.
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  log.info('pairing payload minted', { nodeId: payload.nodeId, expiresAt: payload.expiresAt });
  return 0;
}
