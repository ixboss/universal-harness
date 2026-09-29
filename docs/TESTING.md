# Testing Strategy

**Phase 0 deliverable.** Test matrix per [ARCHITECTURE.md](ARCHITECTURE.md) and the brief §30.
Every scenario is categorized: **automated** (runs in CI, no device), **integration**
(harnessing real subsystems on a desktop), **real-device** (requires Windows/Linux/macOS/Android,
and/or an iPhone), or **not yet testable** (blocking environment - see [COMPATIBILITY.md)](COMPATIBILITY.md).
Nothing is marked Passed until a test actually passed and produced evidence.

## 1. Desktop

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
a Phase 1 test validates sample envelope/event/operation fixtures against them, and all
implementations (TypeScript core, Kotlin Android, Swift iOS) must pass the same fixture suite —
guaranteeing the three stacks share one contract.

## 7. Migration robustness (specific invariants)

- pre-migration backup exists and is complete before any rewrite
- migration is idempotent: running twice = running once (session-directory rename conflicts are
  resolved by idempotency markers, not exceptions — improving on the reference behavior in
  [AUDIT.md §3.3])
- trailing Zstd frames byte-identical after header rewrites
- unsupported session schema version → fail safe, untouched logs, actionable diagnostic
- interrupted migration recoverable from markers
