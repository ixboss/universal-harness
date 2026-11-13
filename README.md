# Universal Harness

**Universal Harness** is a portable, cross-platform infrastructure layer that runs AI harnesses
anywhere — a USB stick, a desktop, an Android phone — and be controllable from another
machine over the local network, with no cloud dependency. v1.0.0 ships a **Multi-Harness
adapter registry** (DeepSeek dsh, OmniRoute, Claude Code, Gemini CLI, any OpenAI-compatible
local gateway), a **Dual-Mode Android app** (LAN Remote Controller + Standalone On-Device
Server), and ready-made **portable USB bundles**.

<p align="center">
  <img alt="version" src="https://img.shields.io/badge/version-1.0.0-22c55e?style=flat-square" />
  <img alt="license" src="https://img.shields.io/badge/license-MIT-22c55e?style=flat-square" />
  <img alt="tests" src="https://img.shields.io/badge/tests-249%20passing-22c55e?style=flat-square" />
  <img alt="platforms" src="https://img.shields.io/badge/platforms-Windows%20%7C%20Linux%20%7C%20macOS%20%7C%20Android-0ea5e9?style=flat-square" />
  <img alt="no cloud" src="https://img.shields.io/badge/cloud-not%20required-64748b?style=flat-square" />
</p>

## Quick start

```bash
git clone https://github.com/ixboss/universal-harness.git
cd universal-harness

./bin/UniversalHarness.cmd      # Windows   (use ./bin/UniversalHarness.sh on Linux/macOS)
uh setup                        # download + verify the pinned runtime and dsh
uh doctor                       # check this machine
uh exec "summarise the README"  # one-shot prompt through the pinned dsh
```

No system Node, npm, Python or Git is required — the launcher runs the *bundled* runtime. Move
the whole folder to a USB stick and it keeps working.

**Move a workspace between machines** (Phase 5):

```bash
uh export --out ./backup.uhbundle      # metadata-only, checksummed directory bundle
uh export verify ./backup.uhbundle     # verify before trusting it
uh import --bundle ./backup.uhbundle   # verify-then-commit; never overwrites
```

> **Status: Phase 3C — controller and session foundation.** Phases 0/0.1 (architecture, schemas),
> 1 (portable desktop core), 2 (Universal Protocol v1 node server), 3A (Android runtime
> foundation; R-01 RESOLVED on a real moto g 5G plus), 3B (Android network transport, discovery
> over mDNS/NSD, and secure pairing — TLS node listener with ALPN framing, pinned certificates,
> Ed25519 challenge-response, identity-bound pairing, durable event replay; verified on real
> hardware and over cross-device LAN), and 3C (session operations with linked-continuation
> semantics per ADR-009, cursor-paginated task history, `clientRequestId` idempotent task
> submission, bounded connections, real `diagnostics.run`, the `core/client` UniversalClient
> library, and the `uh connect` controller CLI) are implemented and verified on a Windows
> desktop node (Gate F 28/28 and a live `uh connect` end-to-end pass) **and against the physical
> Android device over Wi-Fi (Gate F 28/28)**. Phase 5 (cross-platform synchronization)
> stages **S1–S3 are implemented** — safety primitives plus `uh export` / `uh import`
> workspace bundles ([ADR-011](docs/adr/ADR-011-workspace-bundles.md)); stage S4 (the Android
> leg) is outstanding and requires the physical device. Still deliberately out of scope:
> hardening soak (Phase 6), the update system, and terminal execution (hard-disabled).
> Automated suite: 249 tests passing on Windows
> (`node --test tests/*.test.mjs`); Android JVM suite 270/270 across both flavors. Verification
> status per platform is recorded honestly in [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md):
> **Windows x64 smoke-executed (14/15; stage 10 blocked by the provider account's own quota —
> R-21)**, **Android: real-device verified through the Phase 3A runtime chain, the Phase 3B
> network/pairing surface, and the Phase 3C controller gate (Gate D 8/8, Gate E 9/9, Gate F 28/28
> on the physical moto g 5G plus over Wi-Fi) — provider completion stages are blocked by R-21**,
> **Linux/macOS: NOT TESTED** (no host).
> See [docs/ROADMAP.md](docs/ROADMAP.md).

## Multi-Harness adapters

The harness engine is pluggable — `uh serve`, `uh exec` and the Android controller all select
an adapter from the registry in `core/adapter/registry.mjs`:

| Adapter | Transport | Typical use |
|---|---|---|
| `deepseek` | `@deepseek-ai/dsh` stdio JSON-RPC | the original, hash-pinned dsh SDK harness |
| `omniroute` | OpenAI-compatible HTTP + SSE | a local multi-account OmniRoute router/gateway |
| `openai-compatible` | OpenAI-compatible HTTP + SSE | any local router: llama.cpp server, LM Studio, Ollama `/v1`, vLLM |
| `claude-code` | CLI process (stream JSON) | the Claude Code CLI |
| `gemini-cli` | CLI process | the Gemini CLI |

Select the active harness three ways (in precedence order):

```bash
uh serve --adapter omniroute            # 1. CLI flag
UH_ADAPTER=claude-code uh serve         # 2. environment variable
# 3. data/config/config.json → { "adapter": { "harness": "gemini-cli" } }
```

`uh adapters` lists the registered adapters and the active one. Per-adapter settings live in
`config.json` (`adapter.omniroute.baseUrl`, `adapter.claudeCode.command`, …) with
`UH_OMNIROUTE_*` / `UH_OPENAI_*` / `UH_CLAUDE_*` / `UH_GEMINI_*` environment overrides. API keys
are never stored in the portable config — use the OS secure store or environment variables.

## Dual-Mode Android app

The Android app runs in either of two first-class modes, chosen from the switcher at the top of
the app and persisted on the device:

- **Mode 1 — LAN Remote Controller**: connect over Wi-Fi/LAN to a Universal Harness node running
  on a PC, laptop or USB stick (`uh serve --listen tls://0.0.0.0:7437`). Paste the pairing
  payload from `uh pair --endpoint https://<host>:<port>` once; the app then authenticates with
  its own Ed25519 device key over TLS with the pinned certificate fingerprint. Sessions can be
  listed/created and tasks started and observed remotely — with **zero local rootfs
  requirement** in this mode.
- **Mode 2 — Standalone On-Device Server**: the embedded Node.js/PRoot harness runtime runs
  directly on the phone as a foreground service (`NodeServerService`, advertised over
  mDNS/NSD). The phone is a self-contained portable server; other machines on the LAN pair
  with it via `uh pair` + `uh connect`, or another phone in LAN Remote mode.

## USB flash drive setup

Build a ready-to-run portable bundle (Node runtimes are downloaded and SHA-256 verified against
`manifests/runtime.manifest.json`, then staged into the bundle):

```bash
node scripts/build-desktop.mjs --all --out dist   # win-x64 + linux-x64 + macos-arm64 + universal
node scripts/publish-release.mjs --out dist       # SHA256SUMS.txt (+ --publish → GitHub Release)
```

This produces `UniversalHarness-<version>-usb-<target>.zip|.tar.gz` plus a
`UniversalHarness-<version>-usb-universal.zip` carrying **all three runtimes and all three
desktop launchers** — one stick starts on any OS. Copy the folder to a USB stick and
double-click the launcher for the machine you are sitting at:

| Platform | Launcher |
|---|---|
| Windows | `desktop/windows/UniversalHarness.bat` |
| Linux | `desktop/linux/UniversalHarness.sh` |
| macOS | `desktop/macos/UniversalHarness.command` |

Each launcher resolves the portable root from its own location, starts
`uh serve --listen tls://0.0.0.0:7437`, and prints the LAN addresses a controller can pair
with. `data/` and `logs/` exist out of the box, so first launch never hits
`UH_ROOT_NOT_FOUND` (exit 12). Release automation lives in
[.github/workflows/release.yml](.github/workflows/release.yml); CI in
[.github/workflows/ci.yml](.github/workflows/ci.yml).

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

The controller surface is the `uh connect` CLI and the `core/client` library; it runs on the
desktop platforms and drives a node over the LAN. iPhone/iPad are **out of product scope**
([ADR-010](docs/adr/ADR-010-iphone-ipad-retired.md)).

## Key properties

- **Truly portable** — relative paths only, no system Node/pnpm/Python/Git dependency, no
  registry installs, no symlinks (exFAT-safe). Move the folder between Windows, Linux, and
  macOS; projects, sessions, and settings travel with it.
- **Portable workspaces** — projects live in `data/projects/` by default; external projects are
  supported and marked offline rather than corrupted when unavailable.
- **Session migration** — host-specific paths are rewritten when crossing platforms;
  conversation content is never rewritten; backups precede every destructive change.
- **Node-authoritative tasks** — a task keeps running when the controller disconnects; missed
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
│                           ROADMAP, TESTING, RISK-REGISTER, adr/ADR-001..010
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
│   ├── portable/            atomic write, advisory workspace lock, path guards (Phase 5 S1)
│   ├── bundle/              workspace export/import bundles (Phase 5 S2–S3, ADR-011)
│   ├── update/              staged update/rollback (Phase 6)
│   └── server/              execution-node server (Phase 2)
├── desktop/                 launcher + per-platform entry scripts (windows/linux/macos)
├── android/                 Android execution node (Phase 3: adapted Mobile-Harness)
├── scripts/                 build-desktop / verify-licenses / diagnose-ci / publish-release
├── .github/workflows/       CI + automated v* release pipeline
├── shared/protocol/         machine-readable protocol contract (JSON Schema)
├── tests/                   automated suite (249 tests) + protocol validators
└── third_party/             vendored components (with their LICENSE files)
```

The *portable distribution layout* (what ends up on the USB stick) is defined in
[docs/ARCHITECTURE.md §2](docs/ARCHITECTURE.md#2-portable-distribution-layout).

## Phase 1 — what is implemented

Implemented and automated-tested (the full suite is now 244 tests — see [docs/TESTING.md](docs/TESTING.md)):

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

Not in Phase 1 scope (by the brief's strict boundary): Android, PRoot, LAN discovery,
pairing, the Universal Protocol server, remote control, cloud backend, event sync, distributed
orchestration, Mobile-Harness import, and any dsh fork — none of these are implemented.

## Phase 5 — portable workspace bundles

Move a workspace between machines without a cloud account:

- **`uh export --out <dir>`** writes a versioned, self-describing, checksummed **directory**
  bundle ([ADR-011](docs/adr/ADR-011-workspace-bundles.md)). Metadata only by default (workspace
  identity, registry, config, session index, migration history, project markers);
  `--include-projects` adds project source trees.
- **`uh import --bundle <dir>`** is **verify-then-commit**: every entry's SHA-256 and the
  manifest checksum are checked before anything is written, and a bundle may only carry an
  allowlisted set of paths. It **never overwrites** — a target that already differs aborts the
  whole import with a per-file report (`IMPORT_CONFLICT`); identical files are skipped, so
  re-importing is idempotent.
- **`uh export verify <dir>`** checks a bundle and writes nothing.

Nothing device-local, secret, regenerable or node-owned ever travels: no secrets, no logs, no
runtime, no event log, no nested backups. An absolute source path never travels either — the
recorded root is re-derived on the importing machine. Both commands hold the advisory workspace
lock, so two Universal Harness commands never mutate one workspace at once.

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
- [docs/RISK-REGISTER.md](docs/RISK-REGISTER.md) — risks, mitigations, and open items.
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
