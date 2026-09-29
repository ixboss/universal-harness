// Safe, idempotent shutdown sequencing (spec §12).
//
// Order:
//   1. stop accepting new work
//   2. let active operations reach a safe checkpoint where possible
//   3. request graceful dsh shutdown
//   4. bounded wait
//   5. force terminate only if necessary
//   6. flush Universal Harness metadata
//   7. close files
//   8. write final diagnostic state
//   9. exit
//
// `run()` is safe to invoke repeatedly (signals, atexit, user code): once
// shutdown has begun, further calls await the same in-flight completion.

import { UhError, ERR } from '../errors/mod.mjs';

const PHASE_ORDER = ['gate', 'drain', 'adapter', 'flush', 'diagnostics'];

/**
 * @param {Object} opts
 * @param {Object} [opts.log]
 * @param {function():void} [opts.onFatal] last-resort exit hook
 */
export function createShutdownManager({ log = consoleShim(), onFatal } = {}) {
  let inflight = null;
  let done = null;
  const handlers = []; // [{name, phase, fn}]

  /** Register a shutdown handler. Phases run in PHASE_ORDER. */
  function register(name, fn, phase = 'flush') {
    handlers.push({ name, fn, phase });
    return () => { const i = handlers.findIndex((h) => h.name === name && h.fn === fn); if (i >= 0) handlers.splice(i, 1); };
  }

  async function runPhases(fromIndex) {
    for (let i = fromIndex; i < PHASE_ORDER.length; i++) {
      const phase = PHASE_ORDER[i];
      for (const h of handlers.filter((x) => x.phase === phase)) {
        try { await h.fn(); }
        catch (e) { log.warn('shutdown handler failed', { phase: h.name, err: e?.message || String(e) }); }
      }
    }
  }

  /**
   * Run the shutdown sequence. Idempotent and re-entrant: every invocation
   * after the first returns the same result.
   *
   * @param {Object} adapter optional DesktopExecutionAdapter to stop in the
   *   adapter phase (graceful request, bounded wait, forced fallback live in
   *   the adapter itself)
   */
  async function run({ adapter, timeoutMs } = {}) {
    if (done) return done;
    if (inflight) return inflight;
    inflight = (async () => {
      log.info('shutdown: begin');

      // 1. gate — stop accepting new work (handlers may close listeners).
      await runPhases(0);

      // 3+4+5. adapter — the adapter implements bounded graceful shutdown with
      // SIGTERM/SIGKILL escalation; here we simply await it.
      if (adapter && !adapter.exited) {
        try { await adapter.shutdown({ timeoutMs }); }
        catch (e) { log.warn('shutdown: adapter did not shut down cleanly', { err: e?.message }); }
        if (!adapter.exited) {
          log.warn('shutdown: cancelling adapter after bounded grace');
          try { await adapter.cancel(); } catch { /* escalation already tried */ }
        }
      }

      // 6+7+8. flush, close, diagnostics.
      await runPhases(2);

      log.info('shutdown: complete');
      done = { at: new Date().toISOString(), ok: true };
      return done;
    })();
    try { return await inflight; }
    catch (e) {
      done = { at: new Date().toISOString(), ok: false, error: e?.message || String(e) };
      if (onFatal) try { onFatal(); } catch {}
      throw e instanceof UhError ? e : new UhError(ERR.UH_INTERNAL, 'shutdown sequence failed', {}, undefined, e);
    }
  }

  /** Install signal handlers that trigger `run()` (SIGINT/SIGTERM). */
  function installSignals({ adapter } = {}) {
    const trigger = (sig) => {
      // SIGINT is a user interrupt; still shut down cleanly and let the caller
      // choose the exit code (convention: 130 for SIGINT, 0 for SIGTERM).
      run({ adapter }).catch(() => {});
      process.on(sig, () => {}); // keep the handler; run() is idempotent
    };
    process.once('SIGINT', () => trigger('SIGINT'));
    process.once('SIGTERM', () => trigger('SIGTERM'));
    return () => { process.removeAllListeners('SIGINT'); process.removeAllListeners('SIGTERM'); };
  }

  return { register, run, installSignals, phases: PHASE_ORDER };
}

function consoleShim() { return { info() {}, warn() {}, debug() {}, error() {} }; }
