// Smoke-test helper: a deterministic fake executor (brief §19 test double).
// Emits a configurable number of live frames, then exits with a chosen code.
// It performs NO real model call and never claims to.
export function createFakeExecutor({ frames = 3, exitCode = 0, delayMs = 20 } = {}) {
  return {
    kind: 'fake',
    start({ taskId, sessionId, onLive, onExit }) {
      const live = typeof onLive === 'function' ? onLive : () => {};
      let cancelled = false;
      let timer = null;
      let settle = null;
      const done = new Promise((res) => { settle = res; });

      let i = 0;
      const tick = () => {
        if (cancelled) return;
        if (i < frames) {
          live({ kind: 'task.output', taskId, sessionId, chunk: `frame ${i}`, index: i });
          i++;
          timer = setTimeout(tick, delayMs);
        } else {
          finish({ code: exitCode, signal: null });
        }
      };
      timer = setTimeout(tick, delayMs);

      function finish(info) {
        if (timer) clearTimeout(timer);
        try { onExit?.(info); } catch {}
        settle(info);
      }

      return {
        done,
        cancel: async () => {
          cancelled = true;
          finish({ code: 130, signal: 'SIGTERM' });
        },
        close() {
          cancelled = true;
          if (timer) clearTimeout(timer);
        },
        report: () => ({ kind: 'fake', frames }),
        get cancelled() { return cancelled; },
      };
    },
  };
}
