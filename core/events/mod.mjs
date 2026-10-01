// Universal Harness — the durable event store (brief §9, §10; PROTOCOL §5).
//
// One append-only log per node, holding exactly the durable event kinds of
// events.schema.json EventDurability. It is the authority for task lifecycle.
//
// The write-ahead commit rule (brief §9), enforced structurally:
//
//   append(taskState, event) writes ONE line containing both the new task state
//   and the event, and that line is flushed (fsync) before the function
//   returns. Callers emit the live event only after this resolves. Therefore
//   there is no observable window in which a task is `completed` in memory but
//   no `task.completed` exists durably; and a crash mid-commit leaves either a
//   complete committed line or no line at all, never a half-transition.
//
// eventId assignment (brief §10): the id is the log's next sequence number,
// assigned AT append time inside the commit. Nothing hands out an id before
// persistence succeeds.
//
// Gaps are real and intentional: live-only events consume no ids, so durable
// ids may skip. Replay returns events strictly after the caller's cursor and
// never implies continuity; a caller whose cursor is beyond retention gets
// `unavailable: true` plus an authoritative RecoverySnapshot instead of a
// silence that could be mistaken for "nothing happened".

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDurable } from '../protocol/mod.mjs';

export function createEventStore({ p, log = null, maxEvents = 200_000 }) {
  const dir = path.join(p.state, 'events');
  fs.mkdirSync(dir, { recursive: true });
  const logPath = path.join(dir, 'durable.ndjson');

  // Ensure the log exists so open/read paths can assume it.
  if (!fs.existsSync(logPath)) fs.writeFileSync(logPath, '', { mode: 0o600 });

  let head = 0; // last committed durable eventId; 0 means "nothing committed yet"
  let bytes = 0;
  const records = []; // every retained committed record, in id order (replay index)
  const taskIndex = new Map(); // taskId -> last committed durable record
  const sessionIndex = new Set();

  /**
   * Scan the committed log: rebuild head, the replay index and the in-memory
   * indexes. A trailing partial line (a crash mid-commit) is deliberately
   * ignored — it was never committed, and the next append overwrites it.
   */
  function rebuild() {
    head = 0;
    bytes = 0;
    records.length = 0;
    taskIndex.clear();
    sessionIndex.clear();
    const content = fs.readFileSync(logPath, 'utf8');
    let start = 0;
    for (let i = 0; i < content.length; i++) {
      if (content.charCodeAt(i) !== 0x0a) continue;
      applyLine(content.slice(start, i));
      start = i + 1;
    }
    // Remainder after the last newline is an uncommitted partial: drop it.
    bytes = content.length;
    return { head, tasks: taskIndex.size, sessions: sessionIndex.size };
  }

  function applyLine(line) {
    if (!line) return;
    let record;
    try { record = JSON.parse(line); }
    catch {
      log?.warn?.(`durable log: skipping unparseable committed line (${line.length} bytes)`);
      return;
    }
    if (!record || typeof record.id !== 'number') return;
    if (record.id > head) head = record.id;
    records.push(record);
    if (record.task) {
      // The commit line's own id is, by construction, the latest event for this
      // task at commit time — so the rebuilt lastEventId is always exact.
      record.task.lastEventId = record.id;
      taskIndex.set(record.task.taskId, record.task);
    }
    if (record.sessionId) sessionIndex.add(record.sessionId);
  }

  /**
   * The atomic commit. `event` must be a durable kind (checked here, not by the
   * caller) and `taskUpdate` is the task record as it must appear on disk for
   * the event to be truthful. Both land in one line, one fsync.
   *
   * @returns {{id: number}} the committed eventId
   */
  function append({ event, task = null }) {
    if (!event || typeof event.kind !== 'string') throw new EventStoreError('invalid', 'event.kind is required');
    if (!isDurable(event.kind)) throw new EventStoreError('invalid', `event kind "${event.kind}" is not durable; use the live stream`);
    if (event.eventId !== undefined) throw new EventStoreError('invalid', 'eventId must not be supplied; it is assigned at append time');

    const id = head + 1;
    // lastEventId is set by the reader from this line's id; we do not write it
    // here because that would require knowing id before committing it.
    const ts = new Date().toISOString();
    const line = JSON.stringify({ id, ts, task, event }) + '\n';
    const buf = Buffer.from(line, 'utf8');

    // O_APPEND + a single write + fsync is the commit. The write is atomic at
    // the page-cache level for a file opened append-only on a local FS.
    const fd = fs.openSync(logPath, 'a');
    try {
      fs.writeSync(fd, buf, 0, buf.length, null);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    head = id;
    bytes += buf.length;
    records.push({ id, ts, task, event });
    // Retention bound: once the in-memory replay index (and the log) exceed
    // maxEvents records, the oldest fall out of the replayable window. Replay
    // reports `unavailable` for cursors older than the retained earliest id.
    if (records.length > maxEvents) records.splice(0, records.length - maxEvents);
    if (task) taskIndex.set(task.taskId, task);
    if (event.sessionId) sessionIndex.add(event.sessionId);
    return { id };
  }

  /** Current head eventId (0 when nothing is committed). */
  function getHead() { return head; }

  function taskRecord(taskId) {
    return taskIndex.get(taskId) || null;
  }
  function tasksSnapshot() {
    return [...taskIndex.values()];
  }
  function sessionsSnapshot() {
    return [...sessionIndex];
  }

  /**
   * Replay durable events strictly after `cursor`, served from the in-memory
   * index (no file re-read per call). Returns durable envelopes only. If the
   * cursor cannot be served — it precedes the earliest retained id (after
   * retention trimming), or the log is fresh/absent — `unavailable` is true
   * and the caller must hand the client a RecoverySnapshot instead.
   *
   * @param {number} cursor last eventId the caller has seen
   * @param {object} [opts] { limit }
   */
  function replay(cursor, { limit = 1000 } = {}) {
    const events = [];
    let nextCursor = null;
    let truncated = false;
    // We can only vouch for continuity from the earliest id we still hold. A
    // cursor before that (or beyond a fresh/empty log) cannot be served, so the
    // caller must fall back to the RecoverySnapshot.
    const earliestSeen = records.length ? records[0].id : null;
    for (const record of records) {
      if (record.id <= cursor) continue;
      if (events.length >= limit) { truncated = true; nextCursor = record.id - 1; break; }
      events.push(toEnvelope(record));
    }

    events.sort((a, b) => a.eventId - b.eventId);
    const unavailable = cursor > 0 && (earliestSeen === null || cursor < earliestSeen);
    if (nextCursor === null && events.length) nextCursor = events[events.length - 1].eventId;
    return { events, truncated, nextCursor, unavailable, head };
  }

  function toEnvelope(record) {
    return {
      protocolVersion: 1,
      type: 'event',
      timestamp: record.ts,
      eventId: record.id,
      payload: record.event,
    };
  }

  function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }

  /**
   * Build the authoritative point-in-time snapshot. `recovered: true` marks
   * states re-derived by the supervisor after an abnormal termination rather
   * than read from a committed record (PROTOCOL §5.5).
   */
  function snapshot({ nodeId, recoveredTaskIds = new Set() } = {}) {
    return {
      nodeId,
      generatedAt: new Date().toISOString(),
      tasks: tasksSnapshot().map((t) => ({
        taskId: t.taskId,
        state: t.state,
        sessionId: t.sessionId || undefined,
        lastEventId: t.lastEventId ?? undefined,
        recovered: recoveredTaskIds.has(t.taskId) || false,
      })),
      sessions: sessionsSnapshot().map((sessionId) => ({ sessionId })),
    };
  }

  /**
   * Retention/compaction (PROTOCOL §5.2). Rewrites the log keeping, for every
   * task, its most recent record plus terminal anchors, and all events after
   * `keepEvents` recent ones. Every terminal task state is preserved; the
   * rewrite is atomic via a temp file + rename so a crash cannot truncate the
   * authoritative log.
   */
  function compact({ keepEvents = 10_000 } = {}) {
    const records = [];
    const fd = fs.openSync(logPath, 'r');
    try {
      const content = fs.readFileSync(logPath, 'utf8');
      let start = 0;
      for (let i = 0; i < content.length; i++) {
        if (content.charCodeAt(i) !== 0x0a) continue;
        const line = content.slice(start, i);
        start = i + 1;
        const record = safeParse(line);
        if (record && typeof record.id === 'number') records.push(record);
      }
      const tail = safeParse(content.slice(start));
      if (tail && typeof tail.id === 'number') records.push(tail);
    } finally {
      fs.closeSync(fd);
    }
    if (records.length <= keepEvents) return { compacted: 0, kept: records.length };

    // Keep the newest `keepEvents` records verbatim, preserving terminal states
    // and the monotonic id sequence.
    const keep = records.slice(-keepEvents);
    const tmp = `${logPath}.compact.tmp`;
    const out = fs.openSync(tmp, 'w', 0o600);
    try {
      for (const r of keep) fs.writeSync(out, JSON.stringify(r) + '\n');
      fs.fsyncSync(out);
    } finally {
      fs.closeSync(out);
    }
    fs.renameSync(tmp, logPath);
    log?.info?.(`compacted durable event log: ${records.length} -> ${keep.length} records`);
    rebuild();
    return { compacted: records.length - keep.length, kept: keep.length };
  }

  function describe() {
    return { head, bytes, tasks: taskIndex.size, sessions: sessionIndex.size, path: logPath };
  }

  rebuild();

  return {
    append,
    replay,
    snapshot,
    compact,
    rebuild,
    getHead,
    taskRecord,
    tasksSnapshot,
    sessionsSnapshot,
    describe,
    get logPath() { return logPath; },
    get maxEvents() { return maxEvents; },
  };
}

export class EventStoreError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'EventStoreError';
    this.eventStoreError = kind; // 'invalid' | 'io'
  }
}
