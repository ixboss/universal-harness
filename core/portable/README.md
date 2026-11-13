# core/portable

Portable filesystem and workspace foundation for desktop execution nodes.

## Scope

- **Atomic writes** — `mod.mjs` (`writeFileAtomicSync` / `writeFileAtomic`): a same-directory
  temp file, `fsync`, then `rename` over the target, followed by a best-effort directory
  `fsync`. A crash or power loss during a metadata write leaves either the old bytes or the
  new bytes, never a half-written file. A `mode` option, when given, is applied to the temp
  file before the rename (POSIX; accepted but inert on Windows) — note this makes `mode`
  authoritative per write rather than preserving an existing target's permissions, because
  `rename` replaces the inode.
- **Advisory workspace lock** — `lock.mjs` (`acquireLock` / `describeLock`): one JSON lock file
  in the portable tree so two nodes never mutate one workspace at once. See the reclaim policy
  below — it is deliberately conservative.
- **Portable root resolution** — always relative, never machine-specific or absolute;
  detection of the drive root, platform, and architecture (implemented in `core/paths` +
  `core/platform`).
- **Portable paths** — `data/portable-home` (`DSH_HOME`), `data/projects`,
  `data/workspace`, `models/`, `runtimes/<platform>/`, `manifest/`, etc.
  (ARCHITECTURE.md §2). `core/paths` owns the resolution and now also owns the
  structural guard (`assertSafeRelativePath`) that keeps a stored relative path inside the
  root, plus the canonicalisation helpers (`canonicalPathKey`, `isWindowsReservedName`,
  `hasWindowsIllegalChars`) used when a path arrives from outside the machine.
- **Workspace registry** — project records (portable vs. external), offline/unavailable
  detection without deleting references (see ARCHITECTURE.md §10).

## Lock reclaim policy

A stale lock is reclaimed **only** when the previous holder is *provably* gone:

1. the machine rebooted since the lock was taken — the recorded boot id (authoritative,
   read from `/proc` on Linux) differs from the current one; or
2. the recorded PID is alive but belongs to a **different** process — the process start time
   differs, which is what PID reuse looks like.

Everything else **fails closed** with an actionable recovery procedure
(`describeLock(...).recovery`). In particular, age, elapsed time and timeouts are never used
to reclaim a lock, a bare PID is never sufficient evidence, and a lock naming a different
host is never reclaimed from here.

Reclaim is **serialized by an exclusive guard** (`<lock>.reclaim`, created with `wx`), and it
never moves a record it did not classify. While one reclaimer holds the guard no other may act,
and — because the classified holder is provably dead and no new acquirer can create the lock
while the record is present — the reclaimer removes the lock with a plain `unlink` of the exact
record it classified. A lock that a *new* holder created in the reclaim window is therefore left
strictly alone: it is never renamed aside and never deleted.

This deliberately replaces an earlier rename-aside-and-restore scheme, which was unsafe in two
ways. The rename momentarily *vacated* the lock path, so a third acquirer could take the lock
while the displaced holder still believed it held it (two live holders); and the aside name was
shared by every reclaimer of the same record, so a second reclaimer could overwrite — and then
delete — the first reclaimer's parked record between its identity check and its unlink. Neither
path exists now, because nothing is ever moved. Both are covered by regression tests.

Limitation, stated plainly: if the guard cannot be created — another reclaimer is active, or a
reclaimer crashed while holding it — acquisition **fails closed** (`LOCK_UNVERIFIABLE`) with a
recovery procedure that names the guard file. A stale guard is thus a denial that needs explicit
operator recovery; it is never a silent double-holder.

Scope of the guarantee: the tests cover the reclaim window, a third acquirer racing a reclaimer,
two reclaimers contending for the guard, release, and a real multi-process race, on the platforms
the suite runs on. They do **not** establish universal mutual exclusion — that would need a proof
plus platform coverage (notably Linux, which is not exercised here) that this suite does not have.

A lock file that is empty *or a truncated prefix* of a record (a crash between `create` and
the end of `write`) is treated as transient and retried, up to a bounded number of attempts;
only a genuinely unreadable file is reported as corrupt. Either way, exhausting the retries
fails with an actionable recovery rather than waiting indefinitely.

Consequence to be honest about: because a boot id and a readable process start time are only
available on Linux, **automatic reclaim never happens on Windows or macOS**. There, a lock
left by a crashed process requires the operator to follow the printed recovery procedure
(confirm nothing is running, then delete the lock file). That is intentional — the
alternative is guessing, and guessing wrong means two nodes writing one workspace.

## Boundaries

- No dsh knowledge; no protocol knowledge.
- No global state; all paths derived from an injected root.

## Status

Phase 1 — root discovery, portable/device path split and relative-path canonicalisation
implemented by `core/paths` + `core/platform`.

Phase 5 (S1) — the atomic-write and advisory-lock primitives above are implemented here and
covered by `tests/portable-safety.test.mjs`. The earlier note that "the lock helpers here
remain Phase 2" is superseded.

**Not** implemented here, despite what an earlier revision of this file claimed: a "no-symlink
mode" that makes the codebase never emit symlinks, and a test asserting that across the tree.
No such mode or test exists. Symlink policy today is: the protocol file API rejects a path
that escapes the root through a symlink (`core/workspace-api` `safeResolve`), and an
exFAT/no-symlink mode is still an open item tracked by the risk register.
