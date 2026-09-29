# core/portable

Portable filesystem and workspace foundation for desktop execution nodes.

## Scope

- **Portable root resolution** — always relative, never machine-specific or absolute;
  detection of the drive root, platform, and architecture.
- **Portable paths** — `data/portable-home` (`DSH_HOME`), `data/projects`,
  `data/workspace-registry`, `models/`, `runtimes/<platform>/`, `manifest/`, etc.
  (ARCHITECTURE.md §2).
- **Safe writes** — staged `.new` + atomic rename for all metadata; append-only for logs;
  finalize markers for interrupt recovery.
- **No-symlink invariant** — enforced in a mode so the codebase never emits symlinks
  (exFAT safety); a test asserts this across the tree.
- **Workspace registry** — project records (portable vs. external), offline/unavailable
  detection without deleting references, locking (see ARCHITECTURE.md §10).
- **Filesystem capability probing** — case sensitivity, permissions, symlink support, free
  space; exposed to `core/diagnostics`.

## Boundaries

- No dsh knowledge; no protocol knowledge.
- No global state; all paths derived from an injected root.

## Status

Phase 0 — skeleton. Implementation is Phase 1.
