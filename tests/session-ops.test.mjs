// Phase 3C — the session operations over the protocol.
//
// session.list / session.read / session.create / session.resume are real
// dispatches now. The invariants under test:
//   * session.create registers Universal Harness orchestration metadata and
//     emits a durable session.created event; the dsh conversation does not
//     exist until a task runs (dshAvailable=false, honestly reported).
//   * session.resume is LINKED CONTINUATION: a NEW session with
//     priorSessionId pointing at the old one. The dsh conversation is NOT
//     reopened — that is the R-20 architecture, stated on the wire.
//   * task.start adopts an unseen sessionId into the index so
//     Project -> Session -> Task stays unambiguous, and task.list exposes the
//     association.
//   * authorization: read-only devices may list/read but not create/resume;
//     every failure is a structured protocol error.

import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';

import { createNodeServer } from '../core/server/mod.mjs';
import { createMemoryTransportPair } from '../core/transport/mod.mjs';
import { buildStack, disposeStack, buildPairedSession, SCOPES } from './fixtures/stack.mjs';
import { wireClient } from './fixtures/wire.mjs';

async function withStack(fn, opts = {}) {
  const stack = await buildStack(opts);
  try { return await fn(stack); } finally { disposeStack(stack); }
}

async function makeProject(wire, name, requestId) {
  const r = await wire.request('project.create', { name }, requestId);
  assert.equal(r.ok, true, JSON.stringify(r.payload));
  return r.payload.projectId;
}

test('session.create registers a session for a project and emits a durable event', async () => {
  await withStack(async (stack) => {
    const session = await buildPairedSession(stack);
    const projectId = await makeProject(session.wire, 'alpha', 'req_s_proj1');

    const created = await session.wire.request('session.create', { projectId, label: 'first try' }, 'req_s_create1');
    assert.equal(created.ok, true, JSON.stringify(created.payload));
    const view = created.payload.session;
    assert.match(view.sessionId, /^sess_[0-9a-f]{32}$/);
    assert.equal(view.projectId, projectId);
    assert.equal(view.label, 'first try');
    assert.equal(view.status, 'open');
    assert.equal(view.dshAvailable, false, 'no dsh conversation exists yet — honestly reported');
    assert.equal(view.priorSessionId, undefined);

    // The creation is durable: a reconnecting controller replays it.
    const head = await session.wire.request('session.replay', { deviceId: session.deviceId, lastEventId: null }, 'req_s_replay1');
    assert.equal(head.ok, true);
    const createdEvents = head.payload.events.filter((e) => e.payload?.kind === 'session.created');
    assert.equal(createdEvents.length, 1);
    assert.equal(createdEvents[0].payload.sessionId, view.sessionId);
    assert.equal(createdEvents[0].payload.projectId, projectId);
  });
});

test('session.create on an unknown project answers NOT_FOUND', async () => {
  await withStack(async (stack) => {
    const session = await buildPairedSession(stack);
    const r = await session.wire.request('session.create', { projectId: `proj_${'b'.repeat(32)}` }, 'req_s_create2');
    assert.equal(r.ok, false);
    assert.equal(r.payload.code, 'NOT_FOUND');
  });
});

test('session.list returns sessions with metadata; filtering by project works', async () => {
  await withStack(async (stack) => {
    const session = await buildPairedSession(stack);
    const projA = await makeProject(session.wire, 'proj-a', 'req_s_projA');
    const projB = await makeProject(session.wire, 'proj-b', 'req_s_projB');
    const a = await session.wire.request('session.create', { projectId: projA }, 'req_s_cA');
    const b = await session.wire.request('session.create', { projectId: projB }, 'req_s_cB');
    assert.equal(a.ok && b.ok, true);

    const all = await session.wire.request('session.list', {}, 'req_s_list1');
    assert.equal(all.ok, true);
    const ids = all.payload.sessions.map((s) => s.sessionId);
    assert.ok(ids.includes(a.payload.session.sessionId));
    assert.ok(ids.includes(b.payload.session.sessionId));
    for (const s of all.payload.sessions) {
      assert.match(s.sessionId, /^sess_[0-9a-f]{32}$/);
      assert.equal(typeof s.status, 'string');
    }

    const onlyA = await session.wire.request('session.list', { projectId: projA }, 'req_s_list2');
    assert.equal(onlyA.payload.sessions.length, 1);
    assert.equal(onlyA.payload.sessions[0].sessionId, a.payload.session.sessionId);
  });
});

test('session.read reports UH metadata and dsh availability separately; unknown session is NOT_FOUND', async () => {
  await withStack(async (stack) => {
    const session = await buildPairedSession(stack);
    const projectId = await makeProject(session.wire, 'reader', 'req_s_projR');
    const created = await session.wire.request('session.create', { projectId }, 'req_s_cR');
    const sessionId = created.payload.session.sessionId;

    const read = await session.wire.request('session.read', { sessionId }, 'req_s_read1');
    assert.equal(read.ok, true, JSON.stringify(read.payload));
    assert.equal(read.payload.session.sessionId, sessionId);
    assert.equal(read.payload.session.projectId, projectId);
    assert.equal(read.payload.dsh.available, false, 'dsh has no conversation under a freshly created session');

    const missing = await session.wire.request('session.read', { sessionId: `sess_${'c'.repeat(32)}` }, 'req_s_read2');
    assert.equal(missing.ok, false);
    assert.equal(missing.payload.code, 'NOT_FOUND');
  });
});

test('session.read with a task-run session reports dsh unavailable on this node without inventing data', async () => {
  await withStack(async (stack) => {
    const session = await buildPairedSession(stack);
    const projectId = await makeProject(session.wire, 'dshless', 'req_s_projD');
    // The fake executor never writes to $DSH_HOME, so dsh stays unavailable
    // even after a task ran — and session.read must NOT fabricate anything.
    const started = await session.wire.request('task.start', { projectId, prompt: 'work' }, 'req_s_taskD');
    assert.equal(started.ok, true);
    const sessionId = started.payload.sessionId;
    await session.wire.wait('task.completed', 1, { timeoutMs: 5000 });

    const read = await session.wire.request('session.read', { sessionId }, 'req_s_readD');
    assert.equal(read.ok, true);
    assert.equal(read.payload.dsh.available, false);
    assert.equal(Object.keys(read.payload.dsh).length, 1, 'no dsh fields are invented when the store holds nothing');
  });
});

test('session.resume creates a linked continuation: priorSessionId on the wire, dsh untouched', async () => {
  await withStack(async (stack) => {
    const session = await buildPairedSession(stack);
    const projectId = await makeProject(session.wire, 'lineage', 'req_s_projL');
    const created = await session.wire.request('session.create', { projectId, label: 'original' }, 'req_s_cL');
    const originalId = created.payload.session.sessionId;

    const resumed = await session.wire.request('session.resume', { sessionId: originalId, label: 'continuation' }, 'req_s_res1');
    assert.equal(resumed.ok, true, JSON.stringify(resumed.payload));
    const view = resumed.payload.session;
    assert.match(view.sessionId, /^sess_[0-9a-f]{32}$/);
    assert.notEqual(view.sessionId, originalId, 'resume mints a NEW session id');
    assert.equal(resumed.payload.resumedFromSessionId, originalId, 'the lineage is explicit in the response');
    assert.equal(view.priorSessionId, originalId);
    assert.equal(view.projectId, projectId, 'the continuation inherits the project');
    assert.equal(view.label, 'continuation');
    assert.equal(view.dshAvailable, false, 'the dsh conversation was NOT reopened');

    // The continuation is queryable and self-describing through list+read.
    const listed = await session.wire.request('session.list', { projectId }, 'req_s_listL');
    const views = listed.payload.sessions;
    assert.equal(views.length, 2);
    const continuation = views.find((s) => s.sessionId === view.sessionId);
    assert.equal(continuation.priorSessionId, originalId);
    const read = await session.wire.request('session.read', { sessionId: view.sessionId }, 'req_s_readL');
    assert.equal(read.payload.session.priorSessionId, originalId);
  });
});

test('session.resume on an unknown session answers NOT_FOUND; malformed ids are INVALID_MESSAGE', async () => {
  await withStack(async (stack) => {
    const session = await buildPairedSession(stack);
    const missing = await session.wire.request('session.resume', { sessionId: `sess_${'d'.repeat(32)}` }, 'req_s_res2');
    assert.equal(missing.ok, false);
    assert.equal(missing.payload.code, 'NOT_FOUND');

    const malformed = await session.wire.request('session.resume', { sessionId: 'not-a-session-id' }, 'req_s_res3');
    assert.equal(malformed.ok, false);
    assert.equal(malformed.payload.code, 'INVALID_MESSAGE');
  });
});

test('task.start adopts an unseen sessionId into the session index and task.list exposes the association', async () => {
  await withStack(async (stack) => {
    const session = await buildPairedSession(stack);
    const projectId = await makeProject(session.wire, 'adopt', 'req_s_projT');
    const suppliedId = `sess_${'e'.repeat(32)}`;

    const started = await session.wire.request('task.start', { projectId, sessionId: suppliedId, prompt: 'adopted' }, 'req_s_taskT');
    assert.equal(started.ok, true, JSON.stringify(started.payload));
    assert.equal(started.payload.sessionId, suppliedId);

    // The task is associated with the session, and the session is first-class.
    const tasks = await session.wire.request('task.list', { projectId }, 'req_s_tasksT');
    assert.equal(tasks.payload.tasks.length, 1);
    assert.equal(tasks.payload.tasks[0].sessionId, suppliedId);
    const read = await session.wire.request('session.read', { sessionId: suppliedId }, 'req_s_readT');
    assert.equal(read.ok, true, JSON.stringify(read.payload));
    assert.equal(read.payload.session.projectId, projectId);

    // A task without a sessionId mints one that is equally first-class.
    const started2 = await session.wire.request('task.start', { projectId, prompt: 'auto session' }, 'req_s_taskT2');
    const tasks2 = await session.wire.request('task.list', { projectId }, 'req_s_tasksT2');
    assert.equal(tasks2.payload.tasks.length, 2);
    const ids = new Set(tasks2.payload.tasks.map((t) => t.sessionId));
    assert.ok(ids.has(started2.payload.sessionId));
    const listed = await session.wire.request('session.list', { projectId }, 'req_s_listT');
    assert.equal(listed.payload.sessions.length, 2, 'both sessions are visible through session.list');
  });
});

test('authorization: read-only devices may list/read sessions but not create or resume', async () => {
  await withStack(async (stack) => {
    // Controller with full scopes prepares a project + session.
    const controller = await buildPairedSession(stack);
    const projectId = await makeProject(controller.wire, 'scoped', 'req_s_projP');
    const created = await controller.wire.request('session.create', { projectId }, 'req_s_cP');
    const sessionId = created.payload.session.sessionId;

    // A read-only device pairs and can read but not mutate.
    const pairing = stack.auth.mintPairingPayload({ endpoint: 'memory://test' });
    const { client, node } = createMemoryTransportPair();
    const wire = wireClient(client);
    controller.server.handleConnection(node);
    const hello = await wire.next((e) => e.payload?.kind === 'node.hello');
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const ro = await wire.request('device.pair', {
      deviceName: 'read-only-device',
      platform: 'desktop',
      devicePublicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
      pairingToken: pairing.token,
      expectedNodeIdentitySha256: pairing.nodeIdentitySha256,
      requestedScopes: ['read-only'],
      sigB64: sign(null, Buffer.from(hello.payload.challengeB64, 'utf8'), privateKey).toString('base64'),
    }, 'req_s_pair_ro');
    assert.equal(ro.ok, true, JSON.stringify(ro.payload));

    const list = await wire.request('session.list', {}, 'req_s_list_ro');
    assert.equal(list.ok, true, 'read-only may list sessions');
    const read = await wire.request('session.read', { sessionId }, 'req_s_read_ro');
    assert.equal(read.ok, true, 'read-only may read a session');

    const deniedCreate = await wire.request('session.create', { projectId }, 'req_s_create_ro');
    assert.equal(deniedCreate.ok, false);
    assert.equal(deniedCreate.payload.code, 'SCOPE_DENIED');
    assert.equal(deniedCreate.payload.data?.scope, 'project-session-control');

    const deniedResume = await wire.request('session.resume', { sessionId }, 'req_s_resume_ro');
    assert.equal(deniedResume.ok, false);
    assert.equal(deniedResume.payload.code, 'SCOPE_DENIED');
  });
});

test('session operations over a fresh server rebuild from the same durable index', async () => {
  await withStack(async (stack) => {
    const first = await buildPairedSession(stack);
    const projectId = await makeProject(first.wire, 'persist', 'req_s_projX');
    const created = await first.wire.request('session.create', { projectId, label: 'survives' }, 'req_s_cX');
    const sessionId = created.payload.session.sessionId;

    // A brand-new server over the same portable paths (a node restart).
    const server2 = createNodeServer({
      root: stack.root, p: stack.p,
      identity: stack.identity, auth: stack.auth, events: stack.events,
      workspace: stack.workspace, executorFactory: stack.executorFactory,
      uhVersion: '0.3.0',
    });
    const pair2 = createMemoryTransportPair();
    const wire2 = wireClient(pair2.client);
    server2.handleConnection(pair2.node);
    const hello2 = await wire2.next((e) => e.payload?.kind === 'node.hello');
    const auth2 = await wire2.request('auth.connect', {
      deviceId: first.deviceId,
      sigB64: sign(null, Buffer.from(hello2.payload.challengeB64, 'utf8'), first.devicePrivateKey).toString('base64'),
    }, 'req_s_auth2');
    assert.equal(auth2.ok, true);

    const read = await wire2.request('session.read', { sessionId }, 'req_s_readX');
    assert.equal(read.ok, true, JSON.stringify(read.payload));
    assert.equal(read.payload.session.label, 'survives', 'session metadata survives a node restart');
    assert.equal(read.payload.session.projectId, projectId);
  });
});
