// CLI modes that drive the real dsh execution chain: `uh exec`, `uh smoke`,
// and `uh runtime`. `uh smoke` is the Phase 1 hard gate (brief §18): every
// stage records an honest status with real timings — no stage is marked passed
// without having actually run on this machine.

import fs from 'node:fs';
import path from 'node:path';
import { createRuntimeManager } from '../runtime/mod.mjs';
import { createAdapter, newSessionId } from '../adapter/mod.mjs';
import { createSessionStore, createSessionIndex } from '../sessions/mod.mjs';
import { createShutdownManager } from '../shutdown/mod.mjs';
import { platformInfo } from '../platform/mod.mjs';
import { UhError, ERR } from '../errors/mod.mjs';
import os from 'node:os';

const SMOKE_CHECK_TIMEOUT = 120_000;

/**
 * One-shot: launch dsh, initialize, prompt, stream the turn to the console,
 * then shut down. Completion is detected from the turn/end event; a turn that
 * ends with an error reason is printed, not hidden.
 */
export async function cmdExec(args, { root, p, log }) {
  const prompt = args.find((a) => !a.startsWith('-'));
  if (!prompt) throw new UhError(ERR.UH_INTERNAL, '`uh exec` requires a prompt string', {},
    'Usage: uh exec "<your prompt>"');
  const rm = createRuntimeManager({ root });
  const shutdown = createShutdownManager({ log });

  const adapter = createAdapter({ rm, log });
  registerProcessExit(shutdown, adapter);

  await adapter.launch();
  await adapter.initialize({ cwd: root });
  const sessionId = newSessionId();
  const uhIndex = createSessionIndex({ p });
  uhIndex.record({ id: sessionId, status: 'open' });
  console.log(`# session ${sessionId}`);
  await adapter.prompt({ sessionId, text: prompt });

  const outcome = await streamTurnToConsole(adapter, { timeoutMs: 180_000 });
  const exit = await adapter.shutdown();
  console.log(`# turn ended: ${outcome.kind} | dsh exit: ${exit?.code}`);
  return outcome.kind === 'completed' ? 0 : 1;
}

/**
 * The full Phase 1 chain (brief §18). Every stage below is executed, timed,
 * and recorded — the report JSON lands in diagnostics/ and the console gets a
 * stage table plus a final PASS/FAIL line.
 */
export async function cmdSmoke(args, { root, p, log }) {
  const stages = [];
  const stage = async (id, label, fn) => {
    const t0 = Date.now();
    try { const note = await fn(); stages.push({ id, label, status: 'pass', ms: Date.now() - t0, note: note ?? null }); }
    catch (e) { stages.push({ id, label, status: 'fail', ms: Date.now() - t0, note: e?.message || String(e) }); }
  };

  const rm = createRuntimeManager({ root });
  const shutdown = createShutdownManager({ log });
  const report = { generatedAt: new Date().toISOString(), environment: platformInfo(), dshHome: process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), stages: [] };
  const config = readConfigOrDefault(root);

  // Stages 1-3: verify the runtime before launching anything.
  const installed = rm.dshInstalled();
  const nodeBin = rm.nodeBinary();
  const nodeEntry = rm.nodeEntry();
  await stage('01-bundled-node', 'bundled Node runtime present', async () => {
    if (!nodeBin) throw new Error('bundled node binary missing');
    return `${nodeEntry.version} at ${path.relative(root, nodeBin)}`;
  });
  await stage('02-verified-runtime', 'Node tree hash verified against install record', async () => {
    const v = rm.verifyNodeTree();
    if (!v.ok) throw new Error(`tree hash mismatch (recorded ${String(v.recorded).slice(0, 12)}, actual ${String(v.actual).slice(0, 12)})`);
    return `tree=${v.actual.slice(0, 16)}…`;
  });
  await stage('03-pinned-dsh', 'pinned @deepseek-ai/dsh installed', async () => {
    if (!installed || installed.version !== rm.manifest.dsh.version) {
      throw new Error(`expected ${rm.manifest.dsh.version}, got ${installed?.version || 'missing'}`);
    }
    return `${rm.manifest.dsh.package}@${installed.version} integrity recorded`;
  });

  // Stages 4-6: launch the SDK profile and initialize (this is where dsh's
  // native dependency tree loads).
  const adapter = createAdapter({ rm, log, cwd: root, ...config });
  registerProcessExit(shutdown, adapter);
  let initializeMs = 0;
  await stage('04-native-deps', 'dsh native dependencies load (process boots)', async () => {
    // Native module loading happens during boot + initialize; a failure here
    // surfaces as a start/init failure in the next stages, so we measure them
    // here for the report.
    const t = Date.now();
    await adapter.launch();
    const bootMs = Date.now() - t;
    return `process spawned in ${bootMs}ms`;
  });
  await stage('05-sdk-profile', 'dsh --profile sdk serving stdio JSON-RPC', async () => {
    const t = Date.now();
    const init = await adapter.initialize({ cwd: root });
    initializeMs = Date.now() - t;
    if (!init.serverInfo) throw new Error('no serverInfo in initialize response');
    return `${init.serverInfo.name} v${init.serverInfo.version} (${initializeMs}ms)`;
  });
  await stage('06-initialize', 'SDK initialize completed', async () => {
    if (!adapter.report().initialized) throw new Error('adapter not initialized');
    return `initialize round trip ${initializeMs}ms`;
  });

  // Stages 7-10: the turn.
  const sessionId = newSessionId();
  let eventCount = 0;
  adapter.on('event', () => { eventCount++; });
  await stage('07-session-open', 'session created/opened over the SDK', async () => {
    const res = await adapter.prompt({ sessionId, text: smokePrompt(), timeoutMs: SMOKE_CHECK_TIMEOUT });
    if (!res.messageId) throw new Error('no messageId returned');
    return `messageId=${res.messageId}`;
  });
  await stage('08-prompt', 'prompt accepted, turn streamed', async () => {
    if (eventCount === 0) throw new Error('no streaming events received');
    return `${eventCount} events by completion`;
  });
  const outcome = { kind: null, reason: null };
  await stage('09-streaming-events', 'streaming events observed live', async () => {
    if (eventCount < 1) throw new Error('no session.event notifications seen');
    return `${eventCount} session.event frames`;
  });
  await stage('10-completion', 'turn completed (turn/end received)', async () => {
    const result = await waitForTurnEnd(adapter, 180_000);
    outcome.kind = result.kind;
    outcome.reason = result.reason;
    if (result.kind !== 'completed') {
      throw new Error(`turn ended with reason ${result.kind}${result.reason ? ` (${result.reason})` : ''} — the chain executed, but this stage needs a funded provider credential to pass`);
    }
    return `turn/end reason=${result.reason || 'ok'}`;
  });

  // Stage 11: durable session persisted by dsh in $DSH_HOME.
  const dshHome = adapter.dshHome;
  const sessions = createSessionStore({ dshHome, log });
  await stage('11-durable-session', 'durable session persisted under $DSH_HOME', async () => {
    const list = sessions.list({ cwd: root });
    const found = list.find((s) => s.id === sessionId);
    if (!found) throw new Error(`no session log for ${sessionId} under ${dshHome}`);
    return `${found.logFile ? path.relative(dshHome, found.logFile) : 'session log'} (${found.eventCount} events)`;
  });

  // Stage 12: graceful shutdown.
  await stage('12-graceful-shutdown', 'graceful shutdown (exit 0)', async () => {
    const exit = await adapter.shutdown();
    if (exit?.code !== 0) throw new Error(`dsh exited code=${exit?.code} signal=${exit?.signal} (expected graceful exit 0)`);
    return 'exit 0';
  });

  // Stage 13-15: restart, reopen, replay.
  const adapter2 = createAdapter({ rm, log, cwd: root });
  await stage('13-restart', 'dsh restarted (fresh process)', async () => {
    await adapter2.launch();
    await adapter2.initialize({ cwd: root });
    return 'second runtime initialized';
  });
  // Reopen semantics: the SDK JSON-RPC seam has no resume method, so a
  // continuation runs under a new dsh session id linked to the prior one in
  // the UH index. Reopening must first prove the prior session survived.
  const uhIndex = createSessionIndex({ p });
  await stage('14-reopen-session', 'prior session reopened (durable read + linked continuation)', async () => {
    const prior = sessions.list({ cwd: root }).find((s) => s.id === sessionId);
    if (!prior) throw new Error(`prior session ${sessionId} not found in the durable store after restart`);
    if (prior.eventCount === 0) throw new Error('prior session persisted with no events');
    const continuationId = newSessionId();
    const res = await adapter2.prompt({ sessionId: continuationId, text: 'Continue: reply with exactly the word READY and nothing else.' });
    if (!res.messageId) throw new Error('continuation prompt rejected');
    uhIndex.record({ id: continuationId, priorSessionId: sessionId, status: 'open' });
    uhIndex.record({ id: sessionId, status: prior.incomplete ? 'incomplete' : 'closed' });
    return `prior ${sessionId} (${prior.eventCount} events) intact; continuation ${continuationId} linked`;
  });
  await stage('15-replay-recovery', 'prior session replayed from durable log', async () => {
    const events = sessions.replay(sessionId);
    if (events.length < eventCount) throw new Error(`replay returned ${events.length} events (saw ${eventCount} live)`);
    const seqs = events.map((e) => e.seq).filter((n) => typeof n === 'number');
    const sorted = [...seqs].sort((a, b) => a - b);
    if (JSON.stringify(seqs) !== JSON.stringify(sorted.slice(0, seqs.length))) throw new Error('replayed seq numbers are not monotonic');
    const header = sessions.list().find((s) => s.id === sessionId);
    return `${events.length} events replayed, seq ${seqs[0]}…${seqs[seqs.length - 1]}, format v${header?.formatVersion}`;
  });
  await adapter2.shutdown().catch(() => {});

  report.stages = stages;
  report.result = stages.every((s) => s.status === 'pass') ? 'PASS' : 'FAIL';
  report.outcome = outcome;

  const diagDir = p.diagnostics;
  fs.mkdirSync(diagDir, { recursive: true });
  const file = `smoke-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  fs.writeFileSync(path.join(diagDir, file), JSON.stringify(report, null, 2));

  for (const s of stages) {
    console.log(`  ${s.status === 'pass' ? 'PASS' : 'FAIL'}  ${s.pad ? '' : ''}${s.id} ${s.label} — ${s.ms}ms${s.note ? ` | ${String(s.note).slice(0, 140)}` : ''}`);
  }
  console.log(`\nRESULT: ${report.result} (${stages.filter((s) => s.status === 'fail').length} of ${stages.length} stages failed)`);
  console.log(`Report: ${path.join('diagnostics', file)}`);
  return report.result === 'PASS' ? 0 : 1;
}

/** `uh runtime status` — "which exact dsh + Node am I executing?" */
export async function cmdRuntime(args, { root, p, log }) {
  const rm = createRuntimeManager({ root });
  if (args[0] === 'targets') {
    for (const t of rm.supportedTargets()) {
      const e = rm.nodeEntry(t);
      console.log(`${t}\tnode ${e.version}\t${e.url.split('/').pop()}\t${e.sha256.slice(0, 16)}…`);
    }
    console.log(`dsh\t${rm.manifest.dsh.package}@${rm.manifest.dsh.version}\t${rm.manifest.dsh.integrity.slice(0, 21)}…`);
    return 0;
  }
  const status = await rm.status();
  for (const c of status.checks) {
    console.log(`${c.status === 'ok' ? 'OK  ' : 'FAIL'} ${c.id.padEnd(20)} ${c.label}${c.actual ? ` | ${c.actual}` : ''}`);
  }
  return status.ok ? 0 : 1;
}

// ---------------------------------------------------------------------------

/** Wait for the end of the current turn: session.status idle or turn/end. */
function waitForTurnEnd(adapter, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (kind, reason) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ kind, reason }); } };
    const offEvent = adapter.on('event', (payload) => {
      const type = payload?.event?.type;
      const data = payload?.event?.data || {};
      if (type === 'turn/end') {
        const kind = data?.reason?.kind || 'completed';
        if (kind === 'error') {
          const msg = data?.reason?.error?.message || data?.reason?.failure?.message || 'unknown error';
          finish('error', msg);
        } else {
          finish('completed', kind);
        }
      }
    });
    const offStatus = adapter.on('status', (payload) => {
      if (payload?.status === 'idle') finish(payload?.status === 'idle' ? 'completed' : payload.status, payload.status);
    });
    const timer = setTimeout(() => { offEvent(); offStatus(); finish('timeout', `${timeoutMs}ms without turn/end`); }, timeoutMs);
  });
}

/** Stream one turn to the console as compact, redacted lines. */
async function streamTurnToConsole(adapter, { timeoutMs }) {
  const printed = new Set();
  const result = await new Promise((resolve) => {
    let settled = false;
    const finish = (kind, reason) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ kind, reason }); } };
    const off = adapter.on('event', (payload) => {
      const type = payload?.event?.type;
      const data = payload?.event?.data || {};
      if (type === 'assistant/attempt' && Array.isArray(data.stream)) {
        for (const chunk of data.stream) {
          if (chunk?.chunk?.type === 'text' && chunk.chunk.text) process.stdout.write(chunk.chunk.text);
        }
      } else if (type === 'turn/end') {
        const kind = data?.reason?.kind || 'completed';
        finish(kind, kind === 'error' ? (data?.reason?.error?.message || data?.reason?.failure?.message || 'error') : kind);
      } else if (type && !printed.has(type) && type !== 'session') {
        printed.add(type);
        process.stdout.write(`  · ${type}\n`);
      }
    });
    const timer = setTimeout(() => { off(); finish('timeout', `${timeoutMs}ms`); }, timeoutMs);
  });
  process.stdout.write('\n');
  return result;
}

function readConfigOrDefault(root) {
  try {
    const cfgPath = path.join(root, 'data', 'config', 'config.json');
    if (!fs.existsSync(cfgPath)) return {};
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const a = cfg.adapter || {};
    return {
      timeouts: a.timeouts,
      ...(a.reasoningEffort ? { reasoningEffort: a.reasoningEffort } : {}),
      ...(a.maxTokens ? { maxTokens: a.maxTokens } : {}),
    };
  } catch { return {}; }
}

function smokePrompt() {
  return 'Reply with exactly the word READY and nothing else.';
}

function registerProcessExit(shutdown, adapter) {
  shutdown.installSignals({ adapter });
  process.on('beforeExit', () => shutdown.run({ adapter }).catch(() => {}));
}
