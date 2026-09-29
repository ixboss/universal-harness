// Desktop-side session discovery and replay.
//
// Boundary (spec §7): dsh owns its session internals; Universal Harness owns
// orchestration metadata only. So this module *reads* dsh's session store
// (it never writes to it) to:
//   - discover sessions for a workspace by their authoritative header cwd;
//   - associate them with UH workspace/project records;
//   - detect incomplete sessions (a turn that never reached turn/end);
//   - replay durable events for restart/recovery and future remote clients.
//
// Session store layout (observed on dsh 0.2.0-rc.2, Windows):
//   $DSH_HOME/sessions/<workspace-mangled-name>/<sessionId>/session.v4.jsonl.zstd
// Each log is a sequence of concatenated Zstandard frames; frame 0 is the
// immutable SessionHeader ({type:"session", version, id, createdAt, cwd, ...})
// and later frames hold JSONL event lines with monotonic `seq`. We locate
// sessions by reading the header's `cwd` rather than reverse-engineering the
// directory mangling, so discovery stays correct if dsh changes the scheme.

import fs from 'node:fs';
import path from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { ensureDir } from '../paths/mod.mjs';
import { UhError, ERR } from '../errors/mod.mjs';

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]); // little-endian 0xFD2FB528

/**
 * Split a concatenated-zstd blob into its frames and decompress each.
 *
 * @param {Buffer} buf raw session file bytes
 * @returns {string[]} decompressed text of every frame, in order
 */
export function decompressSessionBlob(buf) {
  const frames = [];
  let start = 0;
  for (let i = ZSTD_MAGIC.length; i <= buf.length - ZSTD_MAGIC.length; i++) {
    if (buf.subarray(i, i + ZSTD_MAGIC.length).equals(ZSTD_MAGIC)) {
      frames.push(buf.subarray(start, i));
      start = i;
    }
  }
  frames.push(buf.subarray(start));
  const out = [];
  for (const frame of frames) {
    if (frame.length === 0) continue;
    try {
      out.push(zstdDecompressSync(frame).toString('utf8'));
    } catch {
      // A trailing partial frame means the session was being written when we
      // read it; report what we could recover rather than failing the scan.
      out.push('');
    }
  }
  return out;
}

/** Parse a session log file into its JSONL lines (objects). */
export function readSessionLog(logFile) {
  const buf = fs.readFileSync(logFile);
  let text;
  if (/\.zstd$/.test(logFile)) {
    text = decompressSessionBlob(buf).join('');
  } else {
    text = buf.toString('utf8');
  }
  const lines = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { lines.push(JSON.parse(trimmed)); }
    catch { /* skip unparseable tail; see decompressSessionBlob */ }
  }
  return lines;
}

/** Read only the immutable SessionHeader of a session log (cheap: first frame). */
export function readSessionHeader(logFile) {
  const buf = fs.readFileSync(logFile);
  if (!/\.zstd$/.test(logFile)) {
    const first = buf.toString('utf8').split('\n')[0];
    return first ? JSON.parse(first) : null;
  }
  // First frame only: find the second magic (or end of file).
  let end = buf.length;
  for (let i = ZSTD_MAGIC.length; i <= buf.length - ZSTD_MAGIC.length; i++) {
    if (buf.subarray(i, i + ZSTD_MAGIC.length).equals(ZSTD_MAGIC)) { end = i; break; }
  }
  const header = zstdDecompressSync(buf.subarray(0, end)).toString('utf8').split('\n').filter(Boolean)[0];
  return header ? JSON.parse(header) : null;
}

/**
 * Summarize one parsed session: event counts, turn state, completeness.
 *
 * A session is *incomplete* when a turn started but never ended — the process
 * died mid-turn (crash, kill, power loss). Turn ends carry a reason; an error
 * reason is still a settled turn (the harness recorded the failure), so it is
 * not "incomplete".
 *
 * @param {Object[]} events parsed log lines
 * @returns {Object} summary
 */
export function summarizeSession(events) {
  const header = events.find((e) => e?.type === 'session') || null;
  const body = events.filter((e) => e?.type !== 'session');
  let maxSeq = -1;
  const types = {};
  const turns = [];
  let lastTurnStart = null;
  let lastTurnEnd = null;
  for (const e of body) {
    if (typeof e.seq === 'number' && e.seq > maxSeq) maxSeq = e.seq;
    types[e.type] = (types[e.type] || 0) + 1;
    if (e.type === 'turn/start') lastTurnStart = e;
    if (e.type === 'turn/end') { lastTurnEnd = e; turns.push({ turn: e?.data?.turn, reason: e?.data?.reason?.kind }); }
  }
  const openTurn = !!lastTurnStart && (!lastTurnEnd || (lastTurnStart?.data?.turn ?? -1) > (lastTurnEnd?.data?.turn ?? -1));
  return {
    header,
    eventCount: body.length,
    lastSeq: maxSeq,
    types,
    turns,
    lastTurnStart,
    lastTurnEnd,
    incomplete: openTurn,
  };
}

/**
 * @param {Object} opts
 * @param {string} opts.dshHome $DSSH_HOME (sessions live under sessions/)
 * @param {Object} [opts.log]
 */
export function createSessionStore({ dshHome, log = consoleShim() }) {
  const sessionsDir = path.join(dshHome, 'sessions');

  function sessionLogFiles() {
    if (!fs.existsSync(sessionsDir)) return [];
    const files = [];
    for (const wsDir of fs.readdirSync(sessionsDir, { withFileTypes: true })) {
      if (!wsDir.isDirectory()) continue;
      const wsPath = path.join(sessionsDir, wsDir.name);
      for (const sDir of fs.readdirSync(wsPath, { withFileTypes: true })) {
        if (!sDir.isDirectory()) continue;
        const sPath = path.join(wsPath, sDir.name);
        for (const name of fs.readdirSync(sPath)) {
          if (/^session\..*\.jsonl(\.zstd)?$/.test(name)) files.push(path.join(sPath, name));
        }
      }
    }
    return files;
  }

  /** Index every session by its authoritative header cwd. */
  function list({ cwd } = {}) {
    const out = [];
    for (const logFile of sessionLogFiles()) {
      let summary;
      try { summary = summarizeSession(readSessionLog(logFile)); }
      catch (e) { log.debug('unreadable session log', { file: path.basename(logFile), err: e.message }); continue; }
      if (!summary.header) continue;
      const st = fs.statSync(logFile);
      const sessionCwd = summary.header.cwd;
      if (cwd && !pathsEqual(sessionCwd, cwd)) continue;
      out.push({
        id: String(summary.header.id || path.basename(path.dirname(logFile))),
        createdAt: summary.header.createdAt,
        cwd: sessionCwd,
        formatVersion: summary.header.version,
        isSeeded: !!summary.header.isSeeded,
        logFile,
        size: st.size,
        modifiedAt: st.mtimeMs,
        eventCount: summary.eventCount,
        lastSeq: summary.lastSeq,
        turnCount: summary.turns.length,
        incomplete: summary.incomplete,
        types: summary.types,
      });
    }
    out.sort((a, b) => (b.modifiedAt || 0) - (a.modifiedAt || 0));
    return out;
  }

  /**
   * Replay one session's durable events in seq order.
   *
   * @param {string} id session id
   * @returns {Object[]} events
   */
  function replay(id) {
    const all = list();
    const found = all.find((s) => s.id === String(id));
    if (!found) throw new UhError(ERR.SESSION_NOT_FOUND,
      `no dsh session with id ${id} under ${path.basename(dshHome)}`,
      { dshHome: path.basename(dshHome) },
      'List sessions with `uh session list`; the id is the dsh session id shown there.');
    return readSessionLog(found.logFile).filter((e) => e?.type !== 'session');
  }

  /** Find sessions whose workspace cwd is (or is under) a UH workspace root. */
  function forWorkspace(root) {
    return list().filter((s) => pathEqualsOrUnder(s.cwd, root));
  }

  return { list, replay, forWorkspace, sessionLogFiles, sessionsDir };
}

function pathsEqual(a, b) {
  if (!a || !b) return false;
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}
function pathEqualsOrUnder(child, parent) {
  const c = path.resolve(child).toLowerCase();
  const p = path.resolve(parent).toLowerCase();
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

function consoleShim() { return { info() {}, warn() {}, debug() {}, error() {} }; }

// ---------------------------------------------------------------------------
// Universal Harness session index (orchestration metadata only).
//
// dsh owns session internals; UH owns the association a remote client needs:
// which sessions belong to this workspace, and which session continues which.
// The index records lineage because the SDK JSON-RPC seam cannot reopen a
// persisted session in a new process (upstream exposes agents.resume but the
// sdk server wires only create — see docs/AUDIT.md), so a continuation runs
// under a new dsh session id linked back to the prior one here.
//

const INDEX_SCHEMA = 1;

/**
 * @param {Object} opts { p } portable paths
 */
export function createSessionIndex({ p }) {
  const indexDir = path.join(p.data, 'sessions');
  const indexPath = path.join(indexDir, 'index.json');
  ensureDir(indexDir);

  function load() {
    if (!fs.existsSync(indexPath)) return { schemaVersion: INDEX_SCHEMA, sessions: [] };
    try {
      const raw = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
      if (raw.schemaVersion !== INDEX_SCHEMA) throw new Error('unsupported index schema');
      return raw;
    } catch { return { schemaVersion: INDEX_SCHEMA, sessions: [] }; }
  }

  function save(index) {
    index.updatedAt = Date.now();
    const tmp = `${indexPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(index, null, 2));
    fs.renameSync(tmp, indexPath);
  }

  /**
   * Record a session (creating or updating by dsh session id).
   *
   * @param {Object} entry { id, workspaceId?, priorSessionId?, label?, status? }
   */
  function record(entry) {
    const index = load();
    let rec = index.sessions.find((s) => s.id === entry.id);
    if (!rec) {
      rec = { id: entry.id, createdAt: Date.now() };
      index.sessions.push(rec);
    }
    Object.assign(rec, {
      workspaceId: entry.workspaceId ?? rec.workspaceId ?? null,
      priorSessionId: entry.priorSessionId ?? rec.priorSessionId ?? null,
      label: entry.label ?? rec.label ?? null,
      status: entry.status ?? rec.status ?? 'open',
      updatedAt: Date.now(),
    });
    save(index);
    return rec;
  }

  function get(id) { return load().sessions.find((s) => s.id === id) || null; }
  function list() { return load().sessions; }

  return { record, get, list, indexPath };
}
