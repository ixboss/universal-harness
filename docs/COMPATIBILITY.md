# Compatibility Matrix

**Phase 0.1 update.** Per the brief: *"Never mark something verified without actual
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
| Windows | x64 | Local (bundled Node) | TBD — gated by full-chain smoke test (TESTING.md §1a) | TBD | TBD | Not tested |
| Linux | x64 | Local (bundled Node) | TBD | TBD | TBD | Not tested |
| macOS | arm64 (Apple Silicon) | Local (bundled Node) | TBD | TBD | TBD | Not tested (no macOS host) |
| Android | arm64 | Local via PRoot | **Unresolved (R-01)** — gated by real-device full chain (TESTING.md §2a) | TBD | TBD | Not tested (no ARM64 device) |
| iPhone/iPadOS | arm64 | **Client only** | N/A (by design, [ADR-002](adr/ADR-002-ios-client-only.md)) | N/A | TBD | Not tested (no macOS host) |

### Gate definitions (rows only advance when the named gate passes)

- **Windows x64** — the 11-stage full chain of TESTING.md §1a on a real Windows host: bundled
  Node → pinned/verified dsh → native deps load → SDK initialize → prompt → streaming → durable
  session persistence → shutdown → restart → reopen/replay.
- **Android arm64** — the full chain of TESTING.md §2a on a real ARM64 device, including reconnect
  and session/task state recovery. A partial pass (PRoot + Node alone) is not success; on failure
  the exact blocker is documented and the row stays **Unresolved**.
- **Linux x64 / macOS arm64** — the equivalent chain per platform; macOS cannot be executed on
  this Windows host (environmental limitation, not an architecture judgment).

## Unsupported platforms (inherited scope; deliberately out of range)

- Windows ARM64, Linux ARM64/musl, Intel macOS (upstream wrapper scope, AUDIT §3.4)
- iOS/iPadOS local execution (architecturally excluded, ADR-002)

## Runtime requirements (planned targets)

| Component | Target | Notes |
|---|---|---|
| Bundled Node.js | 24.x LTS line | Per-platform, SHA-256 verified from nodejs.org dist |
| Harness | `@deepseek-ai/dsh` pinned (0.1.7–0.2.0-rc range tested in Phase 1) | Pre-1.0 upstream; drift handled by update layer |
| Android | 9+ API 28+, arm64-v8a only (per upstream CMake guard) | NDK 26.1.10909125, CMake 3.22.1, JDK 17 |
| iOS/iPadOS | TBD (Phase 4) | Swift/SwiftUI; buildable only on macOS |
| Desktop filesystems | NTFS, ext4, APFS, exFAT | exFAT = no-symlink mode enforced |

## Evidence log

| Date | Claim | Evidence | Status |
|---|---|---|---|
| 2026-09-29 | `dsh --profile sdk` exists as JSON-RPC application | Upstream `apps/cli/src/sdk-source.cordis.patch.yml` source (AUDIT §2.3) | Source-verified |
| 2026-09-29 | dsh SDK mode drivable end-to-end | Mobile-Harness `DshRuntimeBridge` shipping implementation (AUDIT §2.3, §4.3) | Source-verified (third-party) |
| 2026-09-29 | Session format = checksummed Zstd JSONL | Upstream `docs/subsystems/persistence.md` (AUDIT §2.5) | Source-verified |
| 2026-09-29 | SIGTERM exits 0; SIGINT exits 130 | Upstream `apps/cli/src/profile-boot.ts` (AUDIT §2.4) | Source-verified |
| 2026-09-29 | PRoot + spawn bridge builds for arm64 | Mobile-Harness `CMakeLists.txt` (AUDIT §4.2) | Source-verified |
| 2026-09-29 | Protocol schemas internally consistent | `node tests/protocol/lint-schemas.mjs`: 7 files, 62 `$ref`s, 0 problems; every EventKind mapped to a DurabilityClass | Schema-verified (contract, not runtime) |
| — | Windows x64 portable full chain (11 stages, TESTING.md §1a) | none — not executed | **Not tested (gate open, R-19)** |
| — | dsh runs inside Android PRoot full chain (TESTING.md §2a) | none — not executed | **Unresolved (R-01)** |
| — | Protocol v1 round-trips on a live node | schema-only (shared/protocol/) | Not implemented |

Rows are added in Phase 1+ as real test evidence accumulates; a claim may only move to
"Verified" by a recorded real-platform test outcome — never by source-level evidence or
documentation alone.
