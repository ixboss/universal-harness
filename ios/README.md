# ios (control client)

**Phase 0 — placeholder.** The iOS/iPadOS client is authored in **Phase 4** (ROADMAP.md).

## Role (ADR-002)

Control client **only** — never a local harness runtime. Connects to execution nodes
(Windows / Linux / macOS / Android) over the Universal Protocol v1.

## Planned scope

- Device discovery (mDNS) and manual endpoint fallback
- QR pairing (Keychain-stored device identity keypair)
- Node status + capabilities (gated by capability negotiation)
- Projects, sessions, conversation viewing
- Prompt sending + streaming agent output (`task.*` events)
- Task control (cancel; approvals via `task.waiting` / `task.approve`)
- Terminal (explicit-scope only), file browsing + editing
- Logs, diagnostics, update/repair controls, start/stop/restart where authorized
- Reconnect/recovery: missed-event replay, authoritative snapshot reconciliation
- Local notifications for task completion/failure/waiting

## Build constraint (documented, not hidden)

Swift/SwiftUI targets can only be compiled and tested on macOS. This host is Windows — so
[COMPATIBILITY.md](../docs/COMPATIBILITY.md) marks every iOS row **Not tested** until a Mac is
available (R-10). The client is implemented against the machine-readable contract in
[shared/protocol/v1/](../shared/protocol/) so protocol fidelity is verifiable via the shared
fixture suite (TESTING.md §6) even before device testing is possible.

## Status

Phase 0 — skeleton only; no code present.
