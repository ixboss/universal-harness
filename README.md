# Universal Harness

**Universal Harness** is a portable, cross-platform infrastructure layer that makes
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`@deepseek-ai/dsh`, MIT)
run anywhere — a USB stick, a desktop, an Android phone — and be controllable from an iPhone/iPad
over the local network, with no cloud dependency.

> **Status: Phase 2 checkpoint — Universal Protocol node server implemented on the Phase 1 desktop core.**
> Phase 0/0.1 delivered architecture, audit, protocol schemas, and skeletons. Phase 1 implements
> the real desktop execution layer: bundled Node, pinned integrity-verified `@deepseek-ai/dsh`,
> the SDK adapter, portable workspace/session management, diagnostics, and safe shutdown.
> Phase 2 adds the Universal Protocol v1 node server: schema-validated envelopes, Ed25519
> challenge-response authentication and single-use pairing tokens bound to the node identity,
> scoped authorization, the task engine with durable event log (one fsynced record per state+event
> commit), cursor replay and startup recovery, the workspace file API, and `uh serve`/`uh pair`
> over a local stdio transport. Not yet implemented (deliberately): network transports
> (TCP/TLS/WS/mDNS), terminal execution (hard-disabled), the `session.*`/`task.approve`
> operations, and the iOS/Android clients. Automated suite: 121 tests passing on Windows
> (`node --test tests/*.test.mjs`). Verification status per platform is recorded honestly in
> [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md): **Windows x64 real-machine smoke test executed
> (14/15 stages pass; stage 10 blocked by the provider account's own quota, not by the harness
> chain)**, **Linux x64 and macOS: NOT TESTED** (no Linux/macOS host available); the Phase 2
> node's real-dsh end-to-end path is exercised with a fake executor only. See
> [docs/ROADMAP.md](docs/ROADMAP.md).

## What Universal Harness is

```
Universal Harness = Portable Environment
                   + Execution Nodes
                   + DeepSeek Harness Adapter
                   + Universal Protocol
                   + Portable State / Migration
                   + Security
                   + Remote Control
                   + Recovery
```

**What it is not:** a replacement for DeepSeek Harness. The upstream Harness is the actual
AI/execution layer — always unmodified, always driven through an adapter
([ADR-001](docs/adr/ADR-001-deepseek-harness-engine.md)).

## Execution nodes vs. control clients

| Platform | Architecture | Role |
|---|---|---|
| Windows | x64 | **Execution node** — runs the Harness locally |
| Linux | x64 | **Execution node** |
| macOS | Apple Silicon (arm64) | **Execution node** |
| Android | arm64 | **Execution node** (PRoot Linux userspace) |
| iPhone / iPad | arm64 | **Control client only** — never runs the Harness ([ADR-002](docs/adr/ADR-002-ios-client-only.md)) |

## Key properties

- **Truly portable** — relative paths only, no system Node/pnpm/Python/Git dependency, no
  registry installs, no symlinks (exFAT-safe). Move the folder between Windows, Linux, and
  macOS; projects, sessions, and settings travel with it.
- **Portable workspaces** — projects live in `data/projects/` by default; external projects are
  supported and marked offline rather than corrupted when unavailable.
- **Session migration** — host-specific paths are rewritten when crossing platforms;
  conversation content is never rewritten; backups precede every destructive change.
- **Node-authoritative tasks** — a task keeps running when the iPhone disconnects; missed
  events are replayed on reconnect ([ADR-005](docs/adr/ADR-005-node-authoritative-state.md)).
- **LAN-first, offline-capable** — mDNS discovery, QR pairing, encrypted authenticated
  transport. Pairing binds the node's cryptographic identity into the QR payload, so a stolen
  pairing token cannot be replayed by a different peer ([ADR-007](docs/adr/ADR-007-security-and-pairing.md)).
  No account, no relay, no hosted database ([ADR-006](docs/adr/ADR-006-lan-first-protocol.md)).
- **Crash-consistent tasks** — task-state transitions and durable events commit atomically;
  eventId gaps are expected, replay is cursor-based, and snapshot fallback means a client can
  never permanently infer a false task state ([ADR-005](docs/adr/ADR-005-node-authoritative-state.md)).
- **Safe updates** — wrapper / Harness / runtime / toolchain update independently, staged and
  verified before activation, with rollback ([ADR-008](docs/adr/ADR-008-update-and-rollback.md)).
- **Credentials never plaintext** — even though the workspace is portable
  ([ADR-007](docs/adr/ADR-007-security-and-pairing.md)).

## Repository layout

```
universal-harness/
├── docs/                   AUDIT, ARCHITECTURE, REUSE-MAP, PROTOCOL, COMPATIBILITY,
│                           ROADMAP, TESTING, RISK-REGISTER, adr/ADR-001..008
├── bin/                     uh.mjs CLI + UniversalHarness.cmd / .sh launcher shims
├── manifests/               runtime.manifest.json — pinned Node + dsh with hashes
├── core/                    runtime manager, SDK adapter, workspace/sessions,
│   ├── platform/            platform/arch detection and supported targets
│   ├── paths/               portable root discovery + portable/device path split
│   ├── integrity/           SHA-256 verification, timing-safe comparison
│   ├── errors/              stable error codes, redaction, safe context
│   ├── logging/             redacted JSONL logger
│   ├── runtime/             manifest load/validate, status, download+verify+install
│   ├── adapter/             dsh SDK JSON-RPC adapter (the only dsh seam)
│   ├── workspace/           workspace registry + project index
│   ├── sessions/            dsh session discovery, replay, UH session index
│   ├── migration/           workspace move detection + recorded-root migration
│   ├── backup/              backup/restore with per-file checksums
│   ├── config/              portable config + device-local secret routing
│   ├── secrets/             secure storage (Windows DPAPI; explicit fail elsewhere)
│   ├── shutdown/            idempotent safe-shutdown manager + signal hooks
│   ├── diagnostics/         doctor checks with Expected/Actual/Action reporting
│   ├── cli/                 CLI modes (setup/doctor/smoke/exec) + metadata commands
│   ├── protocol/            Universal Protocol message handling (Phase 2)
│   ├── portable/            portable fs helpers, locks (Phase 2 expansion)
│   ├── update/              staged update/rollback (Phase 6)
│   └── server/              execution-node server (Phase 2)
├── desktop/                 launcher + per-platform entry scripts (windows/linux/macos)
├── android/                 Android execution node (Phase 3: adapted Mobile-Harness)
├── ios/                     iOS/iPadOS control client (Phase 4, Swift)
├── shared/protocol/         machine-readable protocol contract (JSON Schema)
├── tests/                   automated suite (41 tests) + protocol validators
└── third_party/             vendored components (with their LICENSE files)
```

The *portable distribution layout* (what ends up on the USB stick) is defined in
[docs/ARCHITECTURE.md §2](docs/ARCHITECTURE.md#2-portable-distribution-layout).

## Phase 1 — what is implemented

Implemented and automated-tested (41/41 tests pass, see [docs/TESTING.md](docs/TESTING.md)):

- **Bundled runtime** — Node v24.21.0 per platform, downloaded from nodejs.org with SHA-256
  verified *before* unpacking, and a whole-tree hash recorded on install so tampering is
  detectable later. No system Node/npm/Python/Git is required.
- **Pinned dsh** — `@deepseek-ai/dsh` 0.2.0-rc.2 installed through the bundled npm with an exact
  pin; integrity recorded from the lockfile. dsh is spawned **unmodified** — never forked,
  never patched ([ADR-001](docs/adr/ADR-001-deepseek-harness-engine.md)).
- **SDK adapter** — the only seam to dsh: newline-delimited JSON-RPC over stdio against
  `dsh --profile sdk` (`initialize` / `session/prompt` / `shutdown` + `session.event`,
  `session.status`, `subagent.*` notifications). Locates, verifies, launches, initializes, sends
  prompts, streams events, terminates with bounded escalation, recovers, and reports exit codes
  and stderr. Non-protocol output on stdout is tolerated, never crashing the pump.
- **Process lifecycle** — startup/init timeouts, graceful `shutdown` with a natural-exit grace
  window before signal escalation, bounded SIGTERM→SIGKILL fallback, exit-code capture, and
  tree-wide kill so no orphaned dsh processes survive.
- **Portable state** — `data/{projects,sessions,config,workspace,backups,logs}` + `manifests/` +
  `diagnostics/`; relative paths only; workspace registry + project index; session discovery and
  replay reading dsh's own persistence format (plain JSONL and concatenated Zstd frames).
- **Migration foundation** — a moved workspace is detected, recorded roots rewritten, a backup is
  taken first, and history is retained.
- **Security model, desktop portion** — stable error codes with actionable guidance; log and
  diagnostics redaction; credentials routed to device-local secure storage (Windows DPAPI) and
  **never** written as plaintext into the portable tree; on platforms without secure storage the
  write **fails explicitly** rather than degrading to plaintext.
- **Doctor** — machine-readable diagnostics with Expected/Actual/Action per failed check,
  including a live launch/initialize/shutdown execution probe and a plaintext-secret scan.
- **Safe shutdown** — idempotent shutdown manager with an ordered phase sequence and signal hooks.
- **Launcher** — `bin/UniversalHarness.cmd` / `.sh` shims that exec the *bundled* node, and the
  `uh` CLI (`setup`, `doctor`, `runtime`, `workspace`, `session`, `migrate`, `backup`, `restore`,
  `exec`, `smoke`, `version`).

Not in Phase 1 scope (by the brief's strict boundary): Android, PRoot, iOS, LAN discovery,
pairing, the Universal Protocol server, remote control, cloud backend, event sync, distributed
orchestration, Mobile-Harness import, and any dsh fork — none of these are implemented.

## Verification levels (never blurred)

| Level | Meaning |
|---|---|
| **planned** | described in documents only |
| **source-level evidence** | read directly from upstream source (AUDIT.md) |
| **automated-tested** | executed in the test suite against fixtures |
| **real-platform verified** | the mandated full-chain smoke test passed on a real platform |

Windows x64 is **not** marked fully verified: the real full chain was executed end to end on this
Windows 11 x64 host (14/15 stages pass), but stage 10 (model completion) could not complete
because the only available provider credential returns `Insufficient Balance (code QUOTA)` — a
provider-account limitation, not a defect in the portable chain. That is reported as a failure,
not papered over. Linux x64 and macOS are **NOT TESTED** — no Linux or macOS host is available
(macOS Apple Silicon remains architecturally supported and explicitly unverified, which the
brief accepts).

## Phase 0 documents

- [docs/AUDIT.md](docs/AUDIT.md) — source-verified audit of Deepseek-Harness-Portable,
  Mobile-Harness, and upstream DeepSeek Harness, including the licensing finding that forces
  clean-room reimplementation of the desktop wrapper.
- [docs/REUSE-MAP.md](docs/REUSE-MAP.md) — REUSE / ADAPT / REIMPLEMENT / DO NOT USE
  classification of every major component, with rationale.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — target architecture, state model, security
  model, recovery and update models.
- [docs/PROTOCOL.md](docs/PROTOCOL.md) + [shared/protocol/](shared/protocol/) — Universal
  Protocol v1, prose + machine-readable JSON Schema.
- [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) — platform matrix. Nothing is marked
  "Verified" without evidence.
- [docs/RISK-REGISTER.md](docs/RISK-REGISTER.md) — risks, mitigations, and explicitly
  unresolved items (notably: dsh-on-Android feasibility).
- [docs/ROADMAP.md](docs/ROADMAP.md) — implementation phases and the Phase 0 completion gate.
- [docs/TESTING.md](docs/TESTING.md) — test strategy and matrix.

## License

New code authored for Universal Harness: **MIT** (see [LICENSE](LICENSE)).

Bundled third-party components — including but not limited to DeepSeek Harness (`dsh`, MIT),
Node.js, PRoot, talloc, libandroid-shmem, and the Mobile-Harness-derived Android node — carry
their own licenses, recorded with evidence in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Deepseek-Harness-Portable (techjarves) is used **as a design reference only**: it carries no
license, so none of its source code is copied into this project. See
[docs/AUDIT.md §3](docs/AUDIT.md#3-deepseek-harness-portable-repo-a--design-reference-only).
