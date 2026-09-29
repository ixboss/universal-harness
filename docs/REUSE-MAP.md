# Reuse Map

**Phase 0 deliverable.** Classification of every major component into **REUSE / ADAPT /
REIMPLEMENT / DO NOT USE**, with rationale and evidence. Evidence pointers resolve to
[AUDIT.md](AUDIT.md) section numbers.

Boundary principle ([ADR-001](adr/ADR-001-deepseek-harness-engine.md),
[ADR-003](adr/ADR-003-android-execution-node.md)): prefer

```
Universal Harness adapter  →  unmodified upstream component
```

over forking, unless a demonstrated technical reason is recorded in the ADR.

---

## Summary table

| Component | Source | Decision | Why |
|---|---|---|---|
| DeepSeek Harness (`@deepseek-ai/dsh`) | upstream `deepseek-ai/deepseek-harness` | **REUSE** | The execution engine. MIT. Never forked; pinned, integrity-verified, driven via `--profile sdk` (AUDIT §2.3) |
| `dsh web` (browser UI) | upstream | **REUSE** | Local desktop convenience UI at `127.0.0.1:3080`, passthrough only |
| PRoot integration (submodule at pinned commit) | Mobile-Harness `third_party/proot` | **REUSE** | MIT parent; validated Android userspace; plus `libandroid-shmem`, `talloc` (AUDIT §4.2) |
| APK carrier-executable trick | Mobile-Harness `CMakeLists.txt` | **REUSE** | Solved, non-obvious AGP limitation; comment documented in AUDIT §4.2 |
| Native spawn bridge (`pocketspawn`, launcher, carrier) | Mobile-Harness `app/src/main/cpp` | **REUSE** | Process lifecycle bridge between Android and the PRoot guest |
| `RuntimeBridge` / `AgentDriver` / `AgentRegistry` / `AgentCapability` | Mobile-Harness | **ADAPT** | MIT. Sound multi-agent abstraction; restructure into execution-node architecture, add protocol-facing driver |
| `DshRuntimeBridge` | Mobile-Harness | **ADAPT** | Proven dsh SDK driver; generalize away from Android-only concerns (AUDIT §4.3) |
| `ApiKeyVault` (AndroidKeystore AES-GCM) | Mobile-Harness | **ADAPT** | Keep crypto design; extend to portable-credential model that never stores plaintext (ADR-007) |
| `WorkspaceCheckpoints` (snapshot/undo/accept) | Mobile-Harness | **ADAPT** | Reuse for node-side change safety; generalize over protocol file ops |
| Foreground services, lifecycle, wakelocks, install receiver | Mobile-Harness | **ADAPT** | MIT. Android background execution mechanics; rewire to node service model |
| `RuntimeInstaller` (rootfs download + SHA-256) | Mobile-Harness | **ADAPT** | Reuse download/verify/stage pattern for both rootfs and desktop runtime bundles |
| Portable launcher design (`setup`/`doctor`/`update`/`web`/`--`) | DSH-Portable | **REIMPLEMENT** | **No license** — concepts only, fresh code (AUDIT §3.5) |
| Versioned manifest + per-platform SHA-256 runtime bundling | DSH-Portable | **REIMPLEMENT** | Same licensing boundary; manifest schema redesigned as v2 (AUDIT §3.2) |
| Session path migration (workspace.json / session header / projcache) | DSH-Portable | **REIMPLEMENT** | Same licensing boundary; harden: full backups, idempotency, schema-version gate (AUDIT §3.3) |
| Contract test pattern (migration fixtures) | DSH-Portable | **REIMPLEMENT** | Test *approach* is not copyrightable expression; we author our own fixtures |
| Universal Protocol (envelope, events, ops) | new | **REIMPLEMENT** | Does not exist in either repo (AUDIT §4.6) |
| Execution-node server (WSS/HTTPS, auth, replay) | new | **REIMPLEMENT** | Does not exist in either repo |
| Discovery + pairing (mDNS, QR, challenge-response, scopes) | new | **REIMPLEMENT** | Does not exist in either repo |
| iOS/iPadOS client | new | **REIMPLEMENT** | Client-only control surface (ADR-002) |
| Sync / conflict detection / backups / storage accounting | new | **REIMPLEMENT** | No conflict handling exists upstream of our own design |
| Diagnostics (doctor) | DSH-Portable concept + new | **REIMPLEMENT** | Machine-readable diagnostic model with severities and repair hints |
| Web-UI scraping as a control mechanism | — | **DO NOT USE** | The browser UI is a human surface; protocol must be authoritative. `dsh --profile sdk` exists precisely for programmatic control |
| iOS/iPadOS local Harness execution | — | **DO NOT USE** | ADR-002: iOS is a control client; the Linux runtime does not run on iOS |
| Forking / rewriting DeepSeek Harness internals | — | **DO NOT USE** | ADR-001; the brief forbids replacing the agent, reasoning, orchestration, or task execution |
| Repo A's source code | DSH-Portable | **DO NOT USE** | Unlicensed; no copying under any circumstance (AUDIT §3.5) |
| Repo A's plaintext credential behavior | DSH-Portable | **DO NOT USE** | Inherited flaw; ADR-007 mandates encryption at rest |

---

## Per-decision detail

### REUSE — unmodified

**DeepSeek Harness.** Consumed as an npm package (`@deepseek-ai/dsh`), pinned to an exact
version with integrity metadata, installed into a private portable prefix. All integration goes
through the CLI: `dsh --profile sdk` for programmatic control, `dsh web` for local browsing,
and `dsh` flags (`--profile`, `--patch`, `--dump-config`) for configuration inspection. We never
patch upstream sources. If a required capability is missing, we document the gap and build an
**adapter** around it (see AUDIT §2 and PROTOCOL.md "Integration gaps").

**PRoot stack.** Imported as submodules at pinned commits with their own LICENSE files
(`third_party/proot`, `third_party/libandroid-shmem`) plus the in-tree vendored `talloc`. The
CMake integration, including the carrier-executable trick and the arm64-v8a ABI guard, is
carried over because it encodes hard-won Android packaging knowledge. **Vendored license texts
must be read verbatim at import** and recorded in THIRD_PARTY_NOTICES.md (they are not the
parent repo's MIT — see AUDIT §6 discrepancy 6).

### ADAPT — modified with attribution

The Mobile-Harness MIT source is imported **with git history preserved** as the `android/`
subtree in Phase 3, per the approved approach. Modifications are then made in-tree and recorded:

1. `RuntimeBridge` gains a protocol-visible session model (task IDs, event IDs) and
   node-authoritative lifecycle hooks (ADR-005).
2. `AgentRegistry` keeps multi-agent capability (Claude Code, dsh, Antigravity), with dsh as
   Universal Harness's default driver and others opt-in.
3. `ApiKeyVault` extends to the portable-credential model: secrets encrypted at rest with a
   device-local key; **plaintext storage is removed**, not merely discouraged.
4. Foreground services are re-scoped to the execution node (runtime setup, task execution,
   sync), with the special-use subtype descriptions updated honestly.
5. `WorkspaceCheckpoints` becomes the substrate for protocol file-change approval/undo.
6. `RuntimeInstaller`'s download-verify-stage pattern is factored into `core/update/` so the
   desktop runtime installer and the Android rootfs installer share one design.

### REIMPLEMENT — clean-room or net-new

**DSH-Portable-derived items are clean-room.** We studied the public, observable design
(AUDIT §3) and write new code from scratch. The observable *upstream storage format* we
read/write is MIT-documented, so format compatibility is not a derivative-work concern — only
repo A's *expression* is off-limits. Our migration layer improves on the reference in specific
ways: backups before every destructive change (not just session logs), strict idempotency,
schema-version gating with fail-safe behavior, and interruption recovery.

**Protocol, server, discovery, pairing, iOS, sync, diagnostics** are all new; neither audited
repository contains any remote-control capability (AUDIT §4.6).

### DO NOT USE — and the reasoning

- **Web-UI scraping:** tempting but wrong. The node must be the source of truth for task state,
  and a browser surface cannot give us durable, versioned, replayable events. The `sdk` profile
  exists for exactly this purpose.
- **iOS local execution:** technically incoherent (no Linux runtime on iOS) and explicitly
  out of scope (ADR-002).
- **Forking dsh:** would freeze us against a fast-moving upstream and violate the brief's
  "not a replacement" principle. Adapters absorb any gap.
- **Repo A source code / its plaintext credentials:** licensing and security respectively.

---

## Reimplementation vs. adaptation effort split (rough)

| Bucket | Share of net-new/adapted code |
|---|---|
| Android node (adapted from Mobile-Harness + node server) | ~40% |
| Portable desktop core (clean-room wrapper: launcher, runtime, migration, doctor, update) | ~25% |
| Universal Protocol + execution-node server (desktop + Android) | ~20% |
| iOS client | ~10% |
| Sync / conflict / backup / storage tooling | ~5% |

These are planning estimates for ROADMAP sequencing, not commitments.
