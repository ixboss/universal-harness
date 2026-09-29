# core/workspace

Workspace identity and the project registry (brief §5, §7).

- `init()` — creates an identity marker with a stable id (never overwrites an existing one).
- Registry — schema-versioned records of `recordedRoot` + projects via `relPath`, so a moved
  folder is **detected and reconciled** rather than corrupting. Lists missing projects (offline
  external projects are reported, not deleted) and marker/registry conflicts.

## Status

Phase 1 — **implemented + automated-tested** (7 tests).
