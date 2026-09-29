# ADR-003: Android uses local PRoot-based execution

**Status:** Accepted — Phase 0 (implementation gated by R-01)
**Date:** 2026-09-29

## Context

The brief requires Android to be an *actual local execution node*, not merely a remote client,
built on the Mobile-Harness approach: Kotlin app → native bridge → PRoot → Linux userspace →
Node runtime → DeepSeek Harness. The audited Mobile-Harness (MIT) proves this architecture runs
a coding-agent CLI on-device with no root: vendored PRoot (5.1.107.91) + libandroid-shmem +
talloc, a C spawn bridge, and an arm64-v8a-only build. It already includes a DeepSeek Harness
driver as one of its built-in agents.

Android cannot execute binaries from arbitrary USB filesystems, so workspace portability must
follow a different path than desktop.

## Decision

**Android is an execution node using PRoot-based local execution**, adapted from Mobile-Harness:

- Import Mobile-Harness **with git history** as the `android/` subtree (approved approach),
  preserving its MIT LICENSE and notices.
- Reuse unmodified: PRoot/shmem/talloc build, the APK carrier-executable trick, the native
  spawn bridge.
- Adapt: agent/runtime bridge abstractions, Keystore vault, workspace checkpoints, foreground
  services, runtime installer — restructured into the execution-node architecture.
- Workspace portability via Storage Access Framework import/export into app-private storage,
  with checksum verification and conflict detection — **never direct execution from USB**.
- The node server (protocol, pairing, replay) is added, since Mobile-Harness has none
  (AUDIT §4.6).

## Alternatives considered

1. **Termux-dependent model.** Rejected: requires a separate app and user-visible terminal
   tooling; the vendored PRoot build keeps everything self-contained.
2. **Cloud-side execution with thin Android client.** Rejected: violates offline-first
   (ADR-006) and the brief's "no cloud dependency".
3. **Remote-control only on Android.** Rejected: the brief requires Android to be a genuine
   local execution node.

## Consequences

- A real ARM64 device is required for meaningful validation (R-11, R-12).
- **R-01 is unresolved**: dsh running inside this PRoot environment is source-plausible but
  has never been executed by us. A real-device smoke test (Node → dsh → prompt → event →
  shutdown) is a hard **Phase 1/3 gate**. If it fails, fallback: ship the Android node
  client-first with execution deferred, per RISK-REGISTER.md — we will not fake support.
- Known hard limits carry over: PRoot is not a security boundary; no systemd/KVM/mounts;
  process-bridge terminal (not full PTY); background execution needs foreground services plus
  user-granted battery exemption.

## Risks

- R-01 dsh-on-Android compatibility (unresolved), R-11 background limits, R-12 PRoot limits.
- Vendored license obligations must be read and recorded at import (R-08) — the parent repo's
  MIT does not cover proot/talloc/libandroid-shmem or the rootfs image.
