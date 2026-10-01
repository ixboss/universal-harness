# ADR-003: Android uses local PRoot-based execution

**Status:** Accepted — Phase 0 (implementation gated by R-01); **import strategy amended 2026-10-01** (clean snapshot replaces git-history import)
**Date:** 2026-09-29 (amended 2026-10-01)

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

- Import Mobile-Harness as a **clean source snapshot at pinned upstream commit `f0ba6730`**
  (`f0ba6730b1522ce3225cf84089305d6d1e7df905`, tree `0ae06e7b…`) as the `android/` subtree,
  preserving its MIT LICENSE and notices. **No `.git` history is imported.** Source provenance
  is preserved through [android/PROVENANCE.md](../../android/PROVENANCE.md), which records the
  exact upstream commit, tree hash, import date, and verification results.
- **Why not git history:** upstream history contains a hardcoded API credential (`sk-d0c486…`,
  redacted) committed in `2cf2fe98` (2026-08-20) and removed from the tree in `badbe9ee`
  (2026-08-21) but still reachable from upstream `main` history and delivered to every fresh
  clone. Full-history import would republish that credential in this public repository. The
  historical credential makes full-history import prohibited regardless of the file's removal
  from the current tree.
- **Sanitized-history import was rejected** as unnecessary complexity: a `git filter-repo`
  rewrite removes the credential but permanently breaks 1:1 upstream commit mapping, forcing a
  re-filtering exercise on every future upstream sync, with no security benefit over a snapshot
  (which never copies the credential at all).
- **Submodule/fork-based import was rejected** for the same security/provenance reason: a fork
  under our account would itself display the leaked upstream history, and a submodule cannot
  express the required modifications of Mobile-Harness code.
- The two native dependencies upstream carried as git submodules are **vendored at their pinned
  commits** (PRoot `61681c64` = v5.1.107.91, GPL-2.0-or-later; libandroid-shmem `7f0bd7e2` =
  v0.7, BSD-3-Clause), with license texts verbatim; talloc 2.4.3 (LGPL-3.0-or-later) was already
  in-tree upstream.
- **Future updates must be performed as explicitly pinned clean snapshots**, each repeating the
  credential/security verification and the license/notices review before it is committed
  (procedure in PROVENANCE.md).
- Reuse unmodified: PRoot/shmem/talloc build, the APK carrier-executable trick, the native
  spawn bridge.
- Adapt: agent/runtime bridge abstractions, Keystore vault, workspace checkpoints, foreground
  services, runtime installer — restructured into the execution-node architecture. New
  Universal Harness Android code lives only in new files/packages (planned
  `com.universalharness.node`), never entangled with upstream files except where an adaptation
  is unavoidable.
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
