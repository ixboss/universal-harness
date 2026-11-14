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
import { createNamedAdapter } from '../adapter/registry.mjs';
import { redact } from '../errors/mod.mjs';

/**
 * Audit 1.1: the environment a task's harness child receives. Tasks run as
 * the node OS user (docs/THREAT-MODEL.md T-1: task-control implies code
 * execution), so the child must not inherit operator-wide secrets. This is a
 * strict allowlist — anything not listed (or not `UH_*`) is dropped.
 *
 * Coverage: OS runtime basics (PATH, Windows loader vars), locale, dsh's
 * DSH_HOME, standard proxy variables, the provider API keys/base URLs the
 * adapters read, and the harness's own UH_* configuration.
 */
const TASK_ENV_NAMES = new Set([
  'PATH', 'PATHEXT', 'COMSPEC', 'SystemRoot', 'windir',
  'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'APPDATA', 'LOCALAPPDATA', 'ProgramFiles', 'ProgramData',
  'TEMP', 'TMP', 'LANG', 'LC_ALL', 'TZ',
  'DSH_HOME',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY',
  'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
  'DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN',
  'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS',
  'OPENAI_API_KEY', 'OPENAI_BASE_URL',
]);
const TASK_ENV_PREFIXES = ['UH_'];

export function taskEnvAllowlist(env = process.env) {
  const out = {};
  for (const key of Object.keys(env)) {
    if (TASK_ENV_NAMES.has(key) || TASK_ENV_PREFIXES.some((p) => key.startsWith(p))) {
      out[key] = env[key];
    }
  }
  return out;
}

/**
 * The production executor: one dsh SDK child per task, driven exactly as the
 * adapter already drives it. Nothing upstream is replaced.
 */
export function createDshExecutor({ rm, log, timeouts, dshHome, cwd, env, create }) {
  let adapter = null;
  let settled = false;

  return {
    kind: 'dsh',
    start({ taskId, sessionId, prompt, onLive, onExit }) {
      const live = typeof onLive === 'function' ? onLive : () => {};
      adapter = (create || ((o) => createAdapter(o)))({ rm, log, timeouts, dshHome, cwd, env });

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

/**
 * The registry-driven executor: drives any adapter from the Multi-Harness
 * registry (core/adapter/registry.mjs) through the exact same executor
 * interface as the dsh executor above. `name` is a registry id or alias
 * ('deepseek', 'omniroute', 'openai-compatible', 'claude-code', 'gemini-cli');
 * `adapterOptions` carries per-adapter settings resolved from config/env
 * (base URL, model, command, api key).
 */
export function createAdapterExecutor({ name, rm, log, timeouts, cwd, env = {}, adapterOptions = {} }) {
  const exec = createDshExecutor({ rm, log, timeouts, cwd, env, create: (opts) => createNamedAdapter(name, { ...opts, ...adapterOptions }) });
  return { ...exec, kind: name };
}

function redactChunk(params) {
  if (params == null) return '';
  if (typeof params === 'string') return redact(params).slice(0, 32000);
  try { return redact(JSON.stringify(params)).slice(0, 32000); }
  catch { return ''; }
}
