# core/update

Staged, verified, rollback-capable updates across independent channels (ARCHITECTURE.md §8,
ADR-008).

## Channels

| Channel | What it updates |
|---|---|
| `universal-harness` | `core/` + launchers (our code) |
| `harness` | pinned `@deepseek-ai/dsh` (private portable prefix) |
| `runtime` | per-platform Node.js bundles |
| `toolchain` | optional toolchains (python, jdk, …) |
| `rootfs` | (Android node only) Ubuntu arm64 rootfs — mirrors the same lifecycle |

## Lifecycle

```
download → verify (SHA-256 or stronger) → stage → validate → activate (atomic promote)
        → health-check → rollback on failure
```

## Scope

- Versioned manifest schema (v2) with per-channel entries: version, sources, hashes.
- Manifest retention under `manifest/known/` for drift inspection and downgrade choices.
- Interrupted-install recovery via staged-state markers.
- Health checks post-activation; failure triggers automatic rollback to previous known-good.
- Offline tolerance: check-only failures never degrade a working installation.
- Doctor integration: update state surfaces as diagnostic checks.
- `update.check` / `update.apply` / `update.rollback` protocol operations (scope `update`).

## Boundaries

- Never touches user data (`data/projects`, `data/sessions`, `models/`).
- Harness channel consults `core/migration` for session-schema compatibility gating (R-14).

## Status

Phase 0 — skeleton. Implementation is Phase 1.
