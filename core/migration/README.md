# core/migration

Cross-platform session/workspace migration subsystem (ARCHITECTURE.md §14).

## Scope

- **Platform path detection** — Windows drive-letter/backslash markers vs. POSIX.
- **Portable path canonicalization** — map `/data/portable-home/…` and portable-workspace
  paths back to root-relative form; remember non-registered mappings per target platform.
- **Metadata rewrites only** — never conversation content:
  - workspace registry entries
  - session-log `SessionHeader` (`version`, `cwd`, lineage) — recompressing Zstd frames while
    preserving trailing frames byte-identically
  - projection/cache identity records
- **Schema gating** — detect unsupported session-format versions (upstream
  `SESSION_FORMAT_VERSION`, finalized v4 / released v3 at audit) and fail safe with an
  actionable diagnostic; never touch the log.
- **Idempotency + recovery** — migration metadata, step markers, pre-migration backups,
  interrupt-safe resume, rollback to backup.
- **Migration chains** — Windows ↔ Linux ↔ macOS ↔ Android path families.

## Design note (clean-room)

The upstream *storage format* is read/written per upstream docs (MIT, AUDIT §2.5). The
*reference wrapper's migration code* is **not** reused (no license, AUDIT §3.5). This
implementation improves on the reference: backups before every destructive change (not just
session logs), strict idempotency instead of throw-on-existing-destination, and interruption
recovery.

## Status

Phase 1 — **partially implemented** (`mod.mjs`): workspace move detection, recorded-root rewrite, backup-first apply, migration history + validation. **Automated-tested** (`tests/migration.test.mjs`). The cross-OS session-header rewrite (Zstd frame re-encode) is **not implemented** — deferred until it can be tested on a real second OS; dsh session internals remain owned by dsh (brief §7).
