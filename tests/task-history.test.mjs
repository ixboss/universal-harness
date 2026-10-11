// Phase 3C — task.history cursor pagination.
//
// The old implementation answered from `replay(0, {limit: 1000})` filtered by
// taskId, so any event past the first 1000 of the log was invisible. The new
// implementation pages a single task's durable timeline deterministically:
// eventId order, no overlap, no gaps, bounded pages, explicit end-of-history,
// malformed cursors rejected, stale cursors reported honestly.

import test from 'node:test';
import assert from 'node:assert/strict';
import { sign } from 'node:crypto';

import { buildStack, disposeStack, buildPairedSession } from './fixtures/stack.mjs';

async function withStack(fn) {
  const stack = await buildStack();
  try { return await fn(stack); } finally { disposeStack(stack); }
}

async function startTask(wire, name, requestId) {
  const proj = await wire.request('project.create', { name }, `${requestId}_proj`);
  assert.equal(proj.ok, true);
  const started = await wire.request('task.start', { projectId: proj.payload.projectId, prompt: 'page me' }, `${requestId}_start`);
  assert.equal(started.ok, true);
  await wire.wait('task.completed', 1, { timeoutMs: 5000 });
  return started.payload.taskId;
}

test('history: empty page and end-of-history semantics', async () => {
  await withStack(async (stack) => {
    const session = await buildPairedSession(stack);
    const taskId = await startTask(session.wire, 'empty', 'req_h1');

    const page = await session.wire.request('task.history', { taskId, limit: 1 }, 'req_h1_p1');
    assert.equal(page.ok, true);
    assert.equal(page.payload.events.length, 1);
    assert.equal(page.payload.truncated, true);
    assert.equal(typeof page.payload.nextCursor, 'number');

    // Walk to the end.
    let cursor = page.payload.nextCursor;
    let pages = 1;
    let last = page.payload;
    while (last.truncated && pages < 50) {
      const next = await session.wire.request('task.history', { taskId, cursor, limit: 1 }, `req_h1_p${pages + 1}`);
      assert.equal(next.ok, true);
      last = next.payload;
      cursor = last.nextCursor;
      pages++;
    }
    assert.equal(last.truncated, false, 'the walk terminates with an explicit end-of-history');
    assert.equal(last.nextCursor, null, 'end-of-history reports a null nextCursor');
    // Deterministic order across the whole walk.
    const full = await session.wire.request('task.history', { taskId }, 'req_h1_full');
    const ids = full.payload.events.map((e) => e.eventId);
    assert.deepEqual([...ids].sort((a, b) => a - b), ids);
    assert.ok(ids.length >= 4, `a full task lifecycle has multiple durable events (got ${ids.length})`);
  });
});

test('history: multiple pages with no overlap and no missing events', async () => {
  await withStack(async (stack) => {
    const session = await buildPairedSession(stack);
    const taskId = await startTask(session.wire, 'pages', 'req_h2');

    const full = await session.wire.request('task.history', { taskId }, 'req_h2_full');
    const allIds = full.payload.events.map((e) => e.eventId);

    // Page with limit=2 and reassemble the timeline from the pages only.
    const pagedIds = [];
    let cursor = 0;
    for (let i = 0; i < 50; i++) {
      const page = await session.wire.request('task.history', { taskId, cursor, limit: 2 }, `req_h2_p${i}`);
      assert.equal(page.ok, true);
      const pageIds = page.payload.events.map((e) => e.eventId);
      assert.ok(pageIds.every((id) => id > cursor), 'no event at or before the cursor is ever returned again');
      pagedIds.push(...pageIds);
      if (!page.payload.truncated) break;
      cursor = page.payload.nextCursor;
    }
    assert.deepEqual(pagedIds, allIds, 'pages reassemble the exact event timeline: no duplicates, no gaps');
  });
});

test('history: an exact page boundary does not lose the boundary event', async () => {
  await withStack(async (stack) => {
    const session = await buildPairedSession(stack);
    const taskId = await startTask(session.wire, 'boundary', 'req_h3');
    const full = await session.wire.request('task.history', { taskId }, 'req_h3_full');
    const total = full.payload.events.length;
    assert.ok(total >= 4);

    // Page exactly through the full length, then ask one more time.
    let cursor = 0;
    let seen = 0;
    for (let i = 0; i < 50; i++) {
      const page = await session.wire.request('task.history', { taskId, cursor, limit: 2 }, `req_h3_p${i}`);
      seen += page.payload.events.length;
      if (!page.payload.truncated) break;
      cursor = page.payload.nextCursor;
      // When the cursor lands exactly on the last event, the next page must
      // be empty with truncated=false — not an error, not a repeat.
      if (cursor === full.payload.events[total - 1].eventId) {
        const tail = await session.wire.request('task.history', { taskId, cursor, limit: 2 }, `req_h3_tail`);
        assert.equal(tail.payload.events.length, 0);
        assert.equal(tail.payload.truncated, false);
        assert.equal(tail.payload.nextCursor, null);
        seen += 0;
        break;
      }
    }
    assert.equal(seen, total);
  });
});

test('history: malformed cursors are rejected as INVALID_MESSAGE', async () => {
  await withStack(async (stack) => {
    const session = await buildPairedSession(stack);
    const taskId = await startTask(session.wire, 'cursors', 'req_h4');
    for (const [idx, bad] of ['not-a-number', '42', 1.5].entries()) {
      const r = await session.wire.request('task.history', { taskId, cursor: bad }, `req_h4_badx${idx}`);
      assert.equal(r.ok, false);
      assert.equal(r.payload.code, 'INVALID_MESSAGE', `cursor ${JSON.stringify(bad)} must be rejected`);
    }
    const negative = await session.wire.request('task.history', { taskId, cursor: -1 }, 'req_h4_xneg');
    assert.equal(negative.ok, false);
    assert.equal(negative.payload.code, 'INVALID_MESSAGE');
  });
});

test('history: unknown task answers TASK_NOT_FOUND', async () => {
  await withStack(async (stack) => {
    const session = await buildPairedSession(stack);
    const r = await session.wire.request('task.history', { taskId: `task_${'f'.repeat(32)}` }, 'req_h5_unknown');
    assert.equal(r.ok, false);
    assert.equal(r.payload.code, 'TASK_NOT_FOUND');
  });
});

test('history: a stale cursor is reported honestly instead of silently partial', async () => {
  // A dedicated stack with a tiny retention window so real trimming happens.
  const stack = await buildStack();
  try {
    const { createEventStore } = await import('../core/events/mod.mjs');
    // Rebuild the stack's event store with maxEvents=4 (same paths, new store).
    const events = createEventStore({ p: stack.p, maxEvents: 4 });
    const session = await buildPairedSession(stack);
    // Swap the store under a hand-built server (buildPairedSession already
    // wired the default store; a second server on the same paths sees the
    // same log, trimmed by the small store's index).
    const { createNodeServer } = await import('../core/server/mod.mjs');
    const { createMemoryTransportPair } = await import('../core/transport/mod.mjs');
    const { wireClient } = await import('./fixtures/wire.mjs');
    const server = createNodeServer({
      root: stack.root, p: stack.p,
      identity: stack.identity, auth: stack.auth, events,
      workspace: stack.workspace, executorFactory: stack.executorFactory,
      uhVersion: '0.3.0',
    });
    const pair = createMemoryTransportPair();
    const wire = wireClient(pair.client);
    server.handleConnection(pair.node);
    const hello = await wire.next((e) => e.payload?.kind === 'node.hello');
    const authOk = await wire.request('auth.connect', {
      deviceId: session.deviceId,
      sigB64: sign(null, Buffer.from(hello.payload.challengeB64, 'utf8'), session.devicePrivateKey).toString('base64'),
    }, 'req_h6_auth2');
    assert.equal(authOk.ok, true, JSON.stringify(authOk.payload));

    const proj = await wire.request('project.create', { name: 'stale' }, 'req_h6_proj');
    assert.equal(proj.ok, true, JSON.stringify(proj.payload));
    const started = await wire.request('task.start', { projectId: proj.payload.projectId, prompt: 'old work' }, 'req_h6_start');
    assert.equal(started.ok, true, JSON.stringify(started.payload));
    const taskId = started.payload.taskId;
    await wire.wait('task.completed', 1, { timeoutMs: 5000 });

    // Generate enough other durable events to push the task's early events
    // out of the retained window.
    for (let i = 0; i < 8; i++) {
      events.append({ event: { kind: 'task.queued', taskId: `task_${'1'.repeat(31)}${i}`, sessionId: `sess_${'2'.repeat(32)}`, state: 'queued' }, task: {
        taskId: `task_${'1'.repeat(31)}${i}`, projectId: null, sessionId: `sess_${'2'.repeat(32)}`,
        state: 'queued', createdAt: 'now', updatedAt: 'now', lastEventId: 0, prompt: 'filler', priority: 'normal',
      } });
    }

    const page = await wire.request('task.history', { taskId, cursor: 1, limit: 200 }, 'req_h6_stale');
    assert.equal(page.ok, true);
    assert.equal(page.payload.staleCursor, true, 'a cursor below the retained window is flagged stale');
    assert.ok(page.payload.events.every((e) => e.eventId > 1), 'only retained events are served');
  } finally { disposeStack(stack); }
});
