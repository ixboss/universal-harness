# core/shutdown

Idempotent safe-shutdown manager (brief §12): ordered phases
`gate → drain → adapter → flush → diagnostics`, each idempotent, with signal hooks installed
once. Calling `run()` twice is a no-op; the adapter's own shutdown is request → grace window →
SIGTERM → SIGKILL with no orphaned children.

## Status

Phase 1 — **implemented + automated-tested** (`tests/process.test.mjs` shutdown paths).
