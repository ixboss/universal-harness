# desktop/macos

macOS Apple Silicon execution-node entry points and platform specifics.

## Scope (planned)

- `UniversalHarness.command` — double-click entry (POSIX shim) plus standard `UniversalHarness`.
- Bootstrap: arch detection (arm64; Intel unsupported in inherited scope), runtime activation,
  quarantine/Gatekeeper notes for downloaded bundles.
- macOS-specific behavior: APFS handling, sandbox-free layout (portable folder), keychain
  integration for the credential vault key (ADR-004), `open` for browser launch.
- No system runtime dependency; no `/usr/local` writes.

## Status

Phase 0 — skeleton. Implementation is Phase 1 (after Windows + Linux). **Not testable on this
host** — no macOS available (R-10 adjacent); COMPATIBILITY.md stays "Not tested" until then.
