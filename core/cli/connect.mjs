// Universal Harness CLI — `uh connect` (Phase 3C).
//
// The first real Universal Harness controller: a deterministic, scriptable CLI
// that drives any node — desktop or Android — through the SAME Universal
// Protocol v1 the test suites exercise. It is a thin shell over core/client:
// every security decision (pinning, identity verification, challenge-response,
// scope enforcement) is the client library's and the node's, not this file's.
//
// Controller state lives in the device-bound tree (devicePaths controller/<profile>/):
//   controller/<profile>/controller-key.private.pem|sealed blob — the device key
//   controller/<profile>/nodes.json                             — paired-node pins
// The portable tree is never touched (the same ownership split the node uses).

import fs from 'node:fs';
import {
  parsePairingPayload, parseEndpoint, UniversalClient,
} from '../../core/client/mod.mjs';
import { createControllerRegistry } from '../../core/client/registry.mjs';
import { loadOrCreateControllerKey } from '../../core/client/keys.mjs';
import { createSecureStorage } from '../../core/secrets/mod.mjs';
import { NodeTransportError } from '../../core/transport/net.mjs';

// The four auto-grantable scopes. node-admin and terminal are NEVER requested:
// the node refuses to auto-grant them and a controller must not try (brief §13).
const CONTROLLER_SCOPES = ['read-only', 'project-session-control', 'task-control', 'file-modify'];

const CONNECT_USAGE = `Usage: uh connect <subcommand> [args]

Controller subcommands (all accept --json for full output and --profile <name>
to use a second controller identity, e.g. to test multi-controller behavior):

  pair --payload-file <path> | --payload '<json>' [--name NAME]
                        pair with a node using a pairing payload minted by
                        \`uh pair\` (or the node's QR). Verifies the node
                        identity and certificate pins out of band, then stores
                        the node in this profile's registry.
  nodes                 list paired nodes (pins, scopes; no secrets).
  remove --node <id>    forget a paired node.
  status [--node <id>]  connect, authenticate, show node identity + capabilities.
  projects              list projects on the node.
  sessions list [--project <id>]
  sessions read --session <id> [--transcript]
  sessions create --project <id> [--label L]
  sessions resume --session <id> [--label L]
                        linked continuation: creates a NEW session whose
                        priorSessionId is the given one. The dsh conversation
                        is NOT reopened; the lineage metadata is the
                        continuation.
  tasks start --session <id> [--project <id>] --prompt "<text>"
                        [--client-request-id ID] [--follow-seconds N]
                        start work; with --follow-seconds, wait for a terminal
                        event (the node runs the task even if you disconnect).
  tasks list [--project <id>] | history --task <id> [--cursor N] [--limit N] | cancel --task <id>
  events [--cursor N]   replay durable events from a cursor (0 = from the start).
`;

function argValue(args, name) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
}
function hasFlag(args, name) { return args.includes(name); }

function print(result, { json }) {
  if (json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  else printHuman(result);
  return 0;
}

function printHuman(result) {
  if (result == null || typeof result !== 'object') { process.stdout.write(`${String(result)}\n`); return; }
  for (const line of humanLines(result, '')) process.stdout.write(line + '\n');
}

function humanLines(value, indent) {
  if (value == null) return [`${indent}-`];
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${indent}(none)`];
    return value.flatMap((v) => humanLines(v, indent + '  '));
  }
  if (typeof value === 'object') {
    const lines = [];
    for (const [k, v] of Object.entries(value)) {
      if (v == null || typeof v !== 'object') lines.push(`${indent}${k}: ${Array.isArray(v) ? v.join(',') : v}`);
      else if (Array.isArray(v) && v.every((x) => x == null || typeof x !== 'object')) lines.push(`${indent}${k}: ${v.join(', ')}`);
      else lines.push(`${indent}${k}:`, ...humanLines(v, indent + '  '));
    }
    return lines;
  }
  return [`${indent}${value}`];
}

function fail(err, { json }) {
  const payload = {
    error: err?.code || 'CONNECT_FAILED',
    message: err?.message || String(err),
    ...(err?.payload?.code ? { protocolCode: err.payload.code, detail: err.payload.message } : {}),
  };
  if (json) process.stderr.write(JSON.stringify(payload, null, 2) + '\n');
  else process.stderr.write(`uh connect: ${payload.error}: ${payload.message}${payload.protocolCode ? ` (node said: ${payload.protocolCode}: ${payload.detail || ''})` : ''}\n`);
  return 1;
}

/** Structured protocol error from a request reply. */
function requireOk(reply, what) {
  if (reply.ok) return reply.payload;
  const err = new Error(`${what} failed`);
  err.code = 'NODE_ERROR';
  err.payload = reply.payload;
  throw err;
}

/**
 * Open an authenticated client for a stored node: connect with the stored
 * pins, authenticate the profile's device key.
 */
async function openClient({ p, profile, nodeId }) {
  const registry = createControllerRegistry({ p, profile });
  const node = registry.resolve(nodeId);
  const device = await loadOrCreateControllerKey({ p, profile, secureStorage: createSecureStorage({ root: p.root, p }) });
  if (node.deviceId !== device.deviceId) {
    throw new Error(`the stored node ${node.nodeId} was paired with a different controller key (${node.deviceId}); re-pair or use the right profile`);
  }
  if (!node.nodeCertSha256) throw new Error(`the stored node ${node.nodeId} has no certificate pin; re-pair`);
  const client = await UniversalClient.connect({
    host: node.host, port: node.port, pinnedCertSha256: node.nodeCertSha256,
  });
  client.assertNodeIdentity({ nodeId: node.nodeId, nodeIdentitySha256: node.nodeIdentitySha256 });
  const auth = await client.authenticate({ device, deviceId: node.deviceId });
  if (!auth.ok) {
    client.close('auth failed');
    const err = new Error('authentication failed');
    err.code = 'NODE_ERROR';
    err.payload = auth.payload;
    throw err;
  }
  return { client, node, registry, device };
}

export async function cmdConnect(args, { root, p, log }) {
  if (!args.length || args.includes('--help') || args.includes('-h')) {
    process.stdout.write(CONNECT_USAGE);
    return args.length ? 0 : 2;
  }
  const json = hasFlag(args, '--json');
  const profile = argValue(args, '--profile') || 'default';
  const nodeId = argValue(args, '--node');
  const sub = args.find((a) => !a.startsWith('-'));
  const rest = args.slice(args.indexOf(sub) + 1);
  const opts = { json, profile, nodeId };

  try {
    switch (sub) {
      case 'pair': return await connectPair(rest, { p, log, ...opts });
      case 'nodes': {
        const registry = createControllerRegistry({ p, profile });
        const nodes = registry.list().map(({ nodeId, endpoint, name, deviceId, grantedScopes, pairedAt }) => ({ nodeId, endpoint, name, deviceId, grantedScopes, pairedAt }));
        return print({ profile, nodes }, opts);
      }
      case 'remove': {
        const registry = createControllerRegistry({ p, profile });
        const removed = registry.remove(nodeId || argValue(rest, '--node'));
        return print({ removed }, opts);
      }
      case 'status': {
        const { client, node } = await openClient({ p, profile, nodeId });
        try {
          return print({
            nodeId: client.nodeId,
            platform: client.platform,
            nodeKind: client.nodeKind,
            protocolVersionRange: client.protocolVersionRange,
            operations: client.operations,
            pairingOpen: client.pairingOpen,
            deviceId: client.deviceId,
            grantedScopes: client.grantedScopes,
            endpoint: node.endpoint,
          }, opts);
        } finally { client.close('status done'); }
      }
      case 'projects': {
        const { client } = await openClient({ p, profile, nodeId });
        try { return print({ projects: requireOk(await client.listProjects(), 'project.list').projects }, opts); }
        finally { client.close('projects done'); }
      }
      case 'sessions': return await connectSessions(rest, { p, nodeId, opts });
      case 'tasks': return await connectTasks(rest, { p, nodeId, opts });
      case 'events': {
        const cursor = Number(argValue(rest, '--cursor') || 0);
        const { client } = await openClient({ p, profile, nodeId });
        try {
          const reply = requireOk(await client.replayEvents({ lastEventId: cursor }), 'session.replay');
          return print({
            events: reply.events.map((e) => ({ eventId: e.eventId, kind: e.payload?.kind, taskId: e.payload?.taskId, sessionId: e.payload?.sessionId, state: e.payload?.state, timestamp: e.timestamp })),
            nextCursor: reply.nextCursor,
            truncated: reply.truncated,
            unavailable: reply.unavailable,
            snapshot: reply.snapshot,
          }, opts);
        } finally { client.close('events done'); }
      }
      default:
        process.stderr.write(`unknown subcommand: ${sub}\n\n${CONNECT_USAGE}`);
        return 2;
    }
  } catch (e) {
    if (e instanceof NodeTransportError || e?.code === 'NODE_ERROR' || e?.code === 'USAGE') return fail(e, opts);
    return fail(e, opts);
  }
}

async function connectPair(args, { p, log, json, profile }) {
  const payloadJson = argValue(args, '--payload');
  const payloadFile = argValue(args, '--payload-file');
  let raw;
  if (payloadFile) raw = fs.readFileSync(payloadFile, 'utf8');
  else if (payloadJson) raw = payloadJson;
  else if (hasFlag(args, '--payload-stdin')) raw = fs.readFileSync(0, 'utf8');
  else {
    process.stderr.write('usage: uh connect pair --payload-file <path> | --payload \'<json>\' | --payload-stdin\n');
    return 2;
  }

  const payload = parsePairingPayload(raw);
  const { scheme, host, port } = parseEndpoint(payload.endpoint);
  const device = await loadOrCreateControllerKey({ p, profile, secureStorage: createSecureStorage({ root: p.root, p }), log });
  // The transport follows the endpoint's scheme: TLS for the LAN surface
  // (pin mandatory), plain loopback for a same-device supervisor payload.
  const client = scheme === 'loopback'
    ? await UniversalClient.connectLoopback({ host, port })
    : await UniversalClient.connect({ host, port, pinnedCertSha256: payload.nodeCertSha256 });
  try {
    const reply = await client.pair({
      payload, device,
      deviceName: argValue(args, '--name') || 'uh-connect-cli',
      platform: 'desktop',
      requestedScopes: CONTROLLER_SCOPES,
    });
    if (!reply.ok) {
      const err = new Error('pairing failed');
      err.code = 'NODE_ERROR';
      err.payload = reply.payload;
      throw err;
    }
    const registry = createControllerRegistry({ p, profile });
    registry.upsert({
      nodeId: payload.nodeId,
      endpoint: payload.endpoint,
      host, port,
      nodeIdentitySha256: payload.nodeIdentitySha256,
      nodeCertSha256: payload.nodeCertSha256,
      deviceId: reply.payload.deviceId,
      name: payload.nodeName || null,
      grantedScopes: reply.payload.grantedScopes,
    });
    return print({
      nodeId: payload.nodeId,
      endpoint: payload.endpoint,
      deviceId: reply.payload.deviceId,
      grantedScopes: reply.payload.grantedScopes,
      rePaired: reply.payload.rePaired === true,
      profile,
    }, { json });
  } finally {
    client.close('pairing done');
  }
}

async function connectSessions(args, { p, nodeId, opts }) {
  const sub = args.find((a) => !a.startsWith('-')) || 'list';
  const rest = args.slice(args.indexOf(sub) + 1);
  const { client } = await openClient({ p, profile: opts.profile, nodeId: opts.nodeId });
  try {
    switch (sub) {
      case 'list': {
        const projectId = argValue(rest, '--project');
        const result = requireOk(await client.listSessions(projectId ? { projectId } : {}), 'session.list');
        return print({ sessions: result.sessions }, opts);
      }
      case 'read': {
        const sessionId = argValue(rest, '--session');
        const transcript = hasFlag(rest, '--transcript');
        const result = requireOk(await client.readSession({ sessionId, includeTranscript: transcript }), 'session.read');
        return print(result, opts);
      }
      case 'create': {
        const result = requireOk(await client.createSession({
          projectId: argValue(rest, '--project'),
          label: argValue(rest, '--label'),
        }), 'session.create');
        return print(result, opts);
      }
      case 'resume': {
        const result = requireOk(await client.resumeSession({
          sessionId: argValue(rest, '--session'),
          label: argValue(rest, '--label'),
        }), 'session.resume');
        return print({
          session: result.session,
          resumedFromSessionId: result.resumedFromSessionId,
          note: 'linked continuation: a new session whose priorSessionId is the prior session; the dsh conversation is not reopened',
        }, opts);
      }
      default:
        process.stderr.write(`unknown sessions subcommand: ${sub}\n`);
        return 2;
    }
  } finally { client.close('sessions done'); }
}

async function connectTasks(args, { p, nodeId, opts }) {
  const sub = args.find((a) => !a.startsWith('-')) || 'list';
  const rest = args.slice(args.indexOf(sub) + 1);
  const { client } = await openClient({ p, profile: opts.profile, nodeId: opts.nodeId });
  try {
    switch (sub) {
      case 'start': {
        const prompt = argValue(rest, '--prompt');
        if (!prompt) { process.stderr.write('usage: uh connect tasks start --session <id> [--project <id>] --prompt "<text>"\n'); return 2; }
        const sessionId = argValue(rest, '--session');
        const projectId = argValue(rest, '--project');
        const clientRequestId = argValue(rest, '--client-request-id');
        const followSeconds = Number(argValue(rest, '--follow-seconds') || 0);
        let result = requireOk(await client.startTask({
          projectId, sessionId, prompt,
          clientRequestId: clientRequestId || undefined,
        }), 'task.start');
        if (followSeconds > 0) {
          const deadline = Date.now() + followSeconds * 1000;
          while (Date.now() < deadline) {
            const terminal = client.byKind('task.completed')
              .concat(client.byKind('task.failed'), client.byKind('task.cancelled'))
              .find((e) => e.payload?.taskId === result.taskId);
            if (terminal) {
              result = { ...result, state: terminal.payload.state, reason: terminal.payload.reason ?? null };
              break;
            }
            await new Promise((r) => setTimeout(r, 150));
          }
          if (!result.state || result.state === 'queued') {
            // Not settled within the window — report the last observed state honestly.
            const hist = await client.taskHistory({ taskId: result.taskId, limit: 1 });
            const last = hist.ok && hist.payload.events.length ? hist.payload.events[hist.payload.events.length - 1] : null;
            result = { ...result, state: last?.payload?.state || result.state, reason: last?.payload?.reason ?? result.reason, settled: false };
          } else result.settled = true;
        }
        return print(result, opts);
      }
      case 'list': {
        const projectId = argValue(rest, '--project');
        const result = requireOk(await client.listTasks(projectId ? { projectId } : {}), 'task.list');
        return print({ tasks: result.tasks }, opts);
      }
      case 'history': {
        const result = requireOk(await client.taskHistory({
          taskId: argValue(rest, '--task'),
          cursor: Number(argValue(rest, '--cursor') || 0),
          limit: Number(argValue(rest, '--limit') || 200),
        }), 'task.history');
        return print(result, opts);
      }
      case 'cancel': {
        const result = requireOk(await client.cancelTask({
          taskId: argValue(rest, '--task'),
          reason: argValue(rest, '--reason'),
        }), 'task.cancel');
        return print(result, opts);
      }
      default:
        process.stderr.write(`unknown tasks subcommand: ${sub}\n`);
        return 2;
    }
  } finally { client.close('tasks done'); }
}
