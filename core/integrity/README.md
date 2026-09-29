# core/integrity

Hash verification used by every gate that accepts a downloaded or bundled artifact.

- `verifyFileSha256(file, expected)` — timing-safe comparison; returns `{ok, actual, expected,
  error}`. **The archive is hashed before unpacking**, so a corrupted download can never execute
  (brief §3).
- `sha256File()` — streaming single-file hash.
- Used by: runtime download, dsh install verification, backup verification.

## Status

Phase 1 — **implemented + automated-tested** (`tests/runtime.test.mjs`, `tests/migration.test.mjs`).
