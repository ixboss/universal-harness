# Testing Strategy

**Phase 1 update (2026-09-29).** Test matrix per [ARCHITECTURE.md](ARCHITECTURE.md) and the brief
§30. Every scenario is categorized: **automated** (runs in CI, no device), **integration**
(harnessing real subsystems on a desktop), **real-device** (requires Windows/Linux/macOS/Android,
and/or an iPhone), or **not yet testable** (blocking environment - see
[COMPATIBILITY.md](COMPATIBILITY.md)). Nothing is marked Passed until a test actually passed and
produced evidence.

## 1. Desktop

### 1a. Phase 1 portable-execution smoke gate (Windows x64) — MANDATORY

A **real-environment full-chain smoke test on a real Windows x64 machine**, implemented as
`uh smoke` and written to `diagnostics/smoke-<timestamp>.json`. Windows portable execution is
**not verified** (COMPATIBILITY.md) until every stage passes in order:

1. **bundled Node** — the portable launcher starts the bundled Node from a relative path (no
   system Node/pnpm/npm dependency)
2. **verified runtime** — the Node tree hash matches the install record (tamper detection)
3. **pinned, integrity-verified dsh** — `@deepseek-ai/dsh` 0.2.0-rc.2 resolves from the portable
   prefix; lockfile integrity matches the manifest
4. **native dependencies load** — dsh boots under the bundled Node's ABI (`koffi`, `node-pty`,
   and everything else in dsh's own dependency tree)
5. **`dsh --profile sdk` starts** — SDK JSON-RPC application answers on stdio
6. **`initialize`** — the node's `initialize` frame is accepted (`serverInfo` returned)
7. **session open** — `session/prompt` is delivered and a session is created (a `messageId` is
   returned)
8. **prompt** — a turn is opened and streamed
9. **streaming events** — live `session.event` frames are received on the stream
10. **completion** — the turn ends with reason `completed`
11. **durable session persistence** — the session log (JSONL/Zstd) is written with a valid
    `SessionHeader` (`version`, `cwd`) and durable events
12. **graceful shutdown** — `shutdown` round-trips and the process exits 0 within the bound
13. **restart** — a fresh launcher invocation starts cleanly against the persisted state
14. **reopen session** — the prior session is read intact and a continuation session is opened
15. **replay / recovery** — prior-session events replay with monotonic sequence numbers

#### Result executed 2026-09-29 (real Windows 11 Pro x64, Node v24.21.0, dsh 0.2.0-rc.2)

Report: `diagnostics/smoke-2026-09-29T21-31-19-546Z.json` (gitignored — it lives under the user's
diagnostics dir; contents summarized here).

| Stage | Result | Note |
|---|---|---|
| 01 bundled-node | **PASS** | v24.21.0 at relative `runtime\node\win-x64\...` |
| 02 verified-runtime | **PASS** | tree hash verified (608ms) |
| 03 pinned-dsh | **PASS** | `@deepseek-ai/dsh@0.2.0-rc.2` integrity recorded |
| 04 native-deps | **PASS** | dsh process spawned (588ms) |
| 05 sdk-profile | **PASS** | `deepseek-harness-sdk-runtime v0.0.1` (1284ms) |
| 06 initialize | **PASS** | round trip 1283ms |
| 07 session-open | **PASS** | `messageId` returned |
| 08 prompt | **PASS** | turn opened, events streaming |
| 09 streaming-events | **PASS** | 6 `session.event` frames observed live |
| 10 completion | **FAIL** | turn ended with reason `error`: `Insufficient Balance (code QUOTA)` — the provider account has no credit |
| 11 durable-session | **PASS** | session log written, header valid (56ms) |
| 12 graceful-shutdown | **PASS** | exit 0 (68ms) |
| 13 restart | **PASS** | second runtime initialized (1821ms) |
| 14 reopen-session | **PASS** | prior session intact (17 events); continuation opened |
| 15 replay-recovery | **PASS** | 17 events replayed, seq 0…16, format v4 |

**Verdict: 14/15. Stage 10 fails on the provider side, not on the portable chain** — the only
credential available in this environment returns `Insufficient Balance` from the DeepSeek API.
Per the brief this is reported as a failure; the Windows row is **not** marked Verified, and the
gate re-runs as soon as a funded credential is available (no code change required).

Verification-level distinction (never blur these):

| Level | Meaning |
|---|---|
| **architecture planned** | described in docs only — not evidence |
| **source-level evidence** | read from upstream/dependency source (e.g. AUDIT.md findings) |
| **automated test** | runs in CI against a fixture/harness |
| **real-platform verification** | the 1a full chain above, executed on a real Windows x64 host |

### 1a-2. Automated suite (Phase 1) — PASSING

`node --test tests/*.test.mjs` — **41 tests, 41 pass, 0 fail, ~26s**, no third-party test
dependencies (`node:test` only). The fake dsh stub (`tests/fixtures/fake-dsh.mjs`) speaks the
real SDK wire protocol with deterministic failure modes, so lifecycle behavior is testable
offline.

| File | Tests | Coverage |
|---|---|---|
| `tests/runtime.test.mjs` | 9 | status on a fresh tree; missing node/dsh detection; wrong arch; wrong version; hash mismatch; corrupted manifest; `verifyFileSha256` rejection; tree-hash determinism; install-state round trip |
| `tests/workspace.test.mjs` | 7 | init + stable identity marker; reopen; moved root detection; missing project; marker/registry conflict; root detection walk-up |
| `tests/sessions.test.mjs` | 5 | discovery of plain + Zstd session logs; replay; incomplete-turn detection; per-workspace listing; UH session-index lineage across reload |
| `tests/process.test.mjs` | 9 | successful launch→prompt→stream→shutdown(exit 0); init failure → `DSH_INIT_FAILED`; credential failure (no key leaked); prompt failure with clean shutdown; abnormal exit → pending requests rejected as `DSH_ABNORMAL_EXIT`; hung runtime → SIGTERM escalation then SIGKILL; no orphan process; malformed stdout tolerated; unverified runtime refused at launch |
| `tests/security.test.mjs` | 6 | redaction of keys/tokens/private keys; recursive context redaction; logger never writes a secret; env summary reports lengths only; Windows DPAPI round trip (sealed blob outside the portable tree); config never stores a secret as plaintext |
| `tests/migration.test.mjs` | 5 | path change detection; migration applies with backup; conflict refusal; rollback safety; restore refuses to clobber newer live state |
| `tests/protocol/lint-schemas.mjs` | 5 | cross-file `$ref` resolution; EventKind→DurabilityClass mapping (7 files, 62 refs, 0 problems) |

### 1b. Desktop scenario matrix

| Scenario | Category | Notes |
|---|---|---|
| First install (clean setup) | **automated-tested** (Phase 1) | download → SHA-256 verify → unpack → npm pin install → status acceptance; executed for real on Windows x64 (smoke 01–05) |
| Second launch (cached runtime) | **automated-tested** | smoke stage 13 (restart) + runtime status tests |
| Moving the folder to a new path | **automated-tested** | `tests/migration.test.mjs` path-change detection + recorded-root rewrite |
| Renaming the folder | automated (same invariant) | covered by moved-folder test; Unicode/space path dedicated case still a gap |
| Unicode path / spaces in path | automated | fixture root has a space today; dedicated case still TODO |
| USB/exFAT path mode (no symlinks) | automated + real-device | no symlink emission anywhere in Phase 1 code; exFAT device test still TODO |
| Windows → Linux migration | integration | logic automated-tested; cross-OS execution NOT TESTED (no Linux host) |
| Linux → macOS migration | integration | NOT TESTED |
| macOS → Windows migration | integration | NOT TESTED |
| Interrupted installation recovery | automated | download-then-verify ordering means a partial archive never unpacks; marker recovery still TODO |
| Corrupted runtime detection | **automated-tested** | hash-mismatch + tree-hash tests refuse before launch |
| Update failure | automated | update layer is Phase 6 — not implemented |
| Rollback | automated | Phase 6 — not implemented |
| Reset | automated | Phase 5+ — not implemented |
| Doctor | **automated-tested** | live launch/initialize/shutdown probe + plaintext-secret scan + Expected/Actual/Action reporting |

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
  — identical fixtures shared by all three implementation stacks (core/, Kotlin `android/`,
  Swift `ios/`) so the contract is proven identical across them.

## 7. Migration robustness (specific invariants)

Phase 1 status against each invariant:

- ⚠ **pre-migration backup exists and is complete before any rewrite** — implemented:
  `applyMigration` calls `createBackup` first and verifies it; automated-tested.
- ✅ **migration is idempotent** — running twice = running once (recorded-root rewrite is a
  no-op when already correct; improving on the reference behavior in
  [AUDIT.md §3.3])
- ⚠ **conversation content is never rewritten** — true by construction in Phase 1: the dsh
  session logs are only *read* by Universal Harness; dsh owns session internals (per the brief).
  Header/path rewrite across OSes (the reference project's approach) is **not implemented** and
  is deferred until cross-platform migration is testable — the workspace registry's
  recorded-root approach handles the Windows-side move case now.
- ⚠ **trailing Zstd frames byte-identical after header rewrites** — not applicable yet (no
  rewrite implemented); preserved as a requirement for the cross-OS migration phase.
- ✅ **unsupported session schema version → fail safe** — `core/sessions` reads v4 (and plain
  JSONL) and does not guess at unknown versions.
- ⚠ **interrupted migration recoverable from markers** — partially: backups + history records
  exist; the marker-based resume path is a Phase 5/6 item.
