# Compatibility Matrix

**Phase 1 update (2026-09-29).** Per the brief: *"Never mark something verified without actual
evidence."* Every unknown cell is **TBD**; every untestable-on-this-host cell is **Not tested**.
Nothing here says "Verified" until a real test produces evidence recorded in [TESTING.md](TESTING.md).

### Verification-level distinction (never blur)

| Level | Meaning | Counts as "Verified"? |
|---|---|---|
| **architecture planned** | described in documents only | **No** |
| **source-level evidence** | read directly from upstream/dependency source (see AUDIT.md) | **No** (informs feasibility only) |
| **automated test** | executed in CI against fixtures/harness | Only for that scope |
| **real-platform verification** | the mandated full-chain smoke test executed on the real platform | **Yes** — only this advances a row |

## Platform matrix

| Platform | Architecture | Execution mode | dsh | Runtime | Protocol | Tested |
|---|---|---|---|---|---|---|
| Windows | x64 | Local (bundled Node) | **Smoke-executed — 14/15 stages pass** (stage 10 blocked by provider account quota, TESTING.md §1a) | **Real-chain verified** (hash-verified Node v24.21.0 + pinned dsh booted) | N/A in Phase 1 (Phase 2) | Smoke executed on real Windows 11 x64; **not fully verified** |
| Linux | x64 | Local (bundled Node) | Automated-tested (source-level cross-check only) | Source-level (manifest hash pinned, code non-Windows-only) | N/A | **NOT TESTED** — no Linux host available (WSL not installed) |
| macOS | arm64 (Apple Silicon) | Local (bundled Node) | Not tested | Source-level (manifest hash pinned) | N/A | **NOT TESTED — acceptable per brief §20** (no macOS host) |
| Android | arm64 | Local via PRoot | **Unresolved (R-01)** — gated by real-device full chain (TESTING.md §2a) | Not implemented | Not implemented | Not implemented in Phase 1 (out of scope) |
| iPhone/iPadOS | arm64 | **Client only** | N/A (by design, [ADR-002](adr/ADR-002-ios-client-only.md)) | N/A | N/A | Not tested (no macOS host) |

> **Why Windows is not "Verified" despite executing the chain:** the brief §18 requires the full
> chain *including model completion* to pass on a real Windows x64 host. It was executed there
> (detailed report in `diagnostics/`, summarized in TESTING.md §1a) and 14 of 15 stages pass;
> stage 10 fails because the only available provider credential returns
> `Insufficient Balance (code QUOTA)` from the provider API — the provider account has no credit,
> which no implementation change in this repository can fix. The chain from bundled Node through
> streaming events, durable persistence, graceful shutdown, restart, reopen, and replay is proven
> on real Windows x64; the model-completion stage is blocked on the provider side and is reported
> as a failure, not a pass.

### Gate definitions (rows only advance when the named gate passes)

- **Windows x64** — the 15-stage full chain of TESTING.md §1a on a real Windows host: bundled
  Node → verified runtime → pinned dsh → native deps load → SDK profile → initialize → session →
  prompt → streaming → completion → durable session → graceful shutdown → restart → reopen →
  replay. **Executed 2026-09-29 on Windows 11 Pro x64: 14/15 pass; stage 10 (completion) blocked
  by provider quota — see the note above.**
- **Android arm64** — the full chain of TESTING.md §2a on a real ARM64 device, including reconnect
  and session/task state recovery. A partial pass (PRoot + Node alone) is not success; on failure
  the exact blocker is documented and the row stays **Unresolved**.
- **Linux x64 / macOS arm64** — the equivalent chain per platform. Neither can be executed in this
  environment: WSL is not installed (installing it needs admin + reboot and is not a Phase 1
  action), Git Bash is a MINGW userspace rather than a Linux kernel, and no macOS hardware exists.
  Both are **NOT TESTED** — an environmental limitation, not an architecture judgment. The
  linux-x64 and macos-arm64 manifest entries (Node v24.21.0, SHA-256 from nodejs.org) are pinned
  and hash-verifiable, and the code avoids Windows-only APIs except in the two deliberately
  platform-specific modules (`core/platform`, `core/secrets`).

## Unsupported platforms (inherited scope; deliberately out of range)

- Windows ARM64, Linux ARM64/musl, Intel macOS (upstream wrapper scope, AUDIT §3.4)
- iOS/iPadOS local execution (architecturally excluded, ADR-002)

## Runtime requirements (pinned targets — actually installed and verified in Phase 1)

| Component | Target | Notes |
|---|---|---|
| Bundled Node.js | **v24.21.0** | Per-platform (win-x64, linux-x64, macos-arm64); SHA-256 taken from nodejs.org `SHASUMS256.txt` and verified **before unpacking**; whole-tree hash recorded on install for tamper detection. Installed on win-x64; linux-x64/macos-arm64 pinned but not downloaded on this host. |
| Harness | **`@deepseek-ai/dsh` 0.2.0-rc.2** | Exact pin via bundled npm (`--omit=dev --no-audit --no-fund --exact`); SHA-512 integrity read from the generated lockfile and recorded in `manifests/runtime.manifest.json`. |
| Native deps (`koffi`, `node-pty`) | dsh's own dependency tree | Verified to load under the bundled Node's ABI on win-x64 (smoke stage 04); native modules are never built or patched by Universal Harness. |
| Android | 9+ API 28+, arm64-v8a only (per upstream CMake guard) | NDK 26.1.10909125, CMake 3.22.1, JDK 17 — Phase 3, not in Phase 1 scope |
| iOS/iPadOS | TBD (Phase 4) | Swift/SwiftUI; buildable only on macOS |
| Desktop filesystems | NTFS, ext4, APFS, exFAT | exFAT = no-symlink mode enforced; only NTFS exercised so far |

## Evidence log

| Date | Claim | Evidence | Status |
|---|---|---|---|
| 2026-09-29 | `dsh --profile sdk` exists as JSON-RPC application | Upstream `apps/cli/src/sdk-source.cordis.patch.yml` source (AUDIT §2.3) | Source-verified |
| 2026-09-29 | dsh SDK mode drivable end-to-end | Mobile-Harness `DshRuntimeBridge` shipping implementation (AUDIT §2.3, §4.3) | Source-verified (third-party) |
| 2026-09-29 | Session format = checksummed Zstd JSONL | Upstream `docs/subsystems/persistence.md` (AUDIT §2.5) | Source-verified |
| 2026-09-29 | SIGTERM exits 0; SIGINT exits 130 | Upstream `apps/cli/src/profile-boot.ts` (AUDIT §2.4) | Source-verified |
| 2026-09-29 | PRoot + spawn bridge builds for arm64 | Mobile-Harness `CMakeLists.txt` (AUDIT §4.2) | Source-verified |
| 2026-09-29 | Protocol schemas internally consistent | `node tests/protocol/lint-schemas.mjs`: 7 files, 62 `$ref`s, 0 problems; every EventKind mapped to a DurabilityClass | Schema-verified (contract, not runtime) |
| 2026-09-29 | Real dsh SDK wire protocol: `initialize`/`session/prompt`/`shutdown` + `session.event`/`session.status`/`subagent.*` over NDJSON stdio | Read from installed `dsh-sdk-jsonrpc-server` source; then executed against a real pinned dsh on Windows x64 | **Executed (real dsh, Windows x64)** |
| 2026-09-29 | dsh session log readable by UH: plain JSONL + concatenated Zstd frames, `SessionHeader` with `version`/`cwd` | `core/sessions` reads real logs from `$DSH_HOME`; smoke stage 15 replays 17 events, seq 0…16, format v4 | **Executed (real dsh, Windows x64)** |
| 2026-09-29 | Windows x64 portable full chain, 15 stages (TESTING.md §1a) | `uh smoke` on Windows 11 Pro x64, report at `diagnostics/smoke-2026-09-29T21-31-19-546Z.json` | **14/15 pass — stage 10 fails on provider quota (`Insufficient Balance`, code QUOTA); NOT marked Verified** |
| 2026-09-29 | No orphaned dsh process after shutdown/kill | `tests/process.test.mjs` "no orphan process" + `pidAlive` checks in the smoke chain | Automated-tested |
| 2026-09-29 | Runtime integrity: hash mismatch is refused before launch | `tests/runtime.test.mjs` (hash-mismatch, corrupted-manifest, wrong-arch, tree-hash determinism) + `core/runtime/requireRuntime` | Automated-tested |
| 2026-09-29 | Credentials never plaintext in the portable tree | `tests/security.test.mjs` (DPAPI round trip, config-never-plaintext, logger redaction) | Automated-tested |
| — | dsh runs inside Android PRoot full chain (TESTING.md §2a) | none — not executed | **Unresolved (R-01)** |
| — | Protocol v1 round-trips on a live node | schema-only (shared/protocol/) — Phase 2, not implemented | Not implemented |
| — | Linux x64 full chain | not executed — no Linux host (WSL not installed) | **NOT TESTED** |
| — | macOS arm64 full chain | not executed — no macOS host (acceptable per brief §20) | **NOT TESTED** |

Rows are added as real test evidence accumulates; a claim may only move to
"Verified" by a recorded real-platform test outcome — never by source-level evidence or
documentation alone.
