// Universal Harness — the execution seam (brief §8, §19).
//
// The node owns task lifecycle; an executor owns one harness-internal turn. The
// server talks to executors through this interface only, so the real dsh
// adapter (core/adapter, untouched) and a deterministic test double are
// indistinguishable at the call boundary. This is what lets Phase 2 tests run
// with no paid provider (brief §19) without faking any real model completion.
//
// An executor is created per task and used once:
//
//   const exec = createExecutor({ ... });
//   const handle = exec.start({
//     taskId, sessionId, prompt,
//     onLive: (eventPayload) => ...,   // live-only streaming frames
//     onExit: ({ code, signal }) => ...,
//   });
//   handle.cancel();                    // SIGTERM (bounded) -> force kill
//   await handle.done;                  // settles when the process is gone
//
// `onLive` receives protocol-shaped live event payloads (task.output,
// task.reasoning, task.tool_started, task.tool_finished) — never durable kinds.
// The executor never decides durability or assigns eventIds; that is the event
// store's job.

import { createAdapter } from '../adapter/mod.mjs';
import { redact } from '../errors/mod.mjs';

/**
 * The production executor: one dsh SDK child per task, driven exactly as the
 * adapter already drives it. Nothing upstream is replaced.
 */
export function createDshExecutor({ rm, log, timeouts, dshHome, cwd, env }) {
  let adapter = null;
  let settled = false;

  return {
    kind: 'dsh',
    start({ taskId, sessionId, prompt, onLive, onExit }) {
      const live = typeof onLive === 'function' ? onLive : () => {};
      adapter = createAdapter({ rm, log, timeouts, dshHome, cwd, env });

      let resolveDone, rejectDone;
      const done = new Promise((res, rej) => { resolveDone = res; rejectDone = rej; });

      const settle = (info) => {
        if (settled) return;
        settled = true;
        try { onExit?.(info); } catch {}
        resolveDone(info);
      };

      adapter.on('event', (params) => {
        // Upstream session.event frames are the harness conversation stream.
        // They are surfaced as live content frames here.
        live({ kind: 'task.output', taskId, sessionId, chunk: redactChunk(params) });
      });
      adapter.on('status', (params) => {
        live({ kind: 'task.output', taskId, sessionId, chunk: redactChunk(params), status: true });
      });
      adapter.on('subagent.started', (params) => {
        live({ kind: 'task.tool_started', taskId, sessionId, tool: String(params?.name || params?.tool || 'subagent') });
      });
      adapter.on('subagent.finished', (params) => {
        live({ kind: 'task.tool_finished', taskId, sessionId, tool: String(params?.name || params?.tool || 'subagent') });
      });
      adapter.on('stderr', (text) => {
        live({ kind: 'task.output', taskId, sessionId, chunk: text, stream: 'stderr' });
      });
      adapter.on('exit', ({ code, signal }) => settle({ code, signal }));

      const launched = (async () => {
        try {
          await adapter.launch();
          await adapter.initialize();
          await adapter.prompt({ sessionId, text: prompt });
        } catch (e) {
          settle({ code: null, signal: null, error: e });
        }
      })();

      return {
        done: Promise.race([done, launched.then(() => done)]),
        cancel: async ({ timeoutMs = 8000 } = {}) => {
          try { await adapter.cancel({ timeoutMs }); }
          catch { /* the exit event settles the task regardless */ }
        },
        close: () => { try { adapter.close(); } catch {} },
        report: () => adapter.report(),
      };
    },
  };
}

function redactChunk(params) {
  if (params == null) return '';
  if (typeof params === 'string') return redact(params).slice(0, 32000);
  try { return redact(JSON.stringify(params)).slice(0, 32000); }
  catch { return ''; }
}
