# Testing Strategy

**Phase 0 deliverable.** Test matrix per [ARCHITECTURE.md](ARCHITECTURE.md) and the brief §30.
Every scenario is categorized: **automated** (runs in CI, no device), **integration**
(harnessing real subsystems on a desktop), **real-device** (requires Windows/Linux/macOS/Android,
and/or an iPhone), or **not yet testable** (blocking environment - see [COMPATIBILITY.md)](COMPATIBILITY.md).
Nothing is marked Passed until a test actually passed and produced evidence.

## 1. Desktop

### 1a. Phase 1 portable-execution smoke gate (Windows x64) — MANDATORY

A **real-environment full-chain smoke test on a real Windows x64 machine**. Windows portable
execution is **Not verified** (COMPATIBILITY.md) until every stage passes in order:

1. **bundled Node** — the portable launcher starts the bundled Node from a relative path (no
   system Node/pnpm/npm dependency)
2. **pinned, integrity-verified dsh** — `@deepseek-ai/dsh` resolves from the private portable
   prefix; hash matches the manifest
3. **native dependencies load** — `koffi` and `node-pty` (and any other native module in the
   manifest's `allowScripts`) load under the bundled Node's ABI
4. **`dsh --profile sdk` starts** — SDK JSON-RPC application initializes
5. **`initialize`** — the node's `initialize` frame is accepted; a session is created
6. **prompt** — `session/prompt` is delivered; the agent begins a turn
7. **streaming events** — live `agent/*`-derived events are received on the stream
8. **durable session persistence** — the session log (JSONL/Zstd) is written with a valid
   `SessionHeader` (`version`, `cwd`) and at least one durable event
9. **shutdown** — SIGTERM-style graceful shutdown exits with the documented semantics
10. **restart** — a fresh launcher invocation starts cleanly against the persisted state
11. **reopen / replay session** — the persisted session reopens and replays content

Verification-level distinction (never blur these):

| Level | Meaning |
|---|---|
| **architecture planned** | described in docs only — not evidence |
| **source-level evidence** | read from upstream/dependency source (e.g. AUDIT.md findings) |
| **automated test** | runs in CI against a fixture/harness |
| **real-platform verification** | the 1a full chain above, executed on a real Windows x64 host |

Only after stage 11 passes does the Windows row in COMPATIBILITY.md advance.

### 1b. Desktop scenario matrix

| Scenario | Category | Notes |
|---|---|---|
| First install (clean setup) | automated | fixture drive, assert staging + manifest |
| Second launch (cached runtime) | automated | no redundant downloads |
| Moving the folder to a new path | automated | relative-path invariant, registry integrity |
| Renaming the folder | automated | same invariant; also Unicode/space names |
| Unicode path / spaces in path | automated | portability invariants |
| USB/exFAT path mode (no symlinks) | automated + real-device | no symlink emission in any code path |
| Windows → Linux migration | integration | fixture sessions, assert header rewrites + content identity |
| Linux → macOS migration | integration | same |
| macOS → Windows migration | integration | same |
| Interrupted installation recovery | automated | staged-state markers |
| Corrupted runtime detection | automated | hash failure → refuse activation |
| Update failure | automated | download/verify/activate failure paths |
| Rollback | automated | previous version restorable and functional |
| Reset | automated | data removed, models preserved |
| Doctor | automated | all severities + recommended actions |

## 2. Android

### 2a. Android execution full-chain gate — MANDATORY, currently UNRESOLVED

dsh-on-Android is **not verified** — and is not claimed as verified — until this entire chain
passes on a **real ARM64 Android device**:

```
Android app → PRoot → Ubuntu arm64 userspace → bundled arm64 Node → dsh (SDK)
  → initialize → prompt → streaming event → durable session event → shutdown
  → restart → reconnect → session/task state recovery
```

A partial pass (e.g. PRoot + Node only) is **not** success. If a stage fails, the exact blocker
is documented (native modules / Node ABI / signals / filesystem behavior / PRoot limitations /
permissions / background execution / process lifecycle / memory constraints) and Android local
execution stays **unverified** (R-01). Source-plausibility from Mobile-Harness's Claude Code
path is *not* evidence for this chain.

### 2b. Android scenario matrix

| Scenario | Category | Notes |
|---|---|---|
| Clean install | real-device | |
| Runtime/rootfs extraction + verification | integration (download logic automated) | SHA-256 stage |
| PRoot startup | real-device | |
| dsh startup inside PRoot | **real-device — gating (R-01)** | unresolved risk |
| Project creation | real-device | |
| Task execution + streaming | real-device | |
| Background task continuation | real-device | foreground service survival |
| App restart, device reboot | real-device | state restoration |
| Storage permission changes | real-device | graceful degradation |
| USB workspace import/export (SAF) | real-device | checksum + conflict detection |
| Low-storage behavior | real-device | |
| Phantom-process kill recovery | real-device | supervisor reconciliation |

## 3. Remote protocol

| Scenario | Category | Notes |
|---|---|---|
| Pairing (QR → challenge) | automated | with protocol fuzzer, malformed payloads |
| Reconnect, disconnect during task | automated | node continues; task survives |
| Reconnect during task; missed events replayed | automated | event-cursor replay correctness |
| Streaming | automated | ordering, dedup of eventIds |
| Task completion while client offline | automated | authoritative snapshot path |
| Authentication failure / revoked device | automated | negative path coverage |
| Malformed request | automated | fuzz + schema-conformance tests |
| Protocol version mismatch | automated | handshake rejection semantics |
| Capability gating (missing ops) | automated | 403-style enforcement |
| Terminal scope enforcement | automated | denial paths + audit logging |
| Secret redaction in logs/diagnostics | automated | leakage scanning test |

### 3a. Negative security tests (Phase 0.1 additions)

| ID | Attack scenario | Expected result | Category |
|---|---|---|---|
| NEG-PAIR-01 | Attacker obtains the short-lived QR pairing token but presents a **different node certificate/public key** than the one bound in the QR | Pairing **MUST fail** with `NODE_IDENTITY_MISMATCH` / `NODE_CERTIFICATE_MISMATCH`; no authentication occurs, no scopes granted, no `DeviceRecord` created; the token is consumed (single-use) on the real node | automated |
| NEG-PAIR-02 | Replay of an expired pairing token | `TOKEN_EXPIRED` | automated |
| NEG-PAIR-03 | Replay of an already-consumed pairing token | `TOKEN_CONSUMED` | automated |
| NEG-PAIR-04 | mDNS-discovered node with no QR/pairing record issues privileged commands | All operations denied (`AUTH_REQUIRED` / `SCOPE_DENIED`); discovery establishes no trust | automated |
| NEG-PAIR-05 | Peer presents a certificate whose public key does not match the pinned node identity from a prior pairing | `PAIRED_AS_DIFFERENT_NODE`; connection refused | automated |
| NEG-PAIR-06 | Client attempts pairing with a modified/invalid QR payload (missing identity fingerprints, malformed JSON) | Schema validation failure; pairing aborts without trust | automated |

## 3b. Crash-consistency / event-durability tests (Phase 0.1 additions)

These verify the §5 semantics of PROTOCOL.md: state-transition/event atomicity, supervisor
re-derivation, and the no-false-task-state guarantee.

| Scenario | Category | Expected result |
|---|---|---|
| Crash **before** event persistence | automated + fault injection | Task state after restart equals last durable state; no phantom terminal state; `RecoverySnapshot` marks it `recovered: true` if re-derived |
| Crash **after** event persistence | automated | Event survives; replay delivers it; task state consistent |
| Crash during task completion | automated | dsh process gone + unflushed commit ⇒ task resolves to `failed` with recovery record, never permanent `running` |
| Client disconnect during task completion | automated | Task continues; client reconnects and receives the terminal event or snapshot |
| Node restart followed by reconnect | automated | Supervisor reconciliation runs before serving; orphaned `running` tasks resolve; replay reflects reconciled truth |
| Replay from a known event cursor | automated | Durable events strictly after cursor, in monotonic order; live events excluded |
| Replay when cursor is outside retention | automated | `unavailable: true` + authoritative `RecoverySnapshot`; client reconciles without inferring state from absence |
| Snapshot fallback | automated | Snapshot contains task/session metadata only (never conversation content); `recovered` flag accurate |
| Duplicate / replayed events | automated | De-duplicated by eventId; no double-application of state |
| eventId gap handling | automated | Live events consume no ids; client treats any id > cursor as "next" (no arithmetic assumptions) |

## 4. iOS client

| Scenario | Category | Notes |
|---|---|---|
| QR pairing | real-device | no macOS host available now → **not yet testable** on this machine; code authored in Phase 4 |
| LAN discovery, connection loss, reconnect | real-device | |
| Background/foreground transitions | real-device | |
| Task monitoring, notifications | real-device | |
| File browsing, terminal, session resume | real-device | |

## 5. Cross-platform end-to-end ("Definition of Done" workflows from the brief)

| Workflow | Category |
|---|---|
| A: USB on Windows → create project → session → safe eject | real-device |
| B: same USB on Linux → project/session persist, conversation continues | real-device |
| C: Android workspace import/sync → local harness → continue project | real-device |
| D: Android node ↔ iPhone pairing → streaming → iPhone lock → Android continues → reconnect restores state | real-device |
| E: Windows node from iPhone: discover, pair, terminal command, inspect project, monitor agent | real-device |
| F: iPhone disconnects → execution continues → reconnect → missed state synchronized | real-device |

The brief is explicit: **if these workflows do not work reliably, the project is not finished.**

## 6. Protocol schema conformance (Phase 0 executable)

The JSON Schema files under `shared/protocol/v1/` are themselves testable immediately:

- `node tests/protocol/lint-schemas.mjs` — validates that every cross-file `$ref` resolves
  **and** that every `EventKind` maps to exactly one `DurabilityClass` (the machine-readable
  durability contract). Passing today: 7 files, 62 refs, 0 problems.
- A Phase 2 fixture suite validates sample envelope/event/operation payloads against the schemas
  — identical fixtures shared by all three implementation stacks (TypeScript `core/`, Kotlin
  `android/`, Swift `ios/`) so the contract is proven identical across them.

## 7. Migration robustness (specific invariants)

- pre-migration backup exists and is complete before any rewrite
- migration is idempotent: running twice = running once (session-directory rename conflicts are
  resolved by idempotency markers, not exceptions — improving on the reference behavior in
  [AUDIT.md §3.3])
- trailing Zstd frames byte-identical after header rewrites
- unsupported session schema version → fail safe, untouched logs, actionable diagnostic
- interrupted migration recoverable from markers
