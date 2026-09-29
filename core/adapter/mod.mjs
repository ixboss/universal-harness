// DesktopExecutionAdapter — Universal Harness's only seam to DeepSeek Harness.
//
// Speaks the real `dsh --profile sdk` stdio protocol (verified against the
// installed 0.2.0-rc.2 source; see docs/AUDIT.md):
//
//   requests (us -> dsh)   initialize | session/prompt | shutdown
//   notifications (dsh -> us)  session.event {sessionId, event}
//                              session.status {sessionId, status}
//                              subagent.started / subagent.finished
//
// The wire is newline-delimited JSON-RPC 2.0. dsh's stdout is reserved for
// protocol frames, so this adapter never writes to the child's stdout and
// treats every stdout line as a frame. dsh is spawned unmodified and owned by
// this process: startup/init/prompt timeouts, bounded graceful shutdown,
// SIGTERM escalation, force-kill fallback, and process-tree cleanup (no
// orphaned dsh processes) all live here.
//
// Adapter contract (spec §2): locate runtime, verify runtime, launch dsh,
// initialize the SDK profile, create/open sessions, send prompts, receive
// streaming events, terminate tasks, recover sessions, report process exit,
// expose diagnostics. Universal Harness owns orchestration metadata only —
// dsh owns its session internals.

import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { UhError, ERR, redact } from '../errors/mod.mjs';
import { requireRuntime } from '../runtime/mod.mjs';
import { isWindows } from '../platform/mod.mjs';

const DEFAULT_TIMEOUTS = {
  startup: 60_000,      // process spawn -> first frame / initialize response
  initialize: 120_000,  // initialize round trip (plugin tree boot + LLM route)
  prompt: 0,            // 0 = no prompt timeout: a long turn is not an error
  shutdown: 15_000,     // graceful shutdown -> exit
  terminate: 10_000,    // SIGTERM -> exit before SIGKILL
};

const JSONRPC_ERROR = -32000;

/** Names of every notification dsh may send us (used for validation/logging). */
export const SDK_NOTIFICATIONS = ['session.event', 'session.status', 'subagent.started', 'subagent.finished'];

/**
 * @param {Object} opts
 * @param {import('../runtime/mod.mjs').RuntimeManager} opts.rm runtime manager (locates + verifies)
 * @param {Object} [opts.log] logger
 * @param {Object} [opts.timeouts] timeout overrides (ms)
 * @param {string} [opts.dshHome] DSH_HOME for the child (default: ~/.dsh)
 * @param {string} [opts.cwd] default cwd passed to initialize
 * @param {Object} [opts.env] extra environment for the child (never secrets in logs)
 */
export function createAdapter({ rm, log = consoleShim(), timeouts = {}, dshHome, cwd, env = {} }) {
  const T = { ...DEFAULT_TIMEOUTS, ...timeouts };
  const listeners = new Map();       // event name -> Set<fn>
  const pending = new Map();         // request id -> {resolve, reject, timer}
  let child = null;
  let stdoutBuffer = '';
  let nextId = 1;
  let exited = null;                 // {code, signal} once known
  let serverInfo = null;
  let initialized = false;
  let stderrChunks = [];

  const resolvedDshHome = dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');

  function on(name, fn) {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(fn);
    return () => listeners.get(name).delete(fn);
  }
  function emit(name, payload) {
    for (const fn of listeners.get(name) || []) { try { fn(payload); } catch (e) { log.warn('listener failed', { name, err: e.message }); } }
  }

  /** Send one JSON-RPC request and await its response (or timeout). */
  function request(method, params, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (!child || exited) return reject(new UhError(ERR.DSH_ABNORMAL_EXIT,
        `cannot send ${method}: dsh process is not running`, { exited },
        'Restart the adapter; the runtime exited unexpectedly.'));
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new UhError(ERR.DSH_TIMEOUT, `${method} did not respond within ${timeoutMs}ms`, { id, method },
          'Check system load; raise the timeout, or the runtime may be hung (a hung dsh is force-killed on shutdown).'));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer, method });
      write({ jsonrpc: '2.0', id, method, params });
    });
  }

  function write(obj) {
    if (!child?.stdin?.writable) throw new UhError(ERR.DSH_PROTOCOL_ERROR, 'dsh stdin is not writable');
    child.stdin.write(JSON.stringify(obj) + '\n');
  }

  /** Route one decoded frame from dsh. */
  function routeFrame(frame) {
    if (!frame || typeof frame !== 'object') return;
    if (typeof frame.id === 'number' || typeof frame.id === 'string') {
      const p = pending.get(frame.id);
      if (!p) return;                 // response with no pending request: ignore
      clearTimeout(p.timer);
      pending.delete(p.id);
      if (frame.error) {
        rejectWithProtocol(p, frame.error);
      } else {
        resolveWith(p, frame.result);
      }
      return;
    }
    if (typeof frame.method === 'string') {
      // notification from dsh
      if (!SDK_NOTIFICATIONS.includes(frame.method)) {
        log.debug('unknown dsh notification', { method: frame.method });
      }
      switch (frame.method) {
        case 'session.event': emit('event', frame.params); break;
        case 'session.status': emit('status', frame.params); break;
        case 'subagent.started': emit('subagent.started', frame.params); break;
        case 'subagent.finished': emit('subagent.finished', frame.params); break;
      }
    }
  }

  function rejectWithProtocol(p, err) {
    const message = err?.message || 'dsh reported an error';
    // Common, actionable mappings from the observed protocol surface.
    let code = ERR.DSH_PROTOCOL_ERROR;
    if (/credential|unauthorized|401|api[_ ]key/i.test(message)) code = ERR.DSH_INIT_FAILED;
    if (p.method === 'initialize') code = ERR.DSH_INIT_FAILED;
    p.reject(new UhError(code, `${p.method} failed: ${message}`,
      { id: p.id, errorCode: err?.code, data: safeData(err?.data) },
      code === ERR.DSH_INIT_FAILED
        ? 'The dsh credential for the selected provider is missing or invalid. Set DEEPSEEK_API_KEY or configure $DSH_HOME/.credentials.yaml; Universal Harness never stores provider keys as plaintext.'
        : 'Retry; if it persists run `uh doctor`.'));
  }

  function resolveWith(p, result) {
    if (p.method === 'initialize') serverInfo = result?.serverInfo || null;
    p.resolve(result);
  }

  function safeData(data) {
    if (data === undefined) return undefined;
    return redact(typeof data === 'string' ? data : JSON.stringify(data));
  }

  function onStdoutChunk(chunk) {
    stdoutBuffer += chunk;
    let nl;
    while ((nl = stdoutBuffer.indexOf('\n')) >= 0) {
      const line = stdoutBuffer.slice(0, nl).trim();
      stdoutBuffer = stdoutBuffer.slice(nl + 1);
      if (!line) continue;
      try { routeFrame(JSON.parse(line)); }
      catch (e) {
        // dsh guarantees stdout is protocol-only; a non-JSON line means the
        // runtime is misbehaving — record it, never crash the pump.
        log.warn('non-JSON frame on dsh stdout', { line: redact(line).slice(0, 300) });
      }
    }
  }

  /**
   * Kill the process and any descendants it spawned (no orphans).
   *
   * On Windows there are no process groups and taskkill without /F only sends
   * WM_CLOSE, which console processes ignore; so child.kill() (which maps to
   * TerminateProcess on Windows) is the decisive signal, and taskkill /F /T
   * walks the tree afterwards to reap any orphaned descendants.
   */
  function killTree(signal = 'SIGTERM') {
    if (!child || exited) return;
    const pid = child.pid;
    try { child.kill(signal); } catch {}
    if (isWindows) {
      try {
        execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
      } catch { /* best effort; the exit handler reports the real state */ }
    } else {
      try { process.kill(-pid, signal); }      // detached process group
      catch { /* child.kill above already covered the parent */ }
    }
  }

  /**
   * Launch dsh (unmodified), having first verified the pinned runtime.
   * Startup is bounded: failure to spawn or an early exit becomes DSH_START_FAILED.
   */
  async function launch() {
    await requireRuntime(rm);      // never launch an unverified runtime
    const nodeBin = rm.nodeBinary();
    const entry = rm.dshEntryPath();
    if (!nodeBin || !entry) throw new UhError(ERR.DSH_MISSING, 'bundled Node or dsh entry is missing', {},
      'Run `uh setup` to install the pinned runtime.');

    const argv = [entry, '--profile', 'sdk'];
    const childEnv = {
      ...process.env,
      DSH_HOME: resolvedDshHome,
      // Keep dsh's own stdout clean for protocol frames (its sdk profile loads
      // no stdout logger; we enforce by not enabling debug on stdout).
      ...env,
    };
    log.info('launching dsh sdk', { node: path.basename(nodeBin), profile: 'sdk', dshHome: redact(resolvedDshHome) });

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new UhError(ERR.DSH_START_FAILED,
        `dsh did not start within ${T.startup}ms`, { argv: argv.join(' ') },
        'Check `uh doctor`; the runtime may be corrupted or blocked.')), T.startup);

      child = spawn(nodeBin, argv, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        // On POSIX, give the child its own process group so we can clean up
        // the whole tree (bash tools may outlive their parent).
        detached: !isWindows,
        env: childEnv,
      });
      child.stdout.on('data', onStdoutChunk);
      child.stderr.on('data', (c) => { stderrChunks.push(c); emit('stderr', redact(String(c)).slice(0, 2000)); });
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(new UhError(ERR.DSH_START_FAILED, `failed to spawn dsh: ${e.message}`, {}, 'Run `uh doctor`.'));
      });
      child.on('exit', (code, signal) => {
        exited = { code, signal };
        clearTimeout(timer);
        // Fail any still-pending requests rather than leaving callers hung.
        for (const [id, p] of pending) {
          clearTimeout(p.timer);
          pending.delete(id);
          p.reject(new UhError(ERR.DSH_ABNORMAL_EXIT,
            `dsh exited (code ${code}, signal ${signal}) before answering ${p.method}`, { id, code, signal },
            'The runtime ended unexpectedly; rerun the task or run `uh doctor`.'));
        }
        emit('exit', { code, signal });
        log.info('dsh exited', { code, signal });
      });
      // Resolve as soon as the process is alive and pumping frames. The real
      // readiness signal is the initialize response; here we only ensure spawn.
      setImmediate(() => { clearTimeout(timer); resolve(); });
    });
    return { pid: child.pid, argv, node: nodeBin };
  }

  /**
   * initialize (JSON-RPC). The provider/model pair is mandatory on the wire
   * because dsh rejects an unregistered provider; the SDK request is the sole
   * model selection point for the sdk profile.
   *
   * @param {Object} [override] {cwd, provider, model, reasoningEffort, maxTokens, sessionId}
   * @returns {Promise<{serverInfo:Object}>}
   */
  async function initialize(override = {}) {
    const params = {
      cwd: path.resolve(override.cwd || cwd || process.cwd()),
      provider: override.provider || 'deepseek-official',
      model: override.model || 'deepseek-official',
    };
    if (override.reasoningEffort) params.reasoningEffort = override.reasoningEffort;
    if (override.maxTokens) params.maxTokens = override.maxTokens;

    try {
      const result = await request('initialize', params, T.initialize);
      initialized = true;
      return { serverInfo: result?.serverInfo, params };
    } catch (e) {
      throw e instanceof UhError ? e
        : new UhError(ERR.DSH_INIT_FAILED, `initialize failed: ${e.message}`, {}, e.message);
    }
  }

  /**
   * session/prompt — enqueue one user turn. dsh creates the session on first
   * use of an id, or reopens it if it already exists in $DSH_HOME, so the same
   * call serves create/open/reopen.
   *
   * @param {Object} opts {sessionId, text, blocks?}
   * @returns {Promise<{messageId:string}>}
   */
  async function prompt({ sessionId, text, blocks }) {
    if (!initialized) throw new UhError(ERR.DSH_INIT_FAILED, 'adapter is not initialized', {},
      'Call initialize before session/prompt.');
    const contentBlocks = blocks || [{ type: 'text', text: String(text) }];
    return request('session/prompt', { sessionId: String(sessionId), contentBlocks }, T.prompt || 24 * 60 * 60_000);
  }

  /**
   * Cancellation (spec §8.9 + audited semantics). Upstream has no cancel
   * method and cancelling a turn "commits neither system nor users", so
   * Universal Harness owns the outcome: we ask for a graceful shutdown, and
   * if the turn is still active within the bound we escalate to SIGTERM and,
   * finally, SIGKILL. The task is recorded as cancelled by UH, not by dsh.
   */
  async function cancel({ timeoutMs } = {}) {
    const bound = timeoutMs ?? T.shutdown + T.terminate;
    log.warn('cancelling dsh task', { bound });
    await shutdown({ timeoutMs: T.shutdown }).catch(() => {});
    if (!exited) {
      killTree('SIGTERM');
      await waitForExit(T.terminate).catch(() => {});
    }
    if (!exited) {
      log.warn('force-killing dsh after bounded termination');
      killTree('SIGKILL');
      await waitForExit(5_000).catch(() => {});
    }
    return { cancelled: true, exited: exited || { code: null, signal: 'SIGKILL' } };
  }

  /** Await process exit, resolving to {code, signal}. */
  function waitForExit(timeoutMs) {
    return new Promise((resolve) => {
      if (exited) return resolve(exited);
      const timer = setTimeout(() => resolve(null), timeoutMs);
      const off = on('exit', (info) => { clearTimeout(timer); resolve(info); });
      setTimeout(() => off(), timeoutMs + 50);
    });
  }

  /**
   * Bounded graceful shutdown (spec §12 order, adapted to one child):
   * 1. send `shutdown` request; 2. wait for the response and process exit
   * within T.shutdown; 3. SIGTERM; 4. wait within T.terminate; 5. SIGKILL.
   * Idempotent: repeated calls are no-ops after exit.
   */
  async function shutdown({ timeoutMs } = {}) {
    if (exited) return { alreadyExited: true, ...exited };
    const bound = timeoutMs ?? T.shutdown;
    try {
      // The protocol's own graceful path: dsh disposes its tree and exits 0.
      await Promise.race([
        request('shutdown', undefined, bound),
        waitForExit(bound),
      ]);
    } catch (e) {
      log.debug('shutdown request did not complete cleanly', { err: e.code || e.message });
    }
    // A successful shutdown response is a promise that the runtime will now
    // exit on its own; give it that grace before escalating to signals.
    if (!exited) {
      const naturalExit = await waitForExit(Math.min(bound, 2_000));
      if (naturalExit) return naturalExit;
    }
    if (!exited) {
      killTree('SIGTERM');
      const afterTerm = await waitForExit(T.terminate);
      if (!exited) {
        killTree('SIGKILL');
        await waitForExit(5_000);
      }
      return afterTerm || { code: null, signal: 'SIGKILL' };
    }
    return exited;
  }

  /**
   * Diagnostics surface for the adapter: versions actually in use plus the
   * last stderr excerpt (redacted), so `uh doctor` can report "which exact
   * dsh + Node am I executing" without ambiguity.
   */
  function report() {
    return {
      running: !exited && !!child,
      exited,
      pid: child?.pid ?? null,
      initialized,
      serverInfo,
      dshVersion: rm.dshInstalled()?.version ?? null,
      dshPackage: rm.manifest.dsh.package,
      nodeVersion: rm.nodeEntry()?.version ?? null,
      dshHome: redact(resolvedDshHome),
      stderr: stderrChunks.length ? redact(Buffer.concat(stderrChunks).toString('utf8')).slice(-800) : null,
    };
  }

  /**
   * Last-resort teardown: kill the tree without negotiating, and reject any
   * still-pending requests. Owners (CLI shutdown manager, tests) call this when
   * a normal shutdown() is impossible or already failed, so a broken runtime
   * can never keep the parent process alive.
   */
  function close() {
    if (child && !exited) killTree('SIGKILL');
    if (child) {
      try { child.stdout?.removeListener('data', onStdoutChunk); } catch {}
      try { child.stdin?.destroy(); } catch {}
      child = null;
    }
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new UhError(ERR.DSH_ABNORMAL_EXIT, `adapter closed while ${p.method} was pending`, {},
        'The adapter was torn down; restart it and retry.'));
    }
    pending.clear();
  }

  return {
    launch, initialize, prompt, cancel, shutdown, close, on, report,
    get exited() { return exited; },
    get pid() { return child?.pid ?? null; },
    timeouts: T,
    dshHome: resolvedDshHome,
  };
}

function consoleShim() {
  return { info() {}, warn() {}, debug() {}, error() {} };
}

/** Generate a UH-side session id suitable for dsh (branded server-side). */
export function newSessionId() {
  return randomUUID();
}
