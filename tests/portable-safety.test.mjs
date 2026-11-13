// Portable safety primitives (Phase 5, stage S1): atomic writes, the path
// guard + canonicalisation helpers, the workspace containment check, and the
// advisory lock's reclaim policy.
//
// The lock tests are the important ones. They assert the *negative* space: that
// a lock is NOT reclaimed on age, NOT reclaimed on a bare PID, NOT reclaimed
// across hosts, and that it FAILS CLOSED whenever liveness cannot be proven.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { writeFileAtomicSync, writeFileAtomic, fsyncDirSync, isAtomicTempPath } from '../core/portable/mod.mjs';
import { acquireLock, describeLock, readLockRecord, LOCK_CODE, RECLAIM_GUARD_SUFFIX } from '../core/portable/lock.mjs';
import {
  assertSafeRelativePath, resolvePortable, relativeExists, canonicalPathKey,
  isWindowsReservedName, hasWindowsIllegalChars,
} from '../core/paths/mod.mjs';
import { createWorkspaceStore } from '../core/workspace/mod.mjs';

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Create a directory link; returns false where it needs privilege (Windows). */
function trySymlink(target, linkPath) {
  try {
    fs.symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch {
    return false;
  }
}

function lockRecord(overrides = {}) {  return {
    v: 1,
    lockId: 'f'.repeat(32),
    pid: 4242,
    host: 'test-host',
    bootId: 'boot-a',
    procStartTicks: 1000,
    purpose: 'test',
    acquiredAt: '2026-10-12T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * Deterministic liveness probe. `ticksFor` maps pid → process start time; a pid
 * absent from the table reads as "unknown" (null), never as "dead".
 */
function fakeProbe({ hostname = 'test-host', bootId = 'boot-a', selfPid = 4242, selfTicks = 1000, ticksFor = null } = {}) {
  const table = ticksFor || { [String(selfPid)]: selfTicks };
  return {
    hostname: () => hostname,
    bootId: () => bootId,
    procStartTicks: (p) => (Object.prototype.hasOwnProperty.call(table, String(p)) ? table[String(p)] : null),
    pid: () => selfPid,
    now: () => Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Atomic write
// ---------------------------------------------------------------------------

test('atomic write: writes exact content and leaves no temp file behind', async () => {
  const dir = tmpDir('uh-atomic-');
  try {
    const target = path.join(dir, 'registry.json');
    writeFileAtomicSync(target, '{"a":1}');
    assert.equal(fs.readFileSync(target, 'utf8'), '{"a":1}');
    assert.deepEqual(fs.readdirSync(dir), ['registry.json'], 'no leftover temp file');
    // async form is equivalent
    await writeFileAtomic(target, '{"a":2}');
    assert.equal(fs.readFileSync(target, 'utf8'), '{"a":2}');
    assert.deepEqual(fs.readdirSync(dir), ['registry.json']);
  } finally { cleanup(dir); }
});

test('atomic write: overwrites an existing file and round-trips binary', async () => {
  const dir = tmpDir('uh-atomic-');
  try {
    const target = path.join(dir, 'blob.bin');
    fs.writeFileSync(target, 'old contents that must not survive');
    const bytes = Buffer.from([0x00, 0xff, 0x10, 0x0a, 0x7f]);
    writeFileAtomicSync(target, bytes);
    assert.deepEqual(fs.readFileSync(target), bytes);
    assert.deepEqual(fs.readdirSync(dir), ['blob.bin']);
  } finally { cleanup(dir); }
});

test('atomic write: fails loudly when the parent directory is missing', () => {
  const dir = tmpDir('uh-atomic-');
  try {
    const target = path.join(dir, 'nope', 'x.json');
    assert.throws(() => writeFileAtomicSync(target, 'x'), (e) => e.code === 'ENOENT');
    assert.equal(fs.existsSync(path.join(dir, 'nope')), false, 'nothing was created');
  } finally { cleanup(dir); }
});

test('isAtomicTempPath distinguishes temp files from targets', () => {
  assert.equal(isAtomicTempPath('registry.json.uh-tmp-abc'), true);
  assert.equal(isAtomicTempPath('registry.json'), false);
});

test('fsyncDirSync is best-effort and never throws', () => {
  const dir = tmpDir('uh-atomic-');
  try {
    assert.doesNotThrow(() => fsyncDirSync(dir));
    assert.doesNotThrow(() => fsyncDirSync(path.join(dir, 'does-not-exist')));
  } finally { cleanup(dir); }
});

test('atomic write: the requested mode reaches the target on POSIX', () => {
  const dir = tmpDir('uh-atomic-');
  try {
    const target = path.join(dir, 'secret.json');
    writeFileAtomicSync(target, 'token', { mode: 0o600 });
    if (process.platform === 'win32') {
      // Windows has no POSIX permission bits; the argument is accepted and has no
      // effect. Assert only that the write itself succeeded.
      assert.equal(fs.readFileSync(target, 'utf8'), 'token');
    } else {
      // Regression guard: create-mode alone is masked by the umask, so a caller
      // asking for 0o600 must not silently get 0o666.
      assert.equal(fs.statSync(target).mode & 0o777, 0o600);
    }
  } finally { cleanup(dir); }
});

// ---------------------------------------------------------------------------
// Path guard + canonicalisation
// ---------------------------------------------------------------------------

test('assertSafeRelativePath: normalises valid paths, rejects every escape form', () => {
  assert.equal(assertSafeRelativePath('data/projects/x'), 'data/projects/x');
  assert.equal(assertSafeRelativePath('a/./b'), 'a/b');
  assert.equal(assertSafeRelativePath(''), '');
  assert.equal(assertSafeRelativePath('a//b'), 'a/b');

  const rejected = [
    '../x', 'a/../../b', '/abs/path', 'C:/windows', '\\\\srv\\share',
    '//srv/share', '~/secrets', 'a\0b',
  ];
  for (const bad of rejected) {
    assert.throws(() => assertSafeRelativePath(bad), (e) => e.code === 'PATH_UNSAFE',
      `must reject ${JSON.stringify(bad)}`);
  }
});

test('resolvePortable: stays inside the root and rejects traversal', () => {
  const root = tmpDir('uh-root-');
  try {
    assert.equal(resolvePortable(root, ''), path.resolve(root));
    const inside = resolvePortable(root, 'data/projects/x');
    assert.equal(inside, path.join(path.resolve(root), 'data', 'projects', 'x'));
    assert.ok(inside.startsWith(path.resolve(root) + path.sep));
    assert.throws(() => resolvePortable(root, '../../etc/passwd'), (e) => e.code === 'PATH_UNSAFE');
    assert.throws(() => resolvePortable(root, '/etc/passwd'), (e) => e.code === 'PATH_UNSAFE');
  } finally { cleanup(root); }
});

test('relativeExists: unsafe stored paths answer false instead of throwing', () => {
  const root = tmpDir('uh-root-');
  try {
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    fs.writeFileSync(path.join(root, 'data', 'yes.txt'), 'x');
    assert.equal(relativeExists(root, 'data/yes.txt'), true);
    assert.equal(relativeExists(root, 'data/no.txt'), false);
    assert.equal(relativeExists(root, '../../escape'), false);
  } finally { cleanup(root); }
});

test('resolvePortable is LEXICAL: a symlink out of the root is NOT caught here', () => {
  const root = tmpDir('uh-root-');
  const outside = tmpDir('uh-outside-');
  try {
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'OUTSIDE');
    if (!trySymlink(outside, path.join(root, 'link'))) return; // privileged on Windows

    // Documented boundary (see the resolvePortable doc comment): this helper does
    // not stat anything, so it happily returns a path that leaves the root
    // *through a link*. The protocol file API (core/workspace-api safeResolve)
    // is the layer that performs the realpath walk. Asserting this locks the
    // boundary in place so a future "fix" here does not create a false sense of
    // safety, and so the doc comment cannot drift from the behaviour.
    const through = resolvePortable(root, 'link/secret.txt');
    assert.ok(through.startsWith(path.resolve(root) + path.sep), 'lexically inside the root');
    assert.ok(fs.realpathSync(through).startsWith(fs.realpathSync(outside)), 'but really outside it');
  } finally { cleanup(root); cleanup(outside); }
});

test('assertSafeRelativePath: separators normalise but a POSIX literal backslash survives', () => {
  const BS = String.fromCharCode(92);
  assert.equal(assertSafeRelativePath(`data${BS}projects${BS}x`), 'data/projects/x');
  if (process.platform !== 'win32') {
    // On POSIX the separator is '/', so a backslash is an ordinary filename char.
    assert.equal(assertSafeRelativePath('weird' + BS + 'name'), 'weird' + BS + 'name');
  }
});

test('canonicalPathKey: Unicode NFC and case fold to one key', () => {
  const composed = 'caf\u00e9/Report.txt';
  const decomposed = 'cafe\u0301/report.TXT';
  assert.equal(canonicalPathKey(composed), canonicalPathKey(decomposed));
  assert.notEqual(canonicalPathKey('a/b'), canonicalPathKey('a/c'));
});

test('Windows reserved names and illegal characters are detectable', () => {
  for (const n of ['CON', 'con', 'NUL', 'PRN', 'AUX', 'COM1', 'lpt9', 'CON.txt']) {
    assert.equal(isWindowsReservedName(n), true, `${n} is reserved`);
  }
  for (const n of ['CONS', 'CONX', 'COM0', 'COM10', 'normal.txt']) {
    assert.equal(isWindowsReservedName(n), false, `${n} is not reserved`);
  }
  assert.equal(hasWindowsIllegalChars('a<b'), true);
  assert.equal(hasWindowsIllegalChars('a:b'), true);
  assert.equal(hasWindowsIllegalChars('a|b'), true);
  assert.equal(hasWindowsIllegalChars('normal-name.txt'), false);
});

// ---------------------------------------------------------------------------
// Workspace containment (validate before ensureDir)
// ---------------------------------------------------------------------------

function makeWorkspaceRoot() {
  const root = tmpDir('uh-ws-');
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'bin', 'uh.mjs'), '// marker\n');
  fs.mkdirSync(path.join(root, 'core'), { recursive: true });
  fs.mkdirSync(path.join(root, 'manifests'), { recursive: true });
  const p = {
    data: path.join(root, 'data'),
    projects: path.join(root, 'data', 'projects'),
    workspace: path.join(root, 'data', 'workspace'),
  };
  return { root, p };
}

test('workspace: a project relPath that escapes the root is refused and creates nothing', () => {
  const { root, p } = makeWorkspaceRoot();
  const escapeName = `uh-escape-${process.pid}-${Date.now()}`;
  try {
    const store = createWorkspaceStore({ root, p });
    assert.throws(
      () => store.registerProject({ name: 'Evil', relPath: `../../${escapeName}` }),
      (e) => e.code === 'WORKSPACE_INVALID',
    );
    assert.equal(fs.existsSync(path.resolve(root, '..', '..', escapeName)), false,
      'nothing may be created outside the workspace root');
    assert.equal(store.listProjects().length, 0, 'no registry entry was added');
  } finally { cleanup(root); }
});

test('workspace: an in-root project still registers normally (behaviour preserved)', () => {
  const { root, p } = makeWorkspaceRoot();
  try {
    const store = createWorkspaceStore({ root, p });
    const rec = store.registerProject({ name: 'My Project' });
    assert.ok(rec.id);
    assert.equal(rec.relPath, 'data/projects/my-project');
    assert.equal(fs.existsSync(path.join(root, 'data', 'projects', 'my-project')), true);
    assert.equal(store.listProjects().length, 1);
  } finally { cleanup(root); }
});

// ---------------------------------------------------------------------------
// Advisory lock
// ---------------------------------------------------------------------------

test('lock: acquire creates the record, release removes it', () => {
  const dir = tmpDir('uh-lock-');
  try {
    const lockPath = path.join(dir, 'workspace.lock');
    const handle = acquireLock(lockPath, { purpose: 'export', probe: fakeProbe() });
    assert.match(handle.lockId, /^[0-9a-f]{32}$/);
    const rec = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    assert.equal(rec.v, 1);
    assert.equal(rec.purpose, 'export');
    assert.equal(rec.host, 'test-host');
    assert.equal(rec.pid, 4242);
    assert.match(rec.acquiredAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(handle.release(), true);
    assert.equal(fs.existsSync(lockPath), false);
    assert.equal(handle.release(), false, 'release is idempotent');
  } finally { cleanup(dir); }
});

test('lock: a live holder on this host is reported, not overridden', () => {
  const dir = tmpDir('uh-lock-');
  try {
    const lockPath = path.join(dir, 'workspace.lock');
    acquireLock(lockPath, { probe: fakeProbe() });
    assert.throws(
      () => acquireLock(lockPath, { probe: fakeProbe() }),
      (e) => e.code === LOCK_CODE.WORKSPACE_LOCKED,
    );
  } finally { cleanup(dir); }
});

test('lock: AGE ALONE never reclaims — an ancient lock with a live holder is kept', () => {
  const dir = tmpDir('uh-lock-');
  try {
    const lockPath = path.join(dir, 'workspace.lock');
    // Same host, same boot, same process start time => holder is alive.
    // The timestamp is deliberately decades old: age must carry no weight.
    fs.writeFileSync(lockPath, JSON.stringify(lockRecord({ acquiredAt: '2000-01-01T00:00:00.000Z' })));
    assert.throws(
      () => acquireLock(lockPath, { probe: fakeProbe() }),
      (e) => e.code === LOCK_CODE.WORKSPACE_LOCKED,
    );
    assert.equal(readLockRecord(lockPath).record.lockId, 'f'.repeat(32), 'the old lock was left untouched');
  } finally { cleanup(dir); }
});

test('lock: a lock naming another host is never reclaimed from here', () => {
  const dir = tmpDir('uh-lock-');
  try {
    const lockPath = path.join(dir, 'workspace.lock');
    fs.writeFileSync(lockPath, JSON.stringify(lockRecord({ host: 'other-machine' })));
    assert.throws(
      () => acquireLock(lockPath, { probe: fakeProbe({ hostname: 'test-host' }) }),
      (e) => e.code === LOCK_CODE.LOCK_HELD_OTHER_HOST,
    );
    assert.equal(fs.existsSync(lockPath), true, 'the other host\'s lock is left alone');
  } finally { cleanup(dir); }
});

test('lock: a boot-id change proves the holder is gone, so reclaim proceeds', () => {
  const dir = tmpDir('uh-lock-');
  try {
    const lockPath = path.join(dir, 'workspace.lock');
    fs.writeFileSync(lockPath, JSON.stringify(lockRecord({ bootId: 'boot-old', lockId: 'a'.repeat(32) })));
    const handle = acquireLock(lockPath, { probe: fakeProbe({ bootId: 'boot-new' }) });
    assert.notEqual(handle.lockId, 'a'.repeat(32));
    assert.equal(readLockRecord(lockPath).record.bootId, 'boot-new');
  } finally { cleanup(dir); }
});

test('lock: a reused PID (start time differs) proves the holder is gone', () => {
  const dir = tmpDir('uh-lock-');
  try {
    const lockPath = path.join(dir, 'workspace.lock');
    // Same pid 4242, but a different process start time => the pid was reused.
    fs.writeFileSync(lockPath, JSON.stringify(lockRecord({ procStartTicks: 999, lockId: 'b'.repeat(32) })));
    const handle = acquireLock(lockPath, { probe: fakeProbe({ selfPid: 4242, selfTicks: 1000 }) });
    assert.notEqual(handle.lockId, 'b'.repeat(32));
  } finally { cleanup(dir); }
});

test('lock: FAILS CLOSED when the holder recorded no process start time', () => {
  const dir = tmpDir('uh-lock-');
  try {
    const lockPath = path.join(dir, 'workspace.lock');
    // First acquisition cannot record its own start time (e.g. Windows).
    const first = acquireLock(lockPath, { probe: fakeProbe({ selfTicks: null }) });
    assert.equal(readLockRecord(lockPath).record.procStartTicks, null);
    assert.throws(
      () => acquireLock(lockPath, { probe: fakeProbe({ selfTicks: null }) }),
      (e) => e.code === LOCK_CODE.LOCK_UNVERIFIABLE,
    );
    assert.equal(first.release(), true);
  } finally { cleanup(dir); }
});

test('lock: FAILS CLOSED when the recorded holder\'s start time cannot be read', () => {
  const dir = tmpDir('uh-lock-');
  try {
    const lockPath = path.join(dir, 'workspace.lock');
    fs.writeFileSync(lockPath, JSON.stringify(lockRecord({ pid: 4242, procStartTicks: 1000 })));
    // The probe cannot see pid 4242 at all => "unknown", which is not "dead".
    assert.throws(
      () => acquireLock(lockPath, { probe: fakeProbe({ selfPid: 5555, ticksFor: {} }) }),
      (e) => e.code === LOCK_CODE.LOCK_UNVERIFIABLE,
    );
    assert.equal(fs.existsSync(lockPath), true);
  } finally { cleanup(dir); }
});

test('lock: a malformed lock file fails closed with a recovery procedure', () => {
  const dir = tmpDir('uh-lock-');
  try {
    const lockPath = path.join(dir, 'workspace.lock');
    fs.writeFileSync(lockPath, 'this is not JSON');
    assert.throws(
      () => acquireLock(lockPath, { probe: fakeProbe() }),
      (e) => e.code === LOCK_CODE.LOCK_INVALID && typeof e.action === 'string' && e.action.includes(lockPath),
    );
  } finally { cleanup(dir); }
});

test('lock: a TRUNCATED record is transient (crash mid-write), not corrupt', () => {
  const dir = tmpDir('uh-lock-');
  try {
    const lockPath = path.join(dir, 'workspace.lock');
    // A process that created the file, started writing, and died: the file holds
    // a JSON *prefix*. That is the crash window this policy must not misread as
    // corruption (which would leak a dead holder's lockId as "evidence").
    const full = JSON.stringify(lockRecord(), null, 2);
    fs.writeFileSync(lockPath, full.slice(0, 40));
    assert.equal(readLockRecord(lockPath).reason, 'incomplete');
    assert.throws(
      () => acquireLock(lockPath, { probe: fakeProbe(), maxAttempts: 3 }),
      // Bounded retries, then a contention error. The contention path points the
      // operator at `uh doctor` (which prints describeLock's path-bearing
      // recovery), so the action must name that diagnostic — and must be a
      // *contention* error, never a corruption error, never a silent overwrite.
      (e) => e.code === LOCK_CODE.LOCK_CONTENDED && /doctor/.test(e.action),
    );
    assert.equal(fs.readFileSync(lockPath, 'utf8'), full.slice(0, 40), 'the partial file was not overwritten');
    // ...and the operator-follows-the-advice path does name the file to delete.
    assert.match(describeLock(lockPath).recovery, new RegExp(lockPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    // A genuine junk file is still corrupt, and still names its recovery.
    fs.writeFileSync(lockPath, '{"v":1, lockId: nope}');
    assert.equal(readLockRecord(lockPath).reason, 'malformed');
    assert.throws(
      () => acquireLock(lockPath, { probe: fakeProbe(), maxAttempts: 3 }),
      (e) => e.code === LOCK_CODE.LOCK_INVALID && e.action.includes(lockPath),
    );
  } finally { cleanup(dir); }
});

test('lock: a new holder that appears in the reclaim window is never moved or deleted', () => {
  const dir = tmpDir('uh-lock-');
  try {
    const lockPath = path.join(dir, 'workspace.lock');
    const guardPath = `${lockPath}${RECLAIM_GUARD_SUFFIX}`;
    const aLockId = 'a'.repeat(32);
    const bLockId = 'b'.repeat(32);
    // A boot-changed (reclaimable) lock A is on disk.
    fs.writeFileSync(lockPath, JSON.stringify(lockRecord({ lockId: aLockId, bootId: 'boot-old', procStartTicks: 5 })));

    // The instant the reclaimer takes the guard, a *new, legitimate* holder B has
    // already replaced A. The reclaimer must leave B strictly alone. The old
    // rename-based reclaim renamed B aside (vacating lockPath, so a third process
    // could slip in) and then deleted it — two simultaneous holders.
    const realOpen = fs.openSync;
    let planted = false;
    fs.openSync = function (p, flags) {
      if (!planted && p === guardPath && flags === 'wx') {
        planted = true;
        fs.unlinkSync(lockPath);
        fs.writeFileSync(lockPath, JSON.stringify(lockRecord({ lockId: bLockId, pid: 7777, bootId: 'boot-new', procStartTicks: 5000 })));
      }
      return realOpen.apply(this, arguments);
    };

    let acquired = null;
    let thrown = null;
    try {
      acquired = acquireLock(lockPath, {
        probe: fakeProbe({ bootId: 'boot-new', ticksFor: { '4242': 1000, '7777': 5000 } }),
      });
    } catch (err) { thrown = err; } finally { fs.openSync = realOpen; }

    assert.equal(planted, true, 'the interposition must have happened');
    // B is live and still holds the lock; the reclaimer saw it and stood down.
    assert.equal(thrown?.code, LOCK_CODE.WORKSPACE_LOCKED, `expected the reclaimer to stand down, got ${thrown?.code}`);
    assert.equal(acquired, null, 'the reclaimer must not become a second holder');
    const now = readLockRecord(lockPath);
    assert.equal(now.ok && now.record.lockId, bLockId, "B's live lock must be intact");
    // No aside/park artifacts of any kind, and no leftover guard.
    assert.deepEqual(fs.readdirSync(dir).filter((n) => n !== 'workspace.lock'), [], 'no leftover files');
  } finally { cleanup(dir); }
});

test('lock: a second reclaimer is blocked by the guard and cannot delete the first record', () => {
  const dir = tmpDir('uh-lock-');
  try {
    const lockPath = path.join(dir, 'workspace.lock');
    const guardPath = `${lockPath}${RECLAIM_GUARD_SUFFIX}`;
    const aLockId = 'a'.repeat(32);
    fs.writeFileSync(lockPath, JSON.stringify(lockRecord({ lockId: aLockId, bootId: 'boot-old', procStartTicks: 5 })));
    // Another reclaimer already holds the guard (it is mid-reclaim). Under the old
    // shared `.stale-` naming, two reclaimers of the same record collided on one
    // aside name and could overwrite then delete each other's record. The guard
    // makes that impossible: the second reclaimer never acts at all.
    fs.writeFileSync(guardPath, JSON.stringify({ ...lockRecord(), lockId: 'c'.repeat(32), reclaimGuard: true }));

    let thrown = null;
    try {
      acquireLock(lockPath, { probe: fakeProbe({ bootId: 'boot-new' }), maxAttempts: 3 });
    } catch (err) { thrown = err; }

    // Fail closed, naming the guard so the operator can recover.
    assert.equal(thrown?.code, LOCK_CODE.LOCK_UNVERIFIABLE, `expected fail-closed, got ${thrown?.code}`);
    assert.match(thrown.action, new RegExp(guardPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'recovery must name the guard');
    // The stale record was NOT deleted, and the other reclaimer's guard was NOT removed.
    assert.equal(readLockRecord(lockPath).record.lockId, aLockId, 'the record was left untouched');
    assert.equal(fs.existsSync(guardPath), true, "the other reclaimer's guard was left alone");
  } finally { cleanup(dir); }
});

test('lock: a third acquirer racing a reclaimer still ends with a single holder', () => {
  const dir = tmpDir('uh-lock-');
  try {
    const lockPath = path.join(dir, 'workspace.lock');
    const guardPath = `${lockPath}${RECLAIM_GUARD_SUFFIX}`;
    const dLockId = 'd'.repeat(32);
    fs.writeFileSync(lockPath, JSON.stringify(lockRecord({ lockId: 'a'.repeat(32), bootId: 'boot-old', procStartTicks: 5 })));

    // As the reclaimer finishes and releases the guard, a third process D takes the
    // now-free lock path. The reclaimer must observe D and stand down — it must not
    // become a second holder.
    const realUnlink = fs.unlinkSync;
    let planted = false;
    fs.unlinkSync = function (p) {
      if (!planted && p === guardPath) {
        planted = true;
        fs.writeFileSync(lockPath, JSON.stringify(lockRecord({ lockId: dLockId, pid: 8888, bootId: 'boot-new', procStartTicks: 6000 })));
      }
      return realUnlink.apply(this, arguments);
    };

    let acquired = null;
    let thrown = null;
    try {
      acquired = acquireLock(lockPath, {
        probe: fakeProbe({ bootId: 'boot-new', ticksFor: { '4242': 1000, '8888': 6000 } }),
      });
    } catch (err) { thrown = err; } finally { fs.unlinkSync = realUnlink; }

    assert.equal(planted, true, 'the interposition must have happened');
    assert.equal(thrown?.code, LOCK_CODE.WORKSPACE_LOCKED, `expected the reclaimer to stand down, got ${thrown?.code}`);
    assert.equal(acquired, null, 'only one holder may exist');
    assert.equal(readLockRecord(lockPath).record.lockId, dLockId, 'D holds the lock');
    assert.deepEqual(fs.readdirSync(dir).filter((n) => n !== 'workspace.lock'), [], 'no leftover guard');
  } finally { cleanup(dir); }
});

test('lock: an empty lock file is treated as transient, not corrupt', () => {
  const dir = tmpDir('uh-lock-');
  try {
    const lockPath = path.join(dir, 'workspace.lock');
    fs.writeFileSync(lockPath, '');
    // Every attempt sees "incomplete" => bounded retries, then a contention error
    // (never a corruption error, and never a silent overwrite).
    assert.throws(
      () => acquireLock(lockPath, { probe: fakeProbe(), maxAttempts: 3 }),
      (e) => e.code === LOCK_CODE.LOCK_CONTENDED,
    );
    assert.equal(fs.readFileSync(lockPath, 'utf8'), '', 'the empty file was not overwritten');
  } finally { cleanup(dir); }
});

test('lock: release only ever removes our own lock', () => {
  const dir = tmpDir('uh-lock-');
  try {
    const lockPath = path.join(dir, 'workspace.lock');
    const handle = acquireLock(lockPath, { probe: fakeProbe() });
    // Someone else takes over the lock file (simulated).
    fs.writeFileSync(lockPath, JSON.stringify(lockRecord({ lockId: 'c'.repeat(32) })));
    assert.equal(handle.release(), false, 'must not delete a lock that is no longer ours');
    assert.equal(fs.existsSync(lockPath), true);
  } finally { cleanup(dir); }
});

test('lock: describeLock gives an actionable, path-bearing recovery procedure', () => {
  const dir = tmpDir('uh-lock-');
  try {
    const lockPath = path.join(dir, 'workspace.lock');
    acquireLock(lockPath, { purpose: 'import', probe: fakeProbe({ hostname: os.hostname() }) });
    const described = describeLock(lockPath);
    assert.equal(described.held, true);
    assert.equal(described.record.purpose, 'import');
    assert.match(described.summary, /pid 4242/);
    assert.match(described.recovery, new RegExp(lockPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally { cleanup(dir); }
});

test('lock: concurrent recovery attempts — exactly one winner', async () => {
  const dir = tmpDir('uh-lock-');
  try {
    const lockPath = path.join(dir, 'workspace.lock');
    const lockUrl = pathToFileURL(path.join(REPO, 'core', 'portable', 'lock.mjs')).href;
    const script = `
import { acquireLock } from ${JSON.stringify(lockUrl)};
const lockPath = ${JSON.stringify(lockPath)};
try {
  const h = acquireLock(lockPath, { purpose: 'race' });
  process.stdout.write('WON');
  setTimeout(() => { h.release(); process.exit(0); }, 400);
} catch (err) {
  process.stdout.write('LOST:' + err.code);
  process.exit(0);
}
`;
    const run = () => execFileAsync(process.execPath, ['--input-type=module', '-e', script], { cwd: REPO });
    const results = await Promise.all([run(), run(), run()]);
    const won = results.filter((r) => r.stdout === 'WON');
    assert.equal(won.length, 1, `exactly one process must win; got ${JSON.stringify(results.map((r) => r.stdout))}`);
    for (const r of results.filter((x) => x.stdout !== 'WON')) {
      assert.match(r.stdout, /^LOST:(WORKSPACE_LOCKED|LOCK_UNVERIFIABLE|LOCK_CONTENDED)$/,
        `a loser must fail with a lock code, got ${r.stdout}`);
    }
    assert.equal(fs.existsSync(lockPath), false, 'no lock file is left behind');
  } finally { cleanup(dir); }
});

test('lock: concurrent stale-lock reclaim across real processes — one winner, no leftovers', async () => {
  const dir = tmpDir('uh-lock-');
  try {
    const lockPath = path.join(dir, 'workspace.lock');
    const guardPath = `${lockPath}${RECLAIM_GUARD_SUFFIX}`;
    const lockUrl = pathToFileURL(path.join(REPO, 'core', 'portable', 'lock.mjs')).href;
    const script = `
import { acquireLock } from ${JSON.stringify(lockUrl)};
const lockPath = ${JSON.stringify(lockPath)};
// Every child sees the same "rebooted" world: the on-disk record (boot-old) is
// reclaimable, while a winner's own record (boot-new, ticks 1234) is not.
const probe = { hostname: () => 'test-host', bootId: () => 'boot-new',
  procStartTicks: () => 1234, pid: () => 0, now: () => Date.now() };
try {
  const h = acquireLock(lockPath, { purpose: 'race', probe });
  process.stdout.write('WON');
  setTimeout(() => { h.release(); process.exit(0); }, 400);
} catch (err) {
  process.stdout.write('LOST:' + err.code);
  process.exit(0);
}
`;
    const run = () => execFileAsync(process.execPath, ['--input-type=module', '-e', script], { cwd: REPO });
    for (let round = 0; round < 3; round++) {
      fs.writeFileSync(lockPath, JSON.stringify(lockRecord({ lockId: 'a'.repeat(32), bootId: 'boot-old', procStartTicks: 5 })));
      const results = await Promise.all([run(), run(), run()]);
      const out = results.map((r) => r.stdout);
      assert.equal(out.filter((s) => s === 'WON').length, 1, `round ${round}: exactly one winner; got ${JSON.stringify(out)}`);
      for (const s of out.filter((x) => x !== 'WON')) {
        assert.match(s, /^LOST:(WORKSPACE_LOCKED|LOCK_UNVERIFIABLE|LOCK_CONTENDED)$/, `round ${round}: loser code, got ${s}`);
      }
      // However the race resolves, no guard and no aside artifact may survive it.
      assert.equal(fs.existsSync(guardPath), false, `round ${round}: no reclaim guard left behind`);
      assert.deepEqual(fs.readdirSync(dir).filter((n) => n !== 'workspace.lock'), [], `round ${round}: no leftover files`);
    }
  } finally { cleanup(dir); }
});
