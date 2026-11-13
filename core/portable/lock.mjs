// Advisory workspace lock (ARCHITECTURE §10; RISK-REGISTER R-05).
//
// A lock is a single JSON file in the portable tree. It exists so two nodes
// never mutate one workspace at the same time — and, just as importantly, so a
// lock left behind by a crashed process is **never** silently taken over on a
// guess.
//
// ---------------------------------------------------------------------------
// Reclaim policy — deliberately conservative
// ---------------------------------------------------------------------------
// A lock is reclaimed ONLY when the previous holder is *provably* gone:
//
//   (a) the machine rebooted since the lock was taken — the recorded boot id
//       (authoritative, from /proc on Linux) differs from the current one; or
//   (b) the recorded process id is alive but belongs to a *different* process
//       than the one that took the lock — the process start time differs, which
//       is exactly what PID reuse looks like.
//
// Everything else FAILS CLOSED. In particular:
//
//   * age, elapsed time, and timeouts are never used to reclaim a lock — an old
//     lock file says nothing about whether its holder is still running;
//   * a bare PID number is never enough — the PID may have been reused by an
//     unrelated process, so "the PID is gone" is not sound evidence;
//   * a lock naming a *different host* is never reclaimed here at all — the
//     other machine may be using the drive right now.
//
// When ownership or liveness cannot be established safely (no boot id, no
// readable process start time — which is the normal case on Windows and macOS),
// acquisition throws with a code and an actionable recovery procedure
// ({@link describeLock}); the operator decides, the code does not guess.
//
// ---------------------------------------------------------------------------
// Concurrency model — a reclaim guard, never a rename
// ---------------------------------------------------------------------------
// Acquisition is decided by one atomic operation: `open(lockPath, 'wx')`. Exactly
// one process wins that create; every other process sees EEXIST and must then
// decide whether the record it found is still live.
//
// Reclaiming a stale record is the delicate part, so it is serialized by an
// exclusive *guard* file (`<lock>.reclaim`, itself created with `wx`): at most
// one reclaimer is ever active. While the guard is held, the classified record
// cannot change — its holder is provably dead so it cannot release, no other
// reclaimer may act, and no new acquirer can create the lock while the record is
// still present. The reclaimer therefore removes the lock with a plain `unlink`
// of the *exact* record it classified, and only after confirming the on-disk
// lockId still matches.
//
// This replaces an earlier rename-based scheme (rename the lock aside to a name
// derived from the classified lock id, re-verify, then delete). That scheme was
// unsafe in two ways, both eliminated here by never moving a record that was not
// classified:
//
//   * the rename momentarily *vacated* `lockPath`, so a third acquirer could take
//     the lock while the displaced holder still believed it held it — two live
//     holders at once; and
//   * the aside name was shared by every reclaimer of the same record, so a
//     second reclaimer could overwrite (and then delete) the first reclaimer's
//     parked record between its identity check and its unlink.
//
// There is now no aside file and no "restore" step, so a record the reclaimer did
// not classify is never moved and never deleted. If the guard cannot be created
// — another reclaimer is active, or a reclaimer crashed while holding it —
// acquisition FAILS CLOSED with a recovery procedure rather than reclaiming
// unsafely. A stale guard is therefore a denial that needs explicit operator
// recovery; it is never a silent double-holder.
//
// No dsh knowledge; no protocol knowledge.

import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';

/** On-disk lock record version. */
export const LOCK_SCHEMA = 1;

/**
 * Suffix of the reclaim-guard file that serializes stale-lock recovery. It sits
 * next to the lock so it lives on the same filesystem, and it is created with
 * `wx` so exactly one reclaimer can ever hold it.
 */
export const RECLAIM_GUARD_SUFFIX = '.reclaim';

/**
 * Lock failure codes. `WORKSPACE_LOCKED` is deliberately the same string as the
 * protocol error code of that name (core/protocol PERR.WORKSPACE_LOCKED) so a
 * holder conflict reads identically wherever it surfaces; the other codes are
 * local to the fail-closed recovery policy.
 */
export const LOCK_CODE = {
  /** Another process on this machine is holding the lock right now. */
  WORKSPACE_LOCKED: 'WORKSPACE_LOCKED',
  /** The lock names a different host; never reclaimed from here. */
  LOCK_HELD_OTHER_HOST: 'LOCK_HELD_OTHER_HOST',
  /** Liveness could not be established safely — fail closed. */
  LOCK_UNVERIFIABLE: 'LOCK_UNVERIFIABLE',
  /** Repeated races while acquiring; retry. */
  LOCK_CONTENDED: 'LOCK_CONTENDED',
  /** The lock file exists but is not a readable lock record — fail closed. */
  LOCK_INVALID: 'LOCK_INVALID',
};

/** Structured lock error, in the same shape as core/errors UhError. */
export class LockError extends Error {
  constructor(code, message, context = {}, action = null) {
    super(message);
    this.name = 'LockError';
    this.code = code;
    this.context = context;
    this.action = action;
  }

  toString() {
    return `${this.code}: ${this.message}${this.action ? ` (action: ${this.action})` : ''}`;
  }

  toJSON() {
    return { name: this.name, code: this.code, message: this.message, context: this.context, action: this.action };
  }
}

// ---------------------------------------------------------------------------
// Liveness probe — the only source of "is the holder still running?" facts
// ---------------------------------------------------------------------------

/** Authoritative boot identity on Linux; null everywhere else (no guessing). */
function readBootId() {
  if (process.platform !== 'linux') return null;
  try {
    const id = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    return id || null;
  } catch {
    return null;
  }
}

/**
 * Process start time in clock ticks since boot (field 22 of `/proc/<pid>/stat`),
 * or null when it cannot be read — no such process, a non-Linux platform, or a
 * PID we cannot see. null always means "unknown", never "dead".
 */
function readProcStartTicks(pid) {
  if (process.platform !== 'linux') return null;
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // The comm field is parenthesised and may contain spaces/parens, so parse
    // after the *last* ')'. Fields are then space-separated starting at field 3.
    const close = stat.lastIndexOf(')');
    if (close < 0) return null;
    const rest = stat.slice(close + 2).trim().split(/\s+/);
    const starttime = Number(rest[22 - 3]);
    return Number.isFinite(starttime) ? starttime : null;
  } catch {
    return null;
  }
}

/**
 * The real-OS probe. Injectable so tests can exercise every branch of the
 * reclaim policy deterministically on any platform.
 *
 * @returns {{hostname:()=>string, bootId:()=>string|null, procStartTicks:(pid:number)=>number|null, pid:()=>number, now:()=>number}}
 */
export function createSystemProbe() {
  return {
    hostname: () => os.hostname(),
    bootId: () => readBootId(),
    procStartTicks: (pid) => readProcStartTicks(pid),
    pid: () => process.pid,
    now: () => Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Reading and classifying a lock
// ---------------------------------------------------------------------------

/**
 * Read the lock file.
 *
 * `reason: 'incomplete'` means the file is not (yet) a complete record — either
 * empty, or a *truncated prefix* of one. Both are the normal result of racing
 * another process's `create` against its first `write`, or of observing a write
 * that has not finished. Callers retry rather than treating it as corruption.
 *
 * A truncated record is only classified as incomplete while it is still a
 * plausible prefix of a lock record (`{` …). Anything else is genuinely
 * malformed and fails closed, so a hand-written junk file is never silently
 * retried forever.
 *
 * @param {string} lockPath
 * @returns {{ok:true, record:Object}|{ok:false, reason:'missing'|'incomplete'|'malformed', detail?:string}}
 */
export function readLockRecord(lockPath) {
  let text;
  try {
    text = fs.readFileSync(lockPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: false, reason: 'missing' };
    return { ok: false, reason: 'malformed', detail: `unreadable (${err.code || err.message})` };
  }
  if (text.trim() === '') return { ok: false, reason: 'incomplete' };
  let record;
  try {
    record = JSON.parse(text);
  } catch {
    // An unfinished write: the record starts as an object but is not complete
    // yet. Treat as transient so a crashed creator does not read as corruption
    // (and does not leak its half-written lockId as evidence).
    if (text.trimStart().startsWith('{') && !text.trimEnd().endsWith('}')) {
      return { ok: false, reason: 'incomplete' };
    }
    return { ok: false, reason: 'malformed', detail: 'not valid JSON' };
  }
  if (!record || typeof record !== 'object' || typeof record.lockId !== 'string' || !record.lockId) {
    return { ok: false, reason: 'malformed', detail: 'no lockId' };
  }
  return { ok: true, record };
}

/**
 * Decide what to do about the lock record currently on disk.
 *
 * @returns {{reclaim:true, reason:string}|{reclaim:false, code:string, reason:string}}
 */
function classifyHolder(record, { host, bootId, probe }) {
  if (record.host !== host) {
    return {
      reclaim: false,
      code: LOCK_CODE.LOCK_HELD_OTHER_HOST,
      reason: `the lock was taken on host "${record.host}", not "${host}"`,
    };
  }

  // (a) Authoritative reboot proof.
  if (record.bootId && bootId && record.bootId !== bootId) {
    return { reclaim: true, reason: 'the machine rebooted since the lock was taken (boot id changed)' };
  }

  // (b) PID reuse: the recorded pid is alive but is a different process.
  const recordedTicks = record.procStartTicks;
  if (typeof recordedTicks === 'number' && Number.isFinite(recordedTicks)) {
    const currentTicks = probe.procStartTicks(record.pid);
    if (typeof currentTicks === 'number' && Number.isFinite(currentTicks)) {
      if (currentTicks !== recordedTicks) {
        return { reclaim: true, reason: `pid ${record.pid} was reused by another process (start time differs)` };
      }
      return {
        reclaim: false,
        code: LOCK_CODE.WORKSPACE_LOCKED,
        reason: `pid ${record.pid} is still running and still holds the lock`,
      };
    }
  }

  // Nothing above proved the holder is gone. Fail closed.
  return {
    reclaim: false,
    code: LOCK_CODE.LOCK_UNVERIFIABLE,
    reason: 'the holder could not be proven to be gone (no boot-id change, no readable process start time)',
  };
}

/** Human-readable lock state plus an actionable recovery procedure. */
export function describeLock(lockPath) {
  const read = readLockRecord(lockPath);
  if (!read.ok) {
    return {
      held: false,
      path: lockPath,
      reason: read.reason,
      detail: read.detail || null,
      recovery: read.reason === 'incomplete'
        ? `The lock file is empty or only partly written — either a lock is being created right now (retry), or a previous creation was interrupted before it finished. If retrying does not clear it and no Universal Harness command is running, delete:\n    ${lockPath}`
        : `The lock file is not a readable lock record. Confirm no Universal Harness command is running against this workspace, then delete:\n    ${lockPath}`,
    };
  }
  const r = read.record;
  return {
    held: true,
    path: lockPath,
    record: r,
    summary: `held by pid ${r.pid} on host "${r.host}" since ${r.acquiredAt} (purpose: ${r.purpose || 'workspace'})`,
    recovery: [
      `Confirm no Universal Harness command is using this workspace:`,
      `  - on this machine: no \`uh\` command is running, then delete`,
      `      ${lockPath}`,
      r.host !== os.hostname()
        ? `  - the lock names host "${r.host}", NOT this machine. Do NOT delete it here: that machine may be using the workspace right now. Close the workspace there first.`
        : `  - the lock names this machine ("${r.host}"). Only delete it once you are sure no \`uh\` process is alive.`,
      `Then re-run the command.`,
    ].join('\n'),
  };
}

/** A lock handle: `release()` is idempotent and only ever removes *our* lock. */
function makeHandle(lockPath, record) {
  return {
    lockId: record.lockId,
    path: lockPath,
    record,
    /**
     * Release the lock. Never deletes a lock that is no longer ours — if the
     * file's lockId differs (it was reclaimed, or replaced), this is a no-op.
     *
     * The read-then-unlink is safe because a *live* holder's record is never
     * displaced: reclaim only ever removes a record whose holder is provably
     * dead, and we are executing, so we are not. The only writer that could
     * change `lockPath` while our record is present is us.
     *
     * @returns {boolean} whether this call removed our lock
     */
    release() {
      const current = readLockRecord(lockPath);
      if (!current.ok || current.record.lockId !== record.lockId) return false;
      try {
        fs.unlinkSync(lockPath);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/**
 * Acquire the advisory lock, or throw.
 *
 * @param {string} lockPath
 * @param {Object} [opts]
 * @param {string} [opts.purpose] recorded so a stuck lock explains itself
 * @param {Object} [opts.probe] liveness probe (defaults to the real OS)
 * @param {number} [opts.maxAttempts] bound on reclaim/create races
 * @returns {{lockId:string, path:string, record:Object, release:()=>boolean}}
 * @throws {LockError}
 */
export function acquireLock(lockPath, { purpose = 'workspace', probe = createSystemProbe(), maxAttempts = 8 } = {}) {
  const host = probe.hostname();
  const bootId = probe.bootId();
  const pid = probe.pid();
  const procStartTicks = probe.procStartTicks(pid);
  const guardPath = guardPathFor(lockPath);
  let blockedByGuard = false;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const record = {
      v: LOCK_SCHEMA,
      lockId: crypto.randomBytes(16).toString('hex'),
      pid,
      host,
      bootId: bootId ?? null,
      procStartTicks: procStartTicks ?? null,
      purpose: String(purpose),
      acquiredAt: new Date(probe.now()).toISOString(),
    };

    try {
      const fd = fs.openSync(lockPath, 'wx'); // exclusive create decides the winner
      try {
        fs.writeSync(fd, `${JSON.stringify(record, null, 2)}\n`);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      return makeHandle(lockPath, record);
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }

    const read = readLockRecord(lockPath);
    // 'missing' → released between EEXIST and read. 'incomplete' → we raced the
    // holder's first write. Both are transient: retry rather than fail.
    if (!read.ok && (read.reason === 'missing' || read.reason === 'incomplete')) continue;
    if (!read.ok) {
      throw new LockError(
        LOCK_CODE.LOCK_INVALID,
        `the workspace lock exists but is not a readable lock record (${read.detail})`,
        { path: lockPath },
        describeLock(lockPath).recovery,
      );
    }

    const verdict = classifyHolder(read.record, { host, bootId, probe });
    if (!verdict.reclaim) {
      throw new LockError(
        verdict.code,
        `the workspace is locked: ${verdict.reason}`,
        {
          path: lockPath,
          holderPid: read.record.pid,
          holderHost: read.record.host,
          acquiredAt: read.record.acquiredAt,
        },
        describeLock(lockPath).recovery,
      );
    }

    // The record is reclaimable. Serialize on the guard so at most one reclaimer
    // ever acts; if we cannot take it, another reclaimer is mid-flight (or one
    // crashed holding it) — retry rather than reclaim unsafely.
    if (!tryCreateReclaimGuard(guardPath, record)) {
      blockedByGuard = true;
      continue;
    }
    let outcome;
    try {
      outcome = reclaimUnderGuard(lockPath, read.record);
    } finally {
      releaseReclaimGuard(guardPath);
    }
    if (outcome === 'unverifiable') {
      throw new LockError(
        LOCK_CODE.LOCK_UNVERIFIABLE,
        'the stale workspace lock could not be removed safely',
        { path: lockPath, staleLockId: read.record.lockId },
        `A stale lock could not be cleared automatically. Confirm no Universal Harness command is running against this workspace, then delete:\n    ${lockPath}`,
      );
    }
    // 'removed' or 'changed' → loop and try to acquire again.
  }

  // Out of attempts. If a reclaim guard was blocking us and is still present, say
  // so specifically — that is a fail-closed condition needing operator recovery,
  // not ordinary contention.
  if (blockedByGuard && fs.existsSync(guardPath)) {
    throw new LockError(
      LOCK_CODE.LOCK_UNVERIFIABLE,
      'the workspace lock could not be reclaimed: a reclaim guard is held by another process or was left behind by a crashed one',
      { path: lockPath, guard: guardPath },
      `A reclaim guard is blocking automatic recovery:\n    ${guardPath}\nIf no Universal Harness command is running, delete the guard file and retry. Do not delete the lock file itself unless you are certain no command is using this workspace.`,
    );
  }

  throw new LockError(
    LOCK_CODE.LOCK_CONTENDED,
    'could not acquire the workspace lock after repeated races with other processes',
    { path: lockPath },
    'Retry the command. If this repeats, inspect the lock file with `uh doctor` and follow its recovery procedure.',
  );
}

// ---------------------------------------------------------------------------
// Reclaim guard — serializes stale-lock recovery
// ---------------------------------------------------------------------------

function guardPathFor(lockPath) {
  return `${lockPath}${RECLAIM_GUARD_SUFFIX}`;
}

/**
 * Try to become the sole reclaimer by exclusively creating the guard file.
 *
 * @returns {boolean} true when we now hold the guard, false when another
 *   reclaimer already holds it (the caller retries) — contention never throws.
 */
function tryCreateReclaimGuard(guardPath, record) {
  let fd;
  try {
    fd = fs.openSync(guardPath, 'wx');
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  }
  try {
    fs.writeSync(fd, `${JSON.stringify({ ...record, reclaimGuard: true }, null, 2)}\n`);
    fs.fsyncSync(fd);
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
  }
  return true;
}

/**
 * Release the guard we created. While we hold it, no other process removes or
 * recreates this file, so the unlink removes our guard and nothing else — there
 * is no check-then-delete race to lose.
 */
function releaseReclaimGuard(guardPath) {
  try { fs.unlinkSync(guardPath); } catch { /* best effort */ }
}

/**
 * Remove the lock **iff** it is still the exact record we classified. MUST be
 * called while holding the reclaim guard.
 *
 * The guard is what makes the read-then-unlink below safe. Without it another
 * reclaimer could remove the classified record and a new holder could create the
 * lock between our read and our unlink, and we would delete the wrong file. With
 * it the record cannot change: its holder is provably dead (so it cannot
 * release), no other reclaimer may act, and no new acquirer can create the lock
 * while the record is still present.
 *
 * A record we did not classify is left strictly alone — it is never moved and
 * never deleted, so a lock a new holder legitimately created in the reclaim
 * window cannot be lost.
 *
 * @returns {'removed'|'changed'|'unverifiable'}
 */
function reclaimUnderGuard(lockPath, classified) {
  const current = readLockRecord(lockPath);
  if (!current.ok) {
    if (current.reason === 'missing') return 'removed';    // already gone
    if (current.reason === 'incomplete') return 'changed'; // a new acquirer is mid-create
    return 'unverifiable';                                 // unreadable: do not guess
  }
  if (current.record.lockId !== classified.lockId) return 'changed'; // not ours to remove
  try {
    fs.unlinkSync(lockPath);
    return 'removed';
  } catch (err) {
    if (err.code === 'ENOENT') return 'removed';
    return 'unverifiable';
  }
}
