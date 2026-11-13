// Multi-Harness Adapter Registry (Phase 1 expansion).
//
// Until now the only harness adapter was the dsh SDK adapter in mod.mjs. This
// registry turns the adapter seam into a pluggable choice of harness backends:
//
//   deepseek           the original `dsh --profile sdk` stdio JSON-RPC adapter
//                      (mod.mjs, untouched)
//   omniroute          any OpenAI-compatible local router/gateway (defaults to
//                      a local OmniRoute gateway over HTTP + SSE)
//   openai-compatible  the same HTTP/SSE transport with neutral defaults, for
//                      any local router (llama.cpp server, LM Studio, Ollama
//                      with /v1, vLLM, …)
//   claude-code        the Claude Code CLI as a one-shot streaming process
//   gemini-cli         the Gemini CLI as a one-shot streaming process
//
// Every adapter conforms to the same contract as the dsh adapter (mod.mjs):
//
//   { launch, initialize, prompt, cancel, shutdown, close, on,
//     exited, pid, timeouts, report }
//
// so the executor wrapper in core/executor can drive all of them identically.
// Adapter selection is resolved in this order: `uh serve --adapter <name>` >
// UH_ADAPTER env > data/config/config.json (adapter.harness, default
// 'deepseek').

import { spawn } from 'node:child_process';
import { UhError, ERR, redact } from '../errors/mod.mjs';
import { createAdapter as createDshAdapter } from './mod.mjs';

const DEFAULT_TIMEOUTS = {
  startup: 60_000,
  initialize: 120_000,
  prompt: 0,          // 0 = no prompt timeout: a long turn is not an error
  shutdown: 15_000,
  terminate: 10_000,
};

/** Registry descriptors, in preference order. */
export const ADAPTERS = {
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek (dsh SDK)',
    kind: 'stdio-jsonrpc',
    description: 'The pinned @deepseek-ai/dsh harness over stdio JSON-RPC (the original adapter).',
    requiresRuntime: true,
  },
  omniroute: {
    id: 'omniroute',
    label: 'OmniRoute gateway',
    kind: 'http-sse',
    description: 'A local multi-account OmniRoute LLM router speaking the OpenAI chat-completions API (streaming).',
    requiresRuntime: false,
  },
  'openai-compatible': {
    id: 'openai-compatible',
    label: 'OpenAI-compatible HTTP/SSE',
    kind: 'http-sse',
    description: 'Any local OpenAI-compatible router/gateway (llama.cpp, LM Studio, Ollama /v1, vLLM, …).',
    requiresRuntime: false,
  },
  'claude-code': {
    id: 'claude-code',
    label: 'Claude Code CLI',
    kind: 'cli-process',
    description: 'The Claude Code CLI in one-shot streaming JSON mode.',
    requiresRuntime: false,
  },
  'gemini-cli': {
    id: 'gemini-cli',
    label: 'Gemini CLI',
    kind: 'cli-process',
    description: 'The Gemini CLI in one-shot mode, streamed line by line.',
    requiresRuntime: false,
  },
};

const ALIASES = {
  dsh: 'deepseek',
  deepseek: 'deepseek',
  omniroute: 'omniroute',
  openai: 'openai-compatible',
  'openai-compatible': 'openai-compatible',
  claude: 'claude-code',
  'claude-code': 'claude-code',
  gemini: 'gemini-cli',
  'gemini-cli': 'gemini-cli',
};

export function listAdapters() {
  return Object.values(ADAPTERS);
}

/** Resolve a user-supplied adapter name (or alias) to a registry id. */
export function normalizeAdapterName(name) {
  if (!name || typeof name !== 'string') return null;
  const id = ALIASES[name.trim().toLowerCase()];
  return id || null;
}

export function isAdapter(name) {
  return normalizeAdapterName(name) != null;
}

/**
 * Create an adapter by registry name. Throws ADAPTER_UNKNOWN for anything
 * unregistered — never silently falls back.
 */
export function createNamedAdapter(name, opts = {}) {
  const id = normalizeAdapterName(name);
  if (!id) {
    throw new UhError(ERR.UH_INTERNAL, `unknown harness adapter "${name}"`, { adapter: String(name) },
      `Run \`uh adapters\` to list the registered adapters.`);
  }
  const T = { ...DEFAULT_TIMEOUTS, ...(opts.timeouts || {}) };
  const base = { log: opts.log, timeouts: T };
  switch (id) {
    case 'deepseek':
      return createDshAdapter({ ...opts, timeouts: T });
    case 'omniroute':
      return createOpenAiHttpAdapter({ ...base, ...opts, timeouts: T,
        baseUrl: opts.baseUrl || opts.env?.UH_OMNIROUTE_BASE_URL || 'http://127.0.0.1:8090/v1',
        model: opts.model || opts.env?.UH_OMNIROUTE_MODEL || 'auto',
        apiKey: opts.apiKey ?? opts.env?.UH_OMNIROUTE_API_KEY ?? null,
        label: 'omniroute' });
    case 'openai-compatible':
      return createOpenAiHttpAdapter({ ...base, ...opts, timeouts: T,
        baseUrl: opts.baseUrl || opts.env?.UH_OPENAI_BASE_URL || 'http://127.0.0.1:11434/v1',
        model: opts.model || opts.env?.UH_OPENAI_MODEL || 'default',
        apiKey: opts.apiKey ?? opts.env?.UH_OPENAI_API_KEY ?? null,
        label: 'openai-compatible' });
    case 'claude-code':
      return createCliProcessAdapter({ ...base, ...opts, timeouts: T,
        command: opts.command || opts.env?.UH_CLAUDE_COMMAND || 'claude',
        args: opts.args || (opts.env?.UH_CLAUDE_ARGS ? opts.env.UH_CLAUDE_ARGS.split(' ').filter(Boolean) : ['-p', '--output-format', 'stream-json', '--verbose']),
        promptMode: 'arg',
        label: 'claude-code' });
    case 'gemini-cli':
      return createCliProcessAdapter({ ...base, ...opts, timeouts: T,
        command: opts.command || opts.env?.UH_GEMINI_COMMAND || 'gemini',
        args: opts.args || (opts.env?.UH_GEMINI_ARGS ? opts.env.UH_GEMINI_ARGS.split(' ').filter(Boolean) : ['-p']),
        promptMode: 'arg',
        label: 'gemini-cli' });
    default:
      throw new UhError(ERR.UH_INTERNAL, `adapter "${id}" has no factory`);
  }
}

// ---------------------------------------------------------------------------
// Shared emitter plumbing
// ---------------------------------------------------------------------------

function makeEmitter(log) {
  const listeners = new Map();
  return {
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(fn);
      return () => listeners.get(name)?.delete(fn);
    },
    emit(name, payload) {
      for (const fn of listeners.get(name) || []) {
        try { fn(payload); } catch (e) { log?.warn?.('listener failed', { name, err: e.message }); }
      }
    },
  };
}

function noop() {}

// ---------------------------------------------------------------------------
// HTTP + SSE adapter (omniroute / openai-compatible)
// ---------------------------------------------------------------------------

/**
 * Streams one chat-completions request per prompt over SSE. The adapter
 * process model differs from dsh — there is no persistent child — so launch()
 * and initialize() verify reachability instead, and the prompt's completion
 * settles the task (exit code 0) exactly like a child exit.
 */
export function createOpenAiHttpAdapter({ baseUrl, model, apiKey, label = 'openai-compatible', log = consoleShim(), timeouts = {} }) {
  log = log || consoleShim();
  const T = { ...DEFAULT_TIMEOUTS, ...timeouts };
  const { on, emit } = makeEmitter(log);
  let controller = null;        // AbortController for the in-flight prompt
  let exited = null;            // {code, signal} once the current prompt settled
  let lastError = null;
  const base = String(baseUrl || '').replace(/\/+$/, '');

  function headers() {
    const h = { 'content-type': 'application/json', accept: 'text/event-stream' };
    if (apiKey) h.authorization = `Bearer ${apiKey}`;
    return h;
  }

  async function checkReachable() {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), Math.max(T.startup, 1000));
    try {
      const res = await fetch(`${base}/models`, { headers: headers(), signal: ctl.signal });
      if (!res.ok) throw new UhError(ERR.DSH_START_FAILED, `${label} endpoint answered ${res.status} for ${base}/models`, { baseUrl: base },
        'Start the local router/gateway, or point UH_ADAPTER config at a reachable one.');
    } catch (e) {
      if (e instanceof UhError) throw e;
      throw new UhError(ERR.DSH_START_FAILED, `${label} endpoint unreachable at ${base}: ${e.message}`, { baseUrl: base },
        'Start the local router/gateway, or correct the adapter base URL.');
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    kind: 'http-sse',
    label,
    baseUrl: base,
    model,
    launch: checkReachable,
    initialize: noop,
    on,
    get exited() { return exited; },
    get pid() { return null; },
    timeouts: T,

    async prompt({ text }) {
      exited = null;
      controller = new AbortController();
      let output = '';
      const timer = T.prompt > 0 ? setTimeout(() => controller.abort(new UhError(ERR.DSH_TIMEOUT, `${label} prompt exceeded ${T.prompt}ms`)), T.prompt) : null;
      try {
        const res = await fetch(`${base}/chat/completions`, {
          method: 'POST',
          headers: headers(),
          signal: controller.signal,
          body: JSON.stringify({ model, stream: true, messages: [{ role: 'user', content: String(text || '') }] }),
        });
        if (!res.ok || !res.body) {
          const detail = await res.text().catch(() => '');
          throw new UhError(ERR.DSH_PROTOCOL_ERROR, `${label} chat/completions failed: HTTP ${res.status} ${redact(detail).slice(0, 300)}`, { status: res.status });
        }
        // SSE: lines of `data: {...}` terminated by `data: [DONE]`. Anything
        // that is not parseable JSON is surfaced as raw output, never dropped.
        const decoder = new TextDecoder();
        let buf = '';
        for await (const chunk of res.body) {
          buf += decoder.decode(chunk, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (data === '[DONE]') { buf = ''; break; }
            try {
              const evt = JSON.parse(data);
              const delta = evt?.choices?.[0]?.delta?.content;
              if (typeof delta === 'string' && delta.length) {
                output += delta;
                emit('event', { delta });
              }
              const reasoning = evt?.choices?.[0]?.delta?.reasoning_content ?? evt?.choices?.[0]?.delta?.reasoning;
              if (typeof reasoning === 'string' && reasoning.length) emit('reasoning', { reasoning });
            } catch {
              emit('event', { raw: data.slice(0, 2000) });
            }
          }
        }
      } catch (e) {
        lastError = e;
        emit('stderr', `${label}: ${e.message}`);
        exited = { code: null, signal: null, error: e };
        emit('exit', exited);
        throw e instanceof UhError ? e : new UhError(ERR.DSH_ABNORMAL_EXIT, `${label} prompt failed: ${e.message}`, {}, undefined, e);
      } finally {
        if (timer) clearTimeout(timer);
        controller = null;
      }
      exited = { code: 0, signal: null };
      emit('exit', exited);
      return { output };
    },

    cancel: async () => { try { controller?.abort(); } catch {} },
    shutdown: noop,
    close: noop,
    report: () => ({
      adapter: label,
      baseUrl: base,
      model,
      inFlight: controller != null,
      exited,
      lastError: lastError ? String(lastError.message).slice(0, 500) : null,
    }),
  };
}

// ---------------------------------------------------------------------------
// CLI process adapter (claude-code / gemini-cli)
// ---------------------------------------------------------------------------

/**
 * One child process per prompt: launch()/initialize() verify the CLI is on
 * PATH (`--version`), prompt() spawns the CLI with the prompt, streams stdout
 * lines as task.output, and settles the task on child exit.
 */
export function createCliProcessAdapter({ command, args, promptMode = 'arg', label = 'cli', log = consoleShim(), timeouts = {}, cwd, env = {} }) {
  log = log || consoleShim();
  const T = { ...DEFAULT_TIMEOUTS, ...timeouts };
  const { on, emit } = makeEmitter(log);
  let child = null;
  let exited = null;
  let stderrTail = [];
  let verified = false;

  function emitExit(info) {
    exited = info;
    emit('exit', info);
  }

  return {
    kind: 'cli-process',
    label,
    command,
    launch: async () => {
      if (verified) return;
      await new Promise((resolve, reject) => {
        const probe = spawn(command, ['--version'], { cwd: cwd || undefined, env: { ...process.env, ...env }, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        probe.stdout?.on('data', (d) => { out += d; });
        const timer = setTimeout(() => { try { probe.kill(); } catch {} reject(new UhError(ERR.DSH_START_FAILED, `${command} --version did not answer within ${T.startup}ms`, { command })); }, T.startup);
        probe.on('error', (e) => { clearTimeout(timer); reject(new UhError(ERR.DSH_START_FAILED, `${label}: cannot run "${command}": ${e.message}`, { command },
          `Install the ${label} CLI or point the adapter command at its full path.`)); });
        probe.on('exit', (code) => {
          clearTimeout(timer);
          if (code === 0) { log.info?.(`${label} CLI found`, { version: out.trim().slice(0, 120) }); resolve(); }
          else reject(new UhError(ERR.DSH_START_FAILED, `${label}: "${command} --version" exited ${code}`, { command }));
        });
      });
      verified = true;
    },
    initialize: noop,
    on,
    get exited() { return exited; },
    get pid() { return child?.pid ?? null; },
    timeouts: T,

    prompt({ text }) {
      exited = null;
      const fullArgs = promptMode === 'arg' ? [...args, String(text || '')] : args;
      child = spawn(command, fullArgs, {
        cwd: cwd || undefined,
        env: { ...process.env, ...env },
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const stdout = child.stdout;
      let buf = '';
      stdout.setEncoding('utf8');
      stdout.on('data', (d) => {
        buf += d;
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          // Claude stream-json lines carry typed events; surface the text
          // deltas as output and everything else raw so nothing is lost.
          let parsed = null;
          try { parsed = JSON.parse(line); } catch { /* plain text line */ }
          if (parsed) {
            const texts = collectStrings(parsed);
            if (texts.length) emit('event', { delta: texts.join('') });
            else emit('event', { raw: line.slice(0, 2000) });
          } else {
            emit('event', { delta: line + '\n' });
          }
        }
      });
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (d) => {
        stderrTail.push(String(d));
        if (stderrTail.length > 50) stderrTail.shift();
        emit('stderr', String(d));
      });
      child.on('error', (e) => emitExit({ code: null, signal: null, error: e }));
      child.on('exit', (code, signal) => emitExit({ code, signal }));
      return { pid: child.pid };
    },

    cancel: async ({ timeoutMs = T.terminate } = {}) => {
      if (!child || child.exitCode != null) return;
      const c = child;
      try { c.kill('SIGTERM'); } catch {}
      const timer = setTimeout(() => { try { c.kill('SIGKILL'); } catch {} }, Math.max(timeoutMs, 0));
      c.once('exit', () => clearTimeout(timer));
      if (process.platform === 'win32' && c.pid) {
        try { spawn('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
      }
    },
    shutdown: noop,
    close: noop,
    report: () => ({
      adapter: label,
      command,
      pid: child?.pid ?? null,
      exited,
      lastStderr: stderrTail.join('').slice(-2000),
    }),
  };
}

/** Recursively collect non-empty string fields from a parsed CLI JSON event. */
function collectStrings(value, out = [], depth = 0) {
  if (depth > 4 || value == null) return out;
  if (typeof value === 'string') { if (value.trim()) out.push(value); return out; }
  if (Array.isArray(value)) { for (const v of value) collectStrings(v, out, depth + 1); return out; }
  if (typeof value === 'object') {
    for (const key of ['text', 'content', 'delta', 'message', 'chunk']) {
      if (value[key] != null) collectStrings(value[key], out, depth + 1);
    }
  }
  return out;
}

function consoleShim() {
  return {
    info: (...a) => console.log(...a),
    warn: (...a) => console.warn(...a),
    error: (...a) => console.error(...a),
    debug: () => {},
    child: () => consoleShim(),
  };
}
