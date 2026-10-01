# Roadmap

**Phase 1 update (2026-09-29).** Implementation order per the brief §37, with per-phase
definition of done. Per the brief: work incrementally; after every phase, build → test → inspect
logs → fix → document — only then continue. **Do not start the next phase without explicit
approval.**

---

## Phase 0 — Architecture & Audit ✅

Phase 0 (2026-09-29): AUDIT, REUSE-MAP, ARCHITECTURE, PROTOCOL, COMPATIBILITY, TESTING,
RISK-REGISTER, 8 ADRs, machine-readable protocol schemas, package skeletons.

**Phase 0.1 hardening pass (2026-09-29):** closed the first-pairing trust gap by binding node
identity into the QR payload (ADR-007, PROTOCOL.md §4, negative tests NEG-PAIR-01…06); defined
event durability and crash-consistency semantics with a machine-readable durability contract,
atomic state/event commits, and snapshot fallback (ADR-005, PROTOCOL.md §5); strengthened the
mandatory Windows x64 full-chain smoke gate and the Android real-device gate; extended the
schema linter to enforce the durability contract. Documentation/schema/test-plan only — **no
implementation**.

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

## Phase 1 — Portable Desktop Core ✅ (implemented; awaiting review)

Portable filesystem, runtime manager, launcher, workspace management, session discovery and
replay, migration foundation, diagnostics, safe shutdown, backup/restore, secure storage.
Targets **Windows + Linux first, then macOS**; macOS is architecturally supported and explicitly
unverified (brief §20).

**Entry gate (Windows x64, mandatory, non-negotiable):** the real-environment 15-stage full-chain
smoke test of [TESTING.md §1a](TESTING.md#1a-phase-1-portable-execution-smoke-gate-windows-x64--mandatory) —
bundled Node → verified runtime → pinned/integrity-verified dsh → native dependencies load →
`dsh --profile sdk` → `initialize` → session → prompt → streaming events → completion → durable
session persistence → graceful shutdown → restart → reopen/replay.

**Outcome executed 2026-09-29 on Windows 11 Pro x64:** 14/15 stages PASS. Stage 10 (model
completion) FAILS because the only available provider credential returns
`Insufficient Balance (code QUOTA)` — a provider-account limitation outside this repository's
control. Reported as a failure, not a pass; the Windows row in
[COMPATIBILITY.md](COMPATIBILITY.md#platform-matrix) is **not** marked Verified until a funded
credential re-runs the gate. Linux x64 and macOS arm64 rows: **NOT TESTED** (no host available).

Definition of done — Phase 1 actual status:

- ✅ Fresh-install and second-launch paths work on **Windows x64** (smoke stages 01–05, 13);
  Linux equivalent NOT TESTED (no Linux host; pinned manifest exists, code avoids Windows-only
  APIs).
- ✅ Runtime never launched unverified: hash mismatch / wrong arch / wrong version are all
  refused (automated-tested), and the download is hash-checked **before** unpacking.
- ⚠ Migration: workspace move detection + recorded-root rewrite + backup-first migration is
  implemented and automated-tested; the cross-OS session-header rewrite round-trip (Win→Linux→Win)
  is **not implemented** (deferred — needs a Linux host to test honestly, and the brief requires
  dsh session internals stay owned by dsh).
- ✅ `doctor` reports severities with Expected/Actual/Action, a live execution probe, and a
  plaintext-secret scan.
- ❌ Update + rollback on four channels — **not implemented** (Phase 6 scope; the brief's Phase 1
  boundary lists the *update foundation* only: manifests, pinned versions, hash verification —
  all present in `manifests/runtime.manifest.json`).
- ✅ Safe shutdown: idempotent manager, ordered phases, signal hooks, graceful → bounded → forced
  escalation, no orphaned processes (automated-tested).
- ✅ Credentials never plaintext: Windows DPAPI secure storage; explicit failure on platforms
  without secure storage (automated-tested).
- ✅ **Android remains UNRESOLVED** (R-01) — no Android code exists in Phase 1 and no Android
  claim is made.
- ✅ No dsh fork: upstream `@deepseek-ai/dsh` is installed unmodified via npm and driven only
  through the SDK adapter (ADR-001 honored).

Exit criteria: **automated desktop test suite green (41/41)**; migration test matrix green;
smoke chain executed and honestly reported; logs inspected.

**Discovered upstream gap carried forward (new risk R-20):** the shipping SDK JSON-RPC server
wires `agents.create` but never `agents.resume`, so a persisted dsh session **cannot be reopened
over the seam in a new process** (`session "…" already exists`). Universal Harness therefore
implements reopen as: durable read of the prior session log (dsh's own format) + continuation in
a **new** session linked through the UH session index (`data/sessions/index.json`). This keeps
dsh owning session internals while Universal Harness owns the workspace/task metadata, exactly
per the brief. See [RISK-REGISTER.md](RISK-REGISTER.md) R-20.

## Phase 2 — Universal Protocol & Node Server

Execution-node API (WSS + HTTPS), authentication, capability discovery, event streaming, task
lifecycle, file API, terminal API, pairing, missed-event replay. Tested locally before iOS.

**Checkpoint status (implemented, committed):** the Universal Protocol v1 node server runs over a
local stdio transport (`uh serve`) with pairing (`uh pair`): schema-validated envelopes with
per-message version checks; capability advertisement in `node.hello`; Ed25519 node identity and
challenge-response device authentication; single-use pairing tokens persisted as SHA-256 hashes
(cross-process between `uh pair` and `uh serve`), bound to the node identity (NEG-PAIR-01);
central deny-by-default scope enforcement; a 10-state task engine with one fsynced NDJSON record
per state+event commit; cursor replay with snapshot fallback; startup recovery that re-drives
requeued tasks and never marks a vanished process as completed; durable cancellation of non-live
tasks; the workspace file API (central path-safety choke point, optimistic concurrency); and an
executor that drives the unmodified Phase 1 dsh adapter.

**Deliberately not in this checkpoint:** network transports (WSS/HTTPS/mDNS discovery) — the
interface is stdio/memory only until Phase 3 needs them; terminal execution (hard-disabled behind
`TERMINAL_DISABLED`, its scope ungrantable); the `session.list/create/read/resume` and
`task.approve` operations (removed from the advertisement until implemented); the iOS/Android
clients; real-dsh task execution over the protocol (tests use a fake executor; the Phase 1
adapter itself is real-machine tested separately).

Definition of done: protocol conformance suite passing against the desktop node; fixture suite
shared across stacks; negative-path tests (auth failure, revoked device, malformed request,
version mismatch) green. Conformance and negative-path suites exist and pass
(`tests/protocol-core.test.mjs`, `tests/server.test.mjs`, `tests/auth.test.mjs`,
`tests/transport.test.mjs`); the cross-stack fixture sharing (Kotlin/Swift) remains open until
Phases 3–4.

## Phase 3 — Android Execution Node

Import Mobile-Harness **with git history** into `android/` (approved approach); read and record
all vendored licenses (R-08 closure); restructure into execution-node architecture; add device
identity, pairing, protocol server, persistent background tasks.

**Definition of done includes the R-01 gate:** the real ARM64 full chain of
[TESTING.md §2a](TESTING.md#2a-android-execution-full-chain-gate--mandatory-currently-unresolved) —
app → PRoot → Ubuntu arm64 → bundled arm64 Node → dsh SDK → `initialize` → prompt → streaming
event → durable session event → shutdown → restart → reconnect → session/task state recovery.
A partial pass (PRoot + Node alone) is **not** success. If any stage fails, the exact blocker is
documented (native modules / Node ABI / signals / filesystem behavior / PRoot limitations /
permissions / background execution / process lifecycle / memory) and the fallback in
RISK-REGISTER.md applies: Android ships client-first with local execution deferred and its
COMPATIBILITY.md row stays **Unverified**. We do not claim support from Mobile-Harness's
Claude Code path alone.

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
