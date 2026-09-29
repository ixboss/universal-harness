# core/paths

Portable-root discovery and the portable/device path split (ARCHITECTURE.md §2, §4).

- `findRoot()` — walks up from the process location to the root marked by `bin/uh.mjs` +
  `manifests/runtime.manifest.json` (honors `UH_ROOT` for development).
- `validateRoot()` — a root must exist, be writable, and contain `bin/`, `core/`, `manifests/`.
- `portablePaths()` — the canonical layout object (`data/{projects,sessions,config,workspace,
  backups,logs}`, `manifests`, `diagnostics`, plus the runtime tree).
- `toPortableRelative()` / `resolvePortable()` — POSIX-style relative canonicalization; the
  portable tree refers to itself with relative paths only.

## Status

Phase 1 — **implemented + automated-tested** (`tests/workspace.test.mjs` root detection).
