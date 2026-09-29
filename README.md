# Universal Harness

**Universal Harness** is a portable, cross-platform infrastructure layer that makes
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`@deepseek-ai/dsh`, MIT)
run anywhere — a USB stick, a desktop, an Android phone — and be controllable from an iPhone/iPad
over the local network, with no cloud dependency.

> **Status: Phase 0 — Architecture & Audit (complete, pending review).**
> This repository currently contains *only* architecture documents, machine-readable protocol
> schemas, and package skeletons. No functional implementation exists yet. See
> [docs/ROADMAP.md](docs/ROADMAP.md). **Phase 1 has not started.**

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
  transport. No account, no relay, no hosted database ([ADR-006](docs/adr/ADR-006-lan-first-protocol.md)).
- **Safe updates** — wrapper / Harness / runtime / toolchain update independently, staged and
  verified before activation, with rollback ([ADR-008](docs/adr/ADR-008-update-and-rollback.md)).
- **Credentials never plaintext** — even though the workspace is portable
  ([ADR-007](docs/adr/ADR-007-security-and-pairing.md)).

## Repository layout

```
universal-harness/
├── docs/                  AUDIT, ARCHITECTURE, REUSE-MAP, PROTOCOL, COMPATIBILITY,
│                          ROADMAP, TESTING, RISK-REGISTER, adr/ADR-001..008
├── core/                  shared TypeScript core (runs on bundled Node):
│   ├── protocol/          Universal Protocol message/event handling
│   ├── portable/          portable paths, fs, workspace registry, locks
│   ├── migration/         session/workspace path migration (schema-versioned)
│   ├── update/            manifests, staged install, verify, rollback
│   ├── diagnostics/       doctor checks (machine-readable)
│   ├── security/          device identity, pairing, credential vault
│   └── server/            execution-node WSS/HTTPS server
├── desktop/               launcher + per-platform entry scripts (windows/linux/macos)
├── android/               Android execution node (Phase 3: adapted Mobile-Harness)
├── ios/                   iOS/iPadOS control client (Phase 4, Swift)
├── shared/protocol/       machine-readable protocol contract (JSON Schema)
├── scripts/               build / packaging / release helpers
├── tests/                 cross-platform test suite
└── third_party/           vendored components (with their LICENSE files)
```

The *portable distribution layout* (what ends up on the USB stick) is defined in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#portable-distribution-layout).

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
[docs/AUDIT.md](docs/AUDIT.md#deepseek-harness-portable).
