# desktop/linux

Linux x64 execution-node entry points and platform specifics.

## Scope (planned)

- `UniversalHarness` — POSIX entry shim (`#!/bin/sh`, script-relative root, exec launcher).
- Bootstrap: arch detection (x64), glibc detection (musl unsupported in inherited scope),
  runtime activation.
- Linux-specific behavior: POSIX path canonicalization, permissions/umask, terminal semantics,
  process groups for clean shutdown (SIGTERM/SIGINT handling per AUDIT §2.4).
- No system Node/pnpm/Python/Git dependency for the portable runtime itself.

## Status

Phase 0 — skeleton. Implementation is Phase 1. Target: Linux x64 (glibc).
