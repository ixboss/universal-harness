// Phase 2 — node server behaviour tests, over a real memory transport and the
// same object graph `uh serve` builds (via the shared stack fixture).
// Invariants under test: capability advertisement, strict envelope/payload
// gating, deterministic capability errors, durable cancellation of non-live
// tasks, startup recovery that never strands a task, challenge nonces that
// cannot be replayed, and workspace filesystem failures that surface as
// protocol error codes rather than raw errno strings.

import test from 'node:test';
import { sign } from 'node:crypto';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createNodeServer } from '../core/server/mod.mjs';
import { createMemoryTransportPair } from '../core/transport/mod.mjs';
import { requestEnvelope } from '../core/protocol/mod.mjs';
import { createFakeExecutor } from './fixtures/fake-executor.mjs';
import { buildStack, disposeStack, buildPairedSession } from './fixtures/stack.mjs';
import { wireClient } from './fixtures/wire.mjs';

async function withStack(fn, { executorOptions } = {}) {
  const stack = await buildStack({ executorOptions });
  try { return await fn(stack); } finally { disposeStack(stack); }
}

/** A bare server + wire with no device paired yet. */
async function openServer(stack, { executorFactory } = {}) {
  const server = createNodeServer({
    root: stack.root, p: stack.p,
    identity: stack.identity, auth: stack.auth, events: stack.events,
    workspace: stack.workspace,
    executorFactory: executorFactory ?? stack.executorFactory,
    uhVersion: '0.3.0',
  });
  const { client, node } = createMemoryTransportPair();
  const wire = wireClient(client);
  server.handleConnection(node);
  const hello = await wire.next((e) => e.payload?.kind === 'node.hello');
  return { server, client, wire, hello };
}

/** Craft a durable task record in an arbitrary state, as a crash would leave it. */
function craftTask(events, state, { prompt = 'crashed work' } = {}) {
  const taskId = `task_${'c'.repeat(31)}${Math.floor(Math.random() * 16).toString(16)}`;
  const task = {
    taskId, projectId: null, sessionId: `sess_${'0'.repeat(16)}`,
    state, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    lastEventId: 0, prompt, priority: 'normal',
  };
  events.append({ event: { kind: 'task.queued', taskId, sessionId: task.sessionId, projectId: null, state }, task });
  return task;
}

test('server: node.hello advertises the version range and exactly the served operations', async () => {
  await withStack(async (stack) => {
    const { hello } = await openServer(stack);
    assert.deepEqual(hello.payload.protocolVersionRange, [1, 1]);
    const ops = hello.payload.operations;
    assert.ok(Array.isArray(ops) && ops.length >= 15);
    assert.ok(ops.includes('task.start'));
    assert.ok(ops.includes('session.replay'));
    for (const absent of ['session.list', 'session.create', 'session.read', 'session.resume', 'task.approve']) {
      assert.ok(!ops.includes(absent), `"${absent}" is not implemented and must not be advertised`);
    }
  });
});

test('server: a client envelope that is not a request is rejected as INVALID_MESSAGE', async () => {
  await withStack(async (stack) => {
    const session = await buildPairedSession(stack);
    const env = requestEnvelope('task.list', {}, 'req_type_0001');
    env.type = 'event'; // request forgery: events flow node -> client only
    session.client.send(env);
    const reply = await session.wire.next((e) => e.requestId === 'req_type_0001' && e.type === 'error');
    assert.equal(reply.payload.code, 'INVALID_MESSAGE');
    assert.match(reply.payload.message, /request/);
  });
});

test('server: malformed payloads are rejected before any handler runs', async () => {
  await withStack(async (stack) => {
    const session = await buildPairedSession(stack);
    const missing = await session.wire.request('task.start', { prompt: 'no project id' }, 'req_bad_start');
    assert.equal(missing.ok, false);
    assert.equal(missing.payload.code, 'INVALID_MESSAGE');
    assert.match(missing.payload.message, /projectId/);

    const extra = await session.wire.request(
      'task.cancel', { taskId: `task_${'0'.repeat(32)}`, surprise: true }, 'req_bad_cancel');
    assert.equal(extra.ok, false);
    assert.equal(extra.payload.code, 'INVALID_MESSAGE');
  });
});

test('server: an unknown or unimplemented operation answers CAPABILITY_UNSUPPORTED, never SCOPE_DENIED', async () => {
  await withStack(async (stack) => {
    const session = await buildPairedSession(stack);
    for (const kind of ['session.create', 'task.approve', 'something.entirely.new']) {
      const r = await session.wire.request(kind, kind === 'session.create' ? { projectId: `proj_${'a'.repeat(32)}` } : {}, `req_cap_${['session.create','task.approve','something.entirely.new'].indexOf(kind)}`);
      assert.equal(r.ok, false, kind);
      assert.equal(r.payload.code, 'CAPABILITY_UNSUPPORTED', kind);
    }
  });
});

test('server: the challenge nonce is single-use — a replayed auth.connect fails', async () => {
  await withStack(async (stack) => {
    const session = await buildPairedSession(stack);
    // A second connection for the same device, driven manually so the exact
    // successful signature can be captured and replayed.
    const pair2 = createMemoryTransportPair();
    const wire2 = wireClient(pair2.client);
    session.server.handleConnection(pair2.node);
    const hello2 = await wire2.next((e) => e.payload?.kind === 'node.hello');
    const challenge = hello2.payload.challengeB64;
    const sigB64 = sign(null, Buffer.from(challenge, 'utf8'), session.devicePrivateKey).toString('base64');

    const ok = await wire2.request('auth.connect', { deviceId: session.deviceId, sigB64 }, 'req_auth_ok');
    assert.equal(ok.ok, true, JSON.stringify(ok.payload));

    // The SAME signature over the SAME (already consumed) nonce must now fail.
    const replay = await wire2.request('auth.connect', { deviceId: session.deviceId, sigB64 }, 'req_auth_replay');
    assert.equal(replay.ok, false);
    assert.equal(replay.payload.code, 'CHALLENGE_FAILED');
  });
});

test('server: file write/read round-trips with versioning', async () => {
  await withStack(async (stack) => {
    const session = await buildPairedSession(stack);
    const proj = await session.wire.request('project.create', { name: 'docs' }, 'req_proj_001');
    assert.equal(proj.ok, true, JSON.stringify(proj.payload));
    const projectId = proj.payload.projectId;

    const w1 = await session.wire.request('file.write', { projectId, path: 'notes/a.md', content: '# hi' }, 'req_write_01');
    assert.equal(w1.ok, true, JSON.stringify(w1.payload));
    assert.equal(w1.payload.version, 1);

    const r1 = await session.wire.request('file.read', { projectId, path: 'notes/a.md' }, 'req_read_01');
    assert.equal(r1.ok, true, JSON.stringify(r1.payload));
    assert.equal(r1.payload.content, '# hi');
    assert.equal(r1.payload.version, 1);

    // Optimistic concurrency still guards stale writes.
    const stale = await session.wire.request('file.write', { projectId, path: 'notes/a.md', content: 'clobber', baseHash: 'deadbeef' }, 'req_write_02');
    assert.equal(stale.ok, false);
    assert.equal(stale.payload.code, 'CONFLICT');
  });
});

test('server: workspace filesystem failures surface as protocol error codes', async () => {
  await withStack(async (stack) => {
    const session = await buildPairedSession(stack);
    const proj = await session.wire.request('project.create', { name: 'fsedge' }, 'req_proj_002');
    const projectId = proj.payload.projectId;
    const wsDir = proj.payload.workspacePath;

    // A write whose target is an existing directory is not a raw EISDIR.
    fs.mkdirSync(path.join(wsDir, 'subdir'), { recursive: true });
    const dirTarget = await session.wire.request('file.write', { projectId, path: 'subdir', content: 'x' }, 'req_w_dir');
    assert.equal(dirTarget.ok, false);
    assert.equal(dirTarget.payload.code, 'INVALID_MESSAGE');
    assert.doesNotMatch(dirTarget.payload.code, /^E/);

    // A write whose parent path is blocked by a regular file is not a raw errno.
    fs.writeFileSync(path.join(wsDir, 'blocker'), 'not a directory');
    const blocked = await session.wire.request('file.write', { projectId, path: 'blocker/inner.txt', content: 'x' }, 'req_w_blocked');
    assert.equal(blocked.ok, false);
    assert.equal(blocked.payload.code, 'WORKSPACE_UNAVAILABLE');
    assert.doesNotMatch(blocked.payload.code, /^E/);
  });
});

test('server: task history is served from the durable index', async () => {
  await withStack(async (stack) => {
    const session = await buildPairedSession(stack);
    const proj = await session.wire.request('project.create', { name: 'hist' }, 'req_proj_003');
    const started = await session.wire.request('task.start', { projectId: proj.payload.projectId, prompt: 'hello' }, 'req_start_001');
    assert.equal(started.ok, true);
    const taskId = started.payload.taskId;
    await session.wire.wait('task.completed', 1, { timeoutMs: 5000 });

    const hist = await session.wire.request('task.history', { taskId }, 'req_hist_001');
    assert.equal(hist.ok, true, JSON.stringify(hist.payload));
    const kinds = hist.payload.events.map((e) => e.payload.kind);
    assert.ok(kinds.includes('task.queued'));
    assert.ok(kinds.includes('task.started'));
    assert.ok(kinds.includes('task.completed'));
    for (const e of hist.payload.events) {
      assert.equal(e.payload.taskId, taskId, 'history is scoped to the requested task');
    }
  });
});

test('server: a durable non-live queued task can be cancelled', async () => {
  await withStack(async (stack) => {
    const session = await buildPairedSession(stack);
    const task = craftTask(stack.events, 'queued');
    const r = await session.wire.request('task.cancel', { taskId: task.taskId, reason: 'cleanup' }, 'req_cancel_q');
    assert.equal(r.ok, true, JSON.stringify(r.payload));
    assert.equal(r.payload.state, 'cancelled');
    assert.equal(stack.events.taskRecord(task.taskId).state, 'cancelled');
  });
});

test('server: a durable non-live running task can be cancelled (no UNAVAILABLE dead end)', async () => {
  await withStack(async (stack) => {
    const session = await buildPairedSession(stack);
    const task = craftTask(stack.events, 'running');
    const r = await session.wire.request('task.cancel', { taskId: task.taskId, reason: 'post-crash cancel' }, 'req_cancel_r');
    assert.equal(r.ok, true, JSON.stringify(r.payload));
    assert.equal(r.payload.state, 'cancelled');
    assert.equal(stack.events.taskRecord(task.taskId).state, 'cancelled');
  });
});

test('recovery: a running task found at startup settles deterministically as failed', async () => {
  await withStack(async (stack) => {
    const task = craftTask(stack.events, 'running');
    // A fresh server instance = the state after a node restart.
    const server = createNodeServer({
      root: stack.root, p: stack.p,
      identity: stack.identity, auth: stack.auth, events: stack.events,
      workspace: stack.workspace, executorFactory: stack.executorFactory,
      uhVersion: '0.3.0',
    });
    const recovery = server.recover();
    assert.ok(recovery.resolved >= 1);
    assert.equal(stack.events.taskRecord(task.taskId).state, 'failed', 'a vanished process is never completed');
    const failureEvent = stack.events.replay(0).events.find((e) => e.payload.taskId === task.taskId && e.payload.kind === 'task.failed');
    assert.ok(failureEvent, 'the durable task.failed event exists');
    assert.match(failureEvent.payload.reason || '', /process-vanished|recovery/);
  });
});

test('recovery: a queued task is re-driven and completes when an executor is available', async () => {
  await withStack(async (stack) => {
    const task = craftTask(stack.events, 'queued', { prompt: 'resume me' });
    const server = createNodeServer({
      root: stack.root, p: stack.p,
      identity: stack.identity, auth: stack.auth, events: stack.events,
      workspace: stack.workspace,
      executorFactory: () => createFakeExecutor({ frames: 1, delayMs: 5 }),
      uhVersion: '0.3.0',
    });
    const recovery = server.recover();
    assert.ok(recovery.revived >= 1);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(stack.events.taskRecord(task.taskId).state, 'completed', 'the re-driven task reaches its natural end');
  });
});

test('recovery: a queued task settles as failed when no executor can run it', async () => {
  await withStack(async (stack) => {
    const task = craftTask(stack.events, 'queued');
    const server = createNodeServer({
      root: stack.root, p: stack.p,
      identity: stack.identity, auth: stack.auth, events: stack.events,
      workspace: stack.workspace,
      executorFactory: null, // the executor cannot be brought up on this node
      uhVersion: '0.3.0',
    });
    server.recover();
    assert.equal(stack.events.taskRecord(task.taskId).state, 'failed');
    const failureEvent = stack.events.replay(0).events.find((e) => e.payload.taskId === task.taskId && e.payload.kind === 'task.failed');
    assert.ok(failureEvent, 'the durable task.failed event exists');
    assert.match(failureEvent.payload.reason || '', /executor/);
  });
});
