// Fake dsh SDK stub for process-lifecycle tests.
//
// Speaks the same newline-delimited JSON-RPC seam as the real
// `dsh --profile sdk` (initialize / session/prompt / shutdown plus the
// session.event, session.status, subagent.* notifications), but with
// deterministic failure modes selected by UH_FAKE_MODE. It writes nothing but
// protocol frames to stdout, exactly like the real runtime.

import { env, stdin, stdout } from 'node:process';

const MODE = env.UH_FAKE_MODE || 'normal';
const LATENCY = Number(env.UH_FAKE_LATENCY || 0);

function send(obj) { stdout.write(JSON.stringify(obj) + '\n'); }
function notify(method, params) { send({ jsonrpc: '2.0', method, params }); }
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function replyError(id, message, code = -32000) { send({ jsonrpc: '2.0', id, error: { code, message } }); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let buf = '';
let initialized = false;

stdin.setEncoding('utf8');
stdin.on('data', async (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let frame;
    try { frame = JSON.parse(line); } catch { continue; }
    await handle(frame).catch(() => {});
  }
});

// Crash modes exit on their own timer (not on input), so tests can observe an
// abnormal exit without sending any frame.
if (MODE === 'crash') setTimeout(() => process.exit(12), 150);

async function handle(frame) {
  if (MODE === 'crash') { await sleep(150); process.exit(12); return; }
  if (MODE === 'stdout-junk') { stdout.write('not a protocol frame\n'); }

  const { id, method, params } = frame;
  if (LATENCY) await sleep(LATENCY);

  if (method === 'initialize') {
    if (MODE === 'init-fail') { replyError(id, 'no adapter registered for provider "bogus"'); return; }
    if (MODE === 'init-credential-fail') { replyError(id, 'Invalid credential: missing DEEPSEEK_API_KEY', -32001); return; }
    if (MODE === 'crash-on-init') { await sleep(50); process.exit(13); return; }
    initialized = true;
    reply(id, { serverInfo: { name: 'deepseek-harness-sdk-runtime', version: '0.0.1' } });
    return;
  }

  if (method === 'session/prompt') {
    if (!initialized) { replyError(id, 'SDK server is not initialized'); return; }
    const sessionId = String(params.sessionId || 'fake');
    notify('session.event', { sessionId, event: { type: 'permission/preset', seq: 0, data: { preset: 'workspace-write' } } });
    notify('session.event', { sessionId, event: { type: 'turn/start', seq: 1, data: { turn: 1 } } });
    notify('session.event', { sessionId, event: { type: 'user/message', seq: 2, data: { role: 'user' } } });
    if (MODE === 'quota-error') {
      notify('session.event', { sessionId, event: { type: 'assistant/attempt', seq: 3, data: {} } });
      notify('session.event', { sessionId, event: { type: 'turn/end', seq: 4, data: { turn: 1, reason: { kind: 'error', error: { message: 'Insufficient Balance', code: 'QUOTA' } } } } });
      notify('session.status', { sessionId, status: 'idle' });
      reply(id, { messageId: 'fake-message-id' });
      return;
    }
    notify('session.event', { sessionId, event: { type: 'assistant/attempt', seq: 3, data: { stream: [{ type: 'chunk', chunk: { type: 'text', text: 'READY' } }] } } });
    notify('session.event', { sessionId, event: { type: 'turn/end', seq: 4, data: { turn: 1, reason: { kind: 'completed' } } } });
    notify('session.status', { sessionId, status: 'idle' });
    reply(id, { messageId: 'fake-message-id' });
    return;
  }

  if (method === 'shutdown') {
    if (MODE === 'hang') { return; } // never answer, never exit
    reply(id, {});
    await sleep(20);
    process.exit(0);
    return;
  }

  if (id !== undefined) replyError(id, `unknown method: ${method}`);
}

// Keep the process alive until stdin closes (the client going away ends the
// runtime, exactly like the real dsh sdk profile).
stdin.on('end', () => { if (MODE !== 'hang') process.exit(0); });

// Keep the event loop alive until stdin closes.
stdin.on('end', () => { if (MODE !== 'hang') process.exit(0); });
