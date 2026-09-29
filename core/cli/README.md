# core/cli

The `uh` command implementation behind `bin/uh.mjs`.

- `modes.mjs` — `setup` (runtime install), `doctor` (diagnostics), `runtime` (status), `smoke`
  (the 15-stage full-chain gate, brief §18), `exec` (adapter passthrough for scripting).
- `registry.mjs` — `workspace`, `session`, `migrate`, `backup`, `restore` metadata commands.

## Status

Phase 1 — **implemented**; `smoke` executed for real on Windows x64 (14/15, TESTING.md §1a).
