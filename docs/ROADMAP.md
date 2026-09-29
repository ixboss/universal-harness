# Roadmap

**Phase 0 deliverable.** Implementation order per the brief §37, with per-phase definition of
done. Per the brief: work incrementally; after every phase, build → test → inspect logs → fix →
document — only then continue. **Do not start the next phase without explicit approval.**

---

## Phase 0 — Architecture & Audit ✅ (this checkpoint)

Complete. Deliverables: AUDIT, REUSE-MAP, ARCHITECTURE, PROTOCOL, COMPATIBILITY, TESTING,
RISK-REGISTER, 8 ADRs, machine-readable protocol schemas, package skeletons.

**Definition of done:** the 29-item completion gate in §37 of the brief, mapped in the table
below. Nothing functional implemented (item 29).

| Gate item (brief §37) | Where satisfied |
|---|---|
| 1–3. Repos inspected, upstream inspected, source-backed claims | [AUDIT.md](AUDIT.md) §1–§5 |
| 4. dsh integration method + gaps | [AUDIT.md](AUDIT.md) §2, [PROTOCOL.md](PROTOCOL.md) §10 |
| 5–8. Windows/Linux/macOS/Android execution architecture | [ARCHITECTURE.md](ARCHITECTURE.md) §3, §7 |
| 9. Android dsh feasibility | [RISK-REGISTER.md](RISK-REGISTER.md) R-01 — **explicitly unresolved** |
| 10. Portable vs device-local state | [ARCHITECTURE.md](ARCHITECTURE.md) §4 |
| 11. Workspace/session migration | [ARCHITECTURE.md](ARCHITECTURE.md) §14 |
| 12. Protocol v1 machine-readable | [shared/protocol/v1/](../shared/protocol/v1/) + [PROTOCOL.md](PROTOCOL.md) |
| 13. Reconnect/event recovery | [PROTOCOL.md](PROTOCOL.md) §5 |
| 14. Capability negotiation | [PROTOCOL.md](PROTOCOL.md) §3, capabilities.schema.json |
| 15. Security/pairing/authorization | [PROTOCOL.md](PROTOCOL.md) §4 |
| 16. Terminal security | [PROTOCOL.md](PROTOCOL.md) §8 |
| 17. File conflict behavior | [PROTOCOL.md](PROTOCOL.md) §7 |
| 18. USB failure behavior | [ARCHITECTURE.md](ARCHITECTURE.md) §12 |
| 19. Offline behavior | [ARCHITECTURE.md](ARCHITECTURE.md) §15 |
| 20. Update/rollback behavior | [ARCHITECTURE.md](ARCHITECTURE.md) §8 |
| 21. Doctor/diagnostics model | [ARCHITECTURE.md](ARCHITECTURE.md) §9, operations.schema.json |
| 22. Crash/recovery semantics | [ARCHITECTURE.md](ARCHITECTURE.md) §11 |
| 23. Concurrency rules | [ARCHITECTURE.md](ARCHITECTURE.md) §10 |
| 24. Test matrix | [TESTING.md](TESTING.md) |
| 25–26. Licensing evidence + notices plan | [AUDIT.md](AUDIT.md) §3.5, [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) |
| 27. Risks with mitigations | [RISK-REGISTER.md](RISK-REGISTER.md) |
| 28. ADRs | [docs/adr/](adr/) |
| 29. No functional implementation | by construction |

---

## Phase 1 — Portable Desktop Core

Portable filesystem, runtime manager, launcher, workspace management, session migration,
diagnostics, reset, update system. Targets **Windows + Linux first, then macOS**.

Definition of done:

- Fresh-install and second-launch paths work on Windows x64 and Linux x64 from a USB stick.
- Migration round-trip (Win→Linux→Win) preserves sessions; conversation content byte-identical.
- `doctor` reports all severities with actionable actions.
- Update + rollback exercise on all four channels.
- **R-01 gating test cannot run in Phase 1** — it stays open (see Phase 3).

Exit criteria: automated desktop test suite green; migration test matrix green; logs inspected.

## Phase 2 — Universal Protocol & Node Server

Execution-node API (WSS + HTTPS), authentication, capability discovery, event streaming, task
lifecycle, file API, terminal API, pairing, missed-event replay. Tested locally before iOS.

Definition of done: protocol conformance suite passing against the desktop node; fixture suite
shared across stacks; negative-path tests (auth failure, revoked device, malformed request,
version mismatch) green.

## Phase 3 — Android Execution Node

Import Mobile-Harness **with git history** into `android/` (approved approach); read and record
all vendored licenses (R-08 closure); restructure into execution-node architecture; add device
identity, pairing, protocol server, persistent background tasks.

**Definition of done includes the R-01 gate:** real ARM64 smoke test
(Node → dsh → prompt → streamed event → shutdown) passing. If it fails, the fallback in
RISK-REGISTER.md applies and Android ships as client-first with deferred execution.

## Phase 4 — iOS Client

Swift/SwiftUI: discovery, QR pairing, device list, projects, sessions, task streaming,
terminal, file browser, logs, notifications, reconnect/resume.

Definition of done: builds on macOS; real-device tests of TESTING.md §4 pass. Until then all iOS
rows remain **Not tested** (R-10).

## Phase 5 — Cross-Platform Synchronization

Portable workspace import/export, conflict detection (never auto-overwrite), backups,
migration matrix including Android, device sync.

## Phase 6 — Hardening

Security review, crash recovery, corrupted-runtime recovery, protocol fuzzing where practical,
performance, storage, battery/background soak, real-device workflows A–F from the brief.

## Phase 7 — Packaging & Release

Desktop portable packages (per platform), Android APK, iOS build, docs, checksums, release
notes, regenerated THIRD_PARTY_NOTICES.md, compatibility matrix updated with real evidence.

---

## Standing rules (every phase)

1. Build. 2. Run automated tests. 3. Run platform-specific tests. 4. Inspect logs.
5. Fix failures. 6. Update documentation (including COMPATIBILITY.md evidence rows and
RISK-REGISTER.md statuses). 7. Then continue — with explicit approval at each phase boundary.

**Do not fake capabilities.** If something is impossible on a platform, document the limitation
and implement the closest technically correct alternative (see ARCHITECTURE.md §19).
