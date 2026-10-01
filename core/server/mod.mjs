// Universal Harness — the node server (brief §3, §8, §11).
//
// Owns node identity, task lifecycle, the durable event log, and one
// conversation per connected client. It does not depend on any UI: clients are
// transports, and a task outlives the transport that started it.
//
// The lifecycle the brief names is implemented here:
//   * a task is node-owned — the client requests, the node runs and records;
//   * a client disconnect does NOT cancel a running task (§8);
//   * task state survives disconnect and restart, and is the authority a
//     reconnecting client reads back (§11);
//   * durable events are replayable from a cursor, with an explicit snapshot
//     fallback when the cursor cannot be served (§10).
//
// Layering is strict: transport -> server dispatch -> auth/scopes -> task
// engine -> executor -> dsh adapter. No layer reaches across another.

import { randomBytes } from 'node:crypto';
import path from 'node:path';
import {
  PROTOCOL_VERSION, SUPPORTED_VERSION_RANGE, KINDS, PERR, PAIR_FAIL,
  now, responseEnvelope, eventEnvelope,
  notificationEnvelope, errorEnvelope, validateEnvelope, validatePayload,
  buildCapabilities, ADVERTISED_OPERATIONS, isDurable,
} from '../protocol/mod.mjs';
import { authorize, UNAUTHENTICATED_OPERATIONS } from '../scopes/mod.mjs';
import { checkTransition, TERMINAL_STATES, recoveryTarget } from '../tasks/mod.mjs';
import { handleTerminalRequest } from '../terminal/mod.mjs';

const TERMINAL_KINDS_SET = new Set(['terminal.exec', 'terminal.cancel']);

/**
 * Operations this server will attempt at all. Everything else is answered
 * with CAPABILITY_UNSUPPORTED before authorization is even consulted, so an
 * unknown operation can never produce a misleading SCOPE_DENIED. Terminal ops
 * are known but their handler refuses them (with an audit record); node.hello
 * is the node-initiated greeting a client may echo.
 */
const KNOWN_OPERATIONS = new Set([...ADVERTISED_OPERATIONS, KINDS.NODE_HELLO, ...TERMINAL_KINDS_SET]);

/** Every protocol ErrorCode, for pass-through decisions in the dispatch catch. */
const KNOWN_ERROR_CODES = new Set(Object.values(PERR));

export function createNodeServer({
  root, p, identity, auth, events, workspace, sessions,
  executorFactory, log = null, uhVersion = '0.3.0', runtimeManager = null,
}) {
  // connectionId -> connection state
  const connections = new Map();
  // taskId -> live task handle (executor + subscribers)
  const liveTasks = new Map();
  // Subscribers for the live event fan-out: every authenticated connection.
  const subscribers = new Set();

  let connectionSeq = 0;

  function info(msg) { log?.info?.(`[node] ${msg}`); }
  function warn(msg) { log?.warn?.(`[node] ${msg}`); }

  // --------------------------------------------------------------- capabilities
  function capabilities() {
    const rm = runtimeManager;
    return buildCapabilities({
      nodeId: identity.nodeId,
      platform: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux',
      architecture: process.arch === 'arm64' ? 'arm64' : 'x64',
      uhVersion,
      dshVersion: rm?.manifest?.dsh?.version ?? null,
      operations: ADVERTISED_OPERATIONS,
      pairingOpen: auth.pairingOpen,
      storage: null,
    });
  }

  // ------------------------------------------------------------------ sessions
  function newId(prefix) {
    return `${prefix}_${randomBytes(16).toString('hex')}`;
  }

  function sessionDirFor(sessionId) {
    return path.join(p.sessions, sessionId);
  }

  // ------------------------------------------------------------ task lifecycle
  /**
   * The only path that changes task state. Validates the transition, commits
   * the new task record AND the durable event as one write-ahead unit, and only
   * then broadcasts. A caller that only wants to broadcast a live frame uses
   * emitLive (no persistence, no eventId).
   */
  function transition(task, toState, { eventKind, eventPayload = {}, reason = null } = {}) {
    const from = task.state;
    const check = checkTransition(from, toState);
    if (!check.ok) {
      return { ok: false, code: check.code, reason: check.reason };
    }
    task.state = toState;
    task.updatedAt = now();

    const event = { kind: eventKind, taskId: task.taskId, sessionId: task.sessionId, projectId: task.projectId, state: toState, ...eventPayload };
    if (reason) event.reason = reason;
    if (!isDurable(event.kind)) {
      // A non-durable kind has no business in the commit path; the caller
      // should have used emitLive. Refuse rather than half-commit.
      return { ok: false, code: 'INVALID_MESSAGE', reason: `event kind "${event.kind}" is not durable` };
    }
    const committed = events.append({ event, task: { ...task } });
    task.lastEventId = committed.id;
    // The durable broadcast carries the eventId assigned at append time.
    broadcast(eventEnvelope(event.kind, { ...event }, committed.id));
    return { ok: true, eventId: committed.id };
  }

  /** Broadcast a live-only frame to every authenticated subscriber. */
  function emitLive(payload) {
    if (isDurable(payload.kind)) {
      warn(`emitLive called with durable kind "${payload.kind}"; ignored`);
      return;
    }
    broadcast(notificationEnvelope(payload.kind, payload));
  }

  function broadcast(env) {
    for (const sub of subscribers) {
      try { sub.send(env); } catch { /* a dead subscriber is dropped on close */ }
    }
  }

  /**
   * Start a task. Returns immediately with the taskId, per PROTOCOL §6: the
   * lifecycle arrives as events. The task runs detached from any connection.
   */
  function startTask({ projectId, sessionId = null, prompt, priority = 'normal' }, connection) {
    const task = {
      taskId: newId('task'),
      projectId,
      sessionId: sessionId || newId('sess'),
      state: 'created',
      createdAt: now(),
      updatedAt: now(),
      lastEventId: 0,
      prompt: prompt || '',
      priority,
    };

    const record = events.tasksSnapshot().find((t) => t.taskId === task.taskId);
    if (record) {
      return { ok: false, code: 'CONFLICT', reason: 'task id collision; retry the request' };
    }

    // created -> queued is the first durable transition; the task record is
    // established durably before any executor is spawned.
    const queued = transition(task, 'queued', { eventKind: 'task.queued' });
    if (!queued.ok) {
      return { ok: false, code: queued.code, reason: queued.reason };
    }

    runTask(task, connection).catch((e) => failTask(task, e));

    return { ok: true, taskId: task.taskId, sessionId: task.sessionId };
  }

  /**
   * Runner failure path. A failed task must never be lost silently: the
   * failure is logged, the durable `failed` transition is attempted, and if
   * even that is rejected the task is left in its current (non-terminal) state
   * — which startup recovery settles deterministically — with the rejection
   * logged. There is no bare catch on this path.
   */
  function failTask(task, err) {
    warn(`task ${task.taskId} runner failed: ${err?.message || err}`);
    liveTasks.delete(task.taskId);
    if (TERMINAL_STATES.has(task.state)) return;
    const settled = transition(task, 'failed', {
      eventKind: 'task.failed',
      reason: `internal error: ${String(err?.message || err).slice(0, 200)}`,
    });
    if (!settled.ok) {
      warn(`task ${task.taskId}: failed-transition rejected (${settled.code}: ${settled.reason}); task remains "${task.state}" for startup recovery`);
    }
  }

  async function runTask(task, connection) {
    const exec = executorFactory();
    const handle = exec.start({
      taskId: task.taskId,
      sessionId: task.sessionId,
      prompt: task.prompt,
      onLive: (payload) => emitLive({ ...payload, taskId: task.taskId, sessionId: task.sessionId }),
      onExit: () => {},
    });

    liveTasks.set(task.taskId, { task, handle, subscribers: new Set(connection ? [connection] : []) });

    // queued -> starting -> running. Each step is a separate durable commit so
    // a crash between them leaves an unambiguous state.
    const starting = transition(task, 'starting', { eventKind: 'task.started', eventPayload: { state: 'starting' } });
    if (!starting.ok) {
      warn(`task ${task.taskId}: starting transition refused (${starting.code}: ${starting.reason}); releasing the executor`);
      await releaseHandle(handle);
      liveTasks.delete(task.taskId);
      return;
    }

    const running = transition(task, 'running', { eventKind: 'task.started', eventPayload: { state: 'running' } });
    if (!running.ok) {
      warn(`task ${task.taskId}: running transition refused (${running.code}: ${running.reason}); releasing the executor`);
      await releaseHandle(handle);
      liveTasks.delete(task.taskId);
      return;
    }

    const info = await handle.done;
    liveTasks.delete(task.taskId);

    // A concurrent cancellation may have settled the task while the executor
    // was in flight; that outcome is already durable and must not be overwritten.
    if (TERMINAL_STATES.has(task.state)) return;

    const cleanExit = info && info.code === 0 && !info.signal && !info.error;
    if (task.state === 'cancelling') {
      const settled = transition(task, 'cancelled', { eventKind: 'task.cancelled', reason: task.cancelReason || 'cancelled by client' });
      if (!settled.ok) warn(`task ${task.taskId}: cancel settlement rejected (${settled.code}: ${settled.reason})`);
      return;
    }
    if (cleanExit) {
      const settled = transition(task, 'completed', { eventKind: 'task.completed', eventPayload: { exitCode: info.code ?? 0 } });
      if (!settled.ok) warn(`task ${task.taskId}: completion transition rejected (${settled.code}: ${settled.reason})`);
    } else {
      const settled = transition(task, 'failed', {
        eventKind: 'task.failed',
        reason: info?.error ? String(info.error.message || info.error).slice(0, 300) : `executor exited code=${info?.code} signal=${info?.signal}`,
        eventPayload: { exitCode: info?.code ?? null },
      });
      if (!settled.ok) warn(`task ${task.taskId}: failure transition rejected (${settled.code}: ${settled.reason})`);
    }
  }

  /** Best-effort executor teardown when the state machine refused the run. */
  async function releaseHandle(handle) {
    try { await handle.cancel({ timeoutMs: 8000 }); } catch (e) { warn(`executor cancel during release failed: ${e?.message || e}`); }
    try { handle.close(); } catch { /* already closed */ }
  }

  /**
   * Commit a state change for a task that has no live runner (restart window).
   * Same durability contract as transition(): one fsynced record carrying the
   * new task state and the event, assigned its eventId at append time.
   */
  function commitRecordState(record, toState, { eventKind, reason = null } = {}) {
    const check = checkTransition(record.state, toState);
    if (!check.ok) return check;
    const task = { ...record, lastEventId: record.lastEventId || 0, state: toState, updatedAt: now() };
    const event = {
      kind: eventKind, taskId: record.taskId, sessionId: record.sessionId,
      projectId: record.projectId, state: toState,
      ...(reason ? { reason } : {}),
    };
    const committed = events.append({ event, task });
    task.lastEventId = committed.id;
    broadcast(eventEnvelope(eventKind, { ...event }, committed.id));
    return { ok: true, eventId: committed.id };
  }

  async function cancelTask(taskId, reason) {
    const live = liveTasks.get(taskId);
    const record = events.taskRecord(taskId);
    if (!live && !record) return { ok: false, code: 'TASK_NOT_FOUND', reason: 'no such task' };
    const task = live ? live.task : null;
    const state = task ? task.state : record.state;
    if (TERMINAL_STATES.has(state)) {
      return { ok: false, code: 'TASK_ALREADY_DONE', reason: `task is ${state}` };
    }
    const why = reason || 'cancel requested';

    // queued/starting -> cancelled is a legal direct transition; no interim
    // 'cancelling' state and no alternate state machine. The state is committed
    // BEFORE the executor is released so the runner observes a terminal state
    // and never races a 'failed' settlement.
    if (state === 'queued' || state === 'starting') {
      const settled = task
        ? transition(task, 'cancelled', { eventKind: 'task.cancelled', reason: why })
        : commitRecordState(record, 'cancelled', { eventKind: 'task.cancelled', reason: `durable cancel: ${why}` });
      if (!settled.ok) return { ok: false, code: settled.code, reason: settled.reason };
      if (live) {
        task.cancelReason = why;
        await releaseHandle(live.handle);
        liveTasks.delete(taskId);
      }
      return { ok: true, taskId, state: 'cancelled' };
    }

    if (!live) {
      // Durable but not live (restart window): the process cannot be signalled,
      // but the cancellation is still recorded durably. A task cannot be left
      // stranded just because its runner is gone.
      if (state === 'cancelling') {
        const settled = commitRecordState(record, 'cancelled', { eventKind: 'task.cancelled', reason: `durable cancel: ${why}` });
        if (!settled.ok) return { ok: false, code: settled.code, reason: settled.reason };
        return { ok: true, taskId, state: 'cancelled' };
      }
      // running/waiting -> cancelling -> cancelled, two durable commits.
      const first = commitRecordState(record, 'cancelling', { eventKind: 'task.waiting', eventPayload: { state: 'cancelling' }, reason: why });
      if (!first.ok) return { ok: false, code: first.code, reason: first.reason };
      const second = commitRecordState({ ...record, state: 'cancelling' }, 'cancelled', { eventKind: 'task.cancelled', reason: `durable cancel: ${why}` });
      if (!second.ok) return { ok: false, code: second.code, reason: second.reason };
      return { ok: true, taskId, state: 'cancelled' };
    }

    const cancelling = transition(task, 'cancelling', { eventKind: 'task.waiting', eventPayload: { state: 'cancelling' }, reason: why });
    if (!cancelling.ok) return { ok: false, code: cancelling.code, reason: cancelling.reason };
    task.cancelReason = why;
    try { await live.handle.cancel({ timeoutMs: 8000 }); } catch (e) { warn(`task ${taskId}: executor cancel failed: ${e?.message || e}`); }
    try { live.handle.close(); } catch { /* already closed */ }
    return { ok: true, taskId, state: 'cancelling' };
  }

  // ------------------------------------------------------------- recovery (§15)
  /**
   * Startup recovery. Rebuilds task truth from the durable log and resolves any
   * task that is still live in the store but whose process is gone. A vanished
   * dsh process is marked failed with a recovery record — never silently
   * completed (brief §15). Tasks whose recovery outcome is "requeue"
   * (created/queued) are re-driven through the executor immediately, so a
   * restart never leaves a durable task stranded without a consumer; if the
   * executor cannot run them, they settle deterministically as failed.
   */
  function recover() {
    const recoveredIds = new Set();
    const tasks = events.tasksSnapshot();
    let resolved = 0;
    const requeued = [];
    for (const record of tasks) {
      if (TERMINAL_STATES.has(record.state)) continue;
      const target = recoveryTarget(record.state);
      recoveredIds.add(record.taskId);
      // Rewrite the durable record to the recovered outcome. This goes through
      // the same append path so the recovery is itself durable and replayable.
      const task = { ...record, lastEventId: record.lastEventId || 0 };
      if (target.state !== record.state) {
        const event = {
          kind: target.outcome === 'requeue' ? 'task.queued' : target.outcome === 'cancel-confirmed' ? 'task.cancelled' : 'task.failed',
          taskId: record.taskId,
          sessionId: record.sessionId,
          projectId: record.projectId,
          state: target.state,
          reason: `recovery: ${target.outcome}`,
        };
        const committed = events.append({ event, task: { ...task, state: target.state, updatedAt: now() } });
        task.lastEventId = committed.id;
        task.state = target.state;
        resolved++;
      }
      if (target.outcome === 'requeue') requeued.push(task);
    }
    if (resolved) info(`recovery resolved ${resolved} interrupted task(s)`);

    // Re-drive requeued tasks. runTask re-runs the normal lifecycle from
    // 'queued'; any failure inside it settles the task as failed via failTask.
    let revived = 0;
    for (const task of requeued) {
      if (!executorFactory) {
        const settled = commitRecordState(task, 'failed', { eventKind: 'task.failed', reason: 'recovery: no executor available on this node' });
        if (!settled.ok) warn(`recovery: could not settle task ${task.taskId} (${settled.code}: ${settled.reason})`);
        continue;
      }
      revived++;
      try {
        runTask(task, null).catch((e) => failTask(task, e));
      } catch (e) {
        failTask(task, e);
      }
    }
    if (revived) info(`recovery re-drove ${revived} queued task(s)`);
    return { resolved, revived, recoveredIds };
  }

  // ------------------------------------------------------------ connections
  function handleConnection(transport) {
    const connectionId = ++connectionSeq;
    const state = {
      id: connectionId,
      transport,
      authenticated: false,
      deviceId: null,
      scopes: [],
      challenge: auth.newChallenge(),
    };
    connections.set(connectionId, state);
    info(`connection ${connectionId} opened (${transport.describe()})`);

    // The node greets first: identity, version range, the operation set it
    // actually serves, and the challenge nonce.
    send(transport, notificationEnvelope(KINDS.NODE_HELLO, {
      nodeId: identity.nodeId,
      protocolVersionRange: SUPPORTED_VERSION_RANGE,
      operations: ADVERTISED_OPERATIONS.slice(),
      challengeB64: state.challenge,
      pairingOpen: auth.pairingOpen,
      uhVersion,
      dshVersion: runtimeManager?.manifest?.dsh?.version ?? null,
    }));

    transport.onMessage((env) => onMessage(state, env));
    transport.onClose((reason) => {
      connections.delete(connectionId);
      subscribers.delete(transport);
      info(`connection ${connectionId} closed (${String(reason).slice(0, 120)})`);
      // Intentionally NOT cancelling the client's tasks (brief §8).
    });
    transport.onError((e) => warn(`connection ${connectionId} transport error: ${e?.message || e}`));

    return connectionId;
  }

  function send(transport, env) {
    try { transport.send(env); } catch (e) { warn(`send failed: ${e?.message || e}`); }
  }

  async function onMessage(state, env) {
    const { transport } = state;
    const envCheck = validateEnvelope(env);
    if (!envCheck.ok) {
      // The version-mismatch failure carries the node's supportedRange so a
      // client can report what it must implement; nothing else is exposed.
      send(transport, errorEnvelope(env?.requestId || null, envCheck.code || PERR.INVALID_MESSAGE, envCheck.error,
        { detail: envCheck.detail ? JSON.stringify(envCheck.detail) : null }));
      return;
    }
    // Clients speak only requests. A response/event/error envelope arriving on
    // a client connection is request forgery, not protocol.
    if (env.type !== 'request') {
      send(transport, errorEnvelope(env.requestId, PERR.INVALID_MESSAGE, `client messages must be of type "request", received "${env.type}"`));
      return;
    }
    const kind = env.payload?.kind;

    // Handshake operations bypass authentication by design.
    if (!UNAUTHENTICATED_OPERATIONS.has(kind)) {
      if (!state.authenticated) {
        send(transport, errorEnvelope(env.requestId, PERR.AUTH_REQUIRED, 'authenticate with auth.connect first'));
        return;
      }
      // An unknown operation is a capability question, not an authorization
      // one — it must never surface as SCOPE_DENIED.
      if (!KNOWN_OPERATIONS.has(kind)) {
        send(transport, errorEnvelope(env.requestId, PERR.CAPABILITY_UNSUPPORTED, `operation "${kind}" is not implemented by this node`));
        return;
      }
      const decision = authorize(kind, state.scopes);
      if (!decision.allowed) {
        send(transport, errorEnvelope(env.requestId, PERR.SCOPE_DENIED, `operation "${kind}" is not permitted for this device`, { detail: decision.reason, data: { scope: decision.scope } }));
        return;
      }
    } else if (!KNOWN_OPERATIONS.has(kind)) {
      send(transport, errorEnvelope(env.requestId, PERR.CAPABILITY_UNSUPPORTED, `operation "${kind}" is not implemented by this node`));
      return;
    }

    // Payload schema validation before any handler runs: malformed payloads
    // are rejected deterministically and never reach operation logic. The one
    // exception is node.hello, whose greeting shape is node-authored; client
    // copies are advisory echoes with no handler-observable fields.
    if (kind !== KINDS.NODE_HELLO) {
      const payloadCheck = validatePayload(kind, env.type, env.payload);
      if (!payloadCheck.ok) {
        send(transport, errorEnvelope(env.requestId, PERR.INVALID_MESSAGE, payloadCheck.error));
        return;
      }
    }

    try {
      await dispatch(state, env, kind);
    } catch (e) {
      // Only protocol error codes pass through to the client; unexpected
      // exceptions (including raw fs errno errors) become INTERNAL_ERROR with
      // a non-revealing message, the real cause going to the node log.
      const known = e?.apiCode && KNOWN_ERROR_CODES.has(e.apiCode);
      const code = known ? e.apiCode : PERR.INTERNAL_ERROR;
      const message = known ? (e?.message || 'request failed') : 'internal error';
      warn(`dispatch ${kind} failed: ${e?.message || e}`);
      send(transport, errorEnvelope(env.requestId, code, message));
    }
  }

  async function dispatch(state, envelope, kind) {
    const { transport } = state;
    const requestId = envelope.requestId;
    const payload = envelope.payload || {};

    switch (kind) {
      case KINDS.NODE_HELLO: {
        // A client may also send node.hello to declare its capabilities.
        send(transport, responseEnvelope(requestId, KINDS.NODE_HELLO, {
          nodeId: identity.nodeId,
          protocolVersionRange: SUPPORTED_VERSION_RANGE,
          operations: ADVERTISED_OPERATIONS.slice(),
          challengeB64: state.challenge,
          pairingOpen: auth.pairingOpen,
        }));
        return;
      }

      case KINDS.AUTH_CONNECT: {
        const result = auth.verifyChallenge({ deviceId: payload.deviceId, sigB64: payload.sigB64, challenge: state.challenge });
        if (!result.ok) {
          send(transport, errorEnvelope(requestId, mapPairFailure(result.code), mapPairFailureMessage(result.code)));
          return;
        }
        // The nonce is single-use: once it has authenticated this connection it
        // can never sign another one, even captured in transit on this wire.
        state.challenge = null;
        state.authenticated = true;
        state.deviceId = result.record.deviceId;
        state.scopes = result.record.scopes.slice();
        subscribers.add(transport);
        auth.touchDevice(state.deviceId);
        send(transport, responseEnvelope(requestId, KINDS.AUTH_CONNECT, {
          deviceId: state.deviceId,
          grantedScopes: state.scopes,
          protocolVersion: PROTOCOL_VERSION,
        }));
        info(`connection ${state.id} authenticated as ${state.deviceId} scopes=[${state.scopes.join(',')}]`);
        return;
      }

      case KINDS.DEVICE_PAIR: {
        const result = auth.pair({
          deviceName: payload.deviceName,
          platform: payload.platform,
          devicePublicKeyPem: payload.devicePublicKeyPem,
          expectedNodeIdentitySha256: payload.expectedNodeIdentitySha256,
          sigB64: payload.sigB64,
          challenge: state.challenge,
          requestedScopes: payload.requestedScopes,
          token: payload.pairingToken,
        });
        if (!result.ok) {
          send(transport, errorEnvelope(requestId, mapPairFailure(result.code), mapPairFailureMessage(result.code)));
          return;
        }
        state.authenticated = true;
        state.deviceId = result.deviceId;
        state.scopes = result.grantedScopes;
        subscribers.add(transport);
        const nodeSigB64 = payload.clientChallengeB64 ? identity.sign(payload.clientChallengeB64).toString('base64') : undefined;
        send(transport, responseEnvelope(requestId, KINDS.DEVICE_PAIR, {
          deviceId: result.deviceId,
          sigB64: identity.sign(state.challenge).toString('base64'),
          nodeSigB64,
          grantedScopes: result.grantedScopes,
          requestedScopes: payload.requestedScopes || [],
        }));
        state.challenge = null; // the nonce is burned with the connection's handshake
        info(`paired device ${result.deviceId} over connection ${state.id}`);
        return;
      }

      case KINDS.SESSION_REPLAY: {
        const cursor = Number.isInteger(payload.lastEventId) ? payload.lastEventId : 0;
        const deviceId = payload.deviceId || state.deviceId;
        const replay = events.replay(cursor, { limit: 1000 });
        let snapshot = null;
        if (replay.unavailable) {
          snapshot = events.snapshot({ nodeId: identity.nodeId, recoveredTaskIds: new Set() });
        }
        send(transport, responseEnvelope(requestId, KINDS.SESSION_REPLAY, {
          events: replay.events,
          truncated: replay.truncated,
          nextCursor: replay.nextCursor,
          unavailable: replay.unavailable,
          snapshot,
        }));
        return;
      }

      case KINDS.TASK_START: {
        const started = startTask({
          projectId: payload.projectId,
          sessionId: payload.sessionId,
          prompt: payload.prompt,
          priority: payload.priority,
        }, state);
        if (!started.ok) {
          send(transport, errorEnvelope(requestId, started.code, started.reason));
          return;
        }
        send(transport, responseEnvelope(requestId, KINDS.TASK_START, { taskId: started.taskId, sessionId: started.sessionId, state: 'queued' }));
        return;
      }

      case KINDS.TASK_CANCEL: {
        const result = await cancelTask(payload.taskId, payload.reason);
        if (!result.ok) {
          send(transport, errorEnvelope(requestId, result.code, result.reason));
          return;
        }
        send(transport, responseEnvelope(requestId, KINDS.TASK_CANCEL, { taskId: result.taskId, state: result.state }));
        return;
      }

      case KINDS.TASK_LIST: {
        const tasks = events.tasksSnapshot().map((t) => ({
          taskId: t.taskId, state: t.state, sessionId: t.sessionId || undefined, projectId: t.projectId,
        }));
        send(transport, responseEnvelope(requestId, KINDS.TASK_LIST, { tasks }));
        return;
      }

      case KINDS.TASK_HISTORY: {
        const replay = events.replay(0, { limit: 1000 });
        const filtered = replay.events.filter((e) => e.payload?.taskId === payload.taskId);
        send(transport, responseEnvelope(requestId, KINDS.TASK_HISTORY, { taskId: payload.taskId, events: filtered }));
        return;
      }

      case KINDS.PROJECT_LIST: {
        const projects = workspace.listProjects();
        send(transport, responseEnvelope(requestId, KINDS.PROJECT_LIST, { projects }));
        return;
      }

      case KINDS.PROJECT_CREATE: {
        const created = workspace.createProject({ name: payload.name, path: payload.path });
        send(transport, responseEnvelope(requestId, KINDS.PROJECT_CREATE, { projectId: created.projectId, name: created.name, workspacePath: created.workspacePath }));
        return;
      }

      case KINDS.PROJECT_OPEN: {
        const opened = workspace.openProject(payload.projectId);
        if (!opened.ok) {
          send(transport, errorEnvelope(requestId, opened.code, opened.reason));
          return;
        }
        send(transport, responseEnvelope(requestId, KINDS.PROJECT_OPEN, { projectId: opened.projectId, workspacePath: opened.workspacePath, name: opened.name }));
        return;
      }

      case KINDS.FILE_BROWSE: {
        const result = workspace.browse({ projectId: payload.projectId, path: payload.path });
        send(transport, responseEnvelope(requestId, KINDS.FILE_BROWSE, result));
        return;
      }

      case KINDS.FILE_READ: {
        const result = workspace.read({ projectId: payload.projectId, path: payload.path });
        send(transport, responseEnvelope(requestId, KINDS.FILE_READ, result));
        return;
      }

      case KINDS.FILE_WRITE: {
        const result = workspace.write({ projectId: payload.projectId, path: payload.path, content: payload.content, baseHash: payload.baseHash, overwrite: payload.overwrite });
        send(transport, responseEnvelope(requestId, KINDS.FILE_WRITE, result));
        return;
      }

      case KINDS.DEVICE_LIST: {
        const devices = auth.listDevices();
        send(transport, responseEnvelope(requestId, KINDS.DEVICE_LIST, { devices }));
        return;
      }

      case KINDS.DEVICE_REVOKE: {
        const result = auth.revokeDevice(payload.deviceId, { forget: !!payload.forget });
        if (!result.ok) {
          send(transport, errorEnvelope(requestId, result.code, result.reason || 'no such device'));
          return;
        }
        send(transport, responseEnvelope(requestId, KINDS.DEVICE_REVOKE, { deviceId: payload.deviceId, status: result.status }));
        return;
      }

      case KINDS.DIAGNOSTICS_RUN: {
        send(transport, responseEnvelope(requestId, KINDS.DIAGNOSTICS_RUN, { checks: [] }));
        return;
      }

      default: {
        if (TERMINAL_KINDS_SET.has(kind)) {
          const refused = handleTerminalRequest({ kind, audit: () => info(`terminal ${kind} refused`) });
          send(transport, errorEnvelope(requestId, refused.code, refused.message, { detail: refused.detail }));
          return;
        }
        send(transport, errorEnvelope(requestId, PERR.CAPABILITY_UNSUPPORTED, `operation "${kind}" is not implemented by this node`));
        return;
      }
    }
  }

  return {
    handleConnection,
    recover,
    capabilities,
    startTask,
    cancelTask,
    get connections() { return connections.size; },
    get liveTaskCount() { return liveTasks.size; },
    get subscriberCount() { return subscribers.size; },
    describe() {
      return {
        nodeId: identity.nodeId,
        connections: connections.size,
        liveTasks: liveTasks.size,
        subscribers: subscribers.size,
        eventHead: events.getHead(),
      };
    },
  };
}

function mapPairFailure(code) {
  switch (code) {
    case PAIR_FAIL.TOKEN_EXPIRED: return PERR.PAIRING_EXPIRED;
    case PAIR_FAIL.TOKEN_CONSUMED: return PERR.PAIRING_CONSUMED;
    case PAIR_FAIL.NODE_IDENTITY_MISMATCH: return PERR.AUTH_FAILED;
    case PAIR_FAIL.CHALLENGE_FAILED: return PERR.CHALLENGE_FAILED;
    case 'DEVICE_REVOKED': return PERR.DEVICE_REVOKED;
    default: return PERR.AUTH_FAILED;
  }
}

function mapPairFailureMessage(code) {
  switch (code) {
    case PAIR_FAIL.TOKEN_EXPIRED: return 'The pairing token has expired. Generate a new one on the node.';
    case PAIR_FAIL.TOKEN_CONSUMED: return 'The pairing token has already been used. Generate a new one on the node.';
    case PAIR_FAIL.NODE_IDENTITY_MISMATCH: return 'The node identity does not match the identity bound to this pairing token.';
    case PAIR_FAIL.CHALLENGE_FAILED: return 'Authentication failed.';
    case 'DEVICE_REVOKED': return 'This device has been revoked by the node.';
    default: return 'Authentication failed.';
  }
}
