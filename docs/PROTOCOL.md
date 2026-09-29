# Universal Protocol v1

**Phase 0 deliverable.** The wire contract between control clients (iPhone/iPad, later
browser) and execution nodes (Windows/Linux/macOS/Android). The machine-readable contract is
authoritative and lives in [shared/protocol/v1/](../shared/protocol/v1/); this document is its
prose companion and states the rules the schemas cannot express.

Design rules:

- The **execution node is authoritative** for all task/session state ([ADR-005](adr/ADR-005-node-authoritative-state.md)).
- **LAN-first, offline-capable** — no cloud dependency ([ADR-006](adr/ADR-006-lan-first-protocol.md)).
- Discovery is never authorization ([ADR-007](adr/ADR-007-security-and-pairing.md)).
- Versioned, capability-negotiated, replayable.

---

## 1. Transport

| Direction | Transport | Usage |
|---|---|---|
| client → node | HTTPS | Request/response operations (JSON) |
| node → client | WSS (upgraded from same server) | Event stream, terminal output, task streaming |
| discovery | mDNS (`_universal-harness._tcp`) | Public metadata only |

- TLS is required; the node presents a **per-node certificate** pinned by clients on first
  successful pairing (trust-on-first-use, recorded per device).
- Default binding: loopback + LAN. Binding beyond LAN is an explicit advanced option with
  warnings, and is not part of the v1 conformance tests.
- A session concept spans both channels: one authenticated TCP connection hosts the WebSocket;
  HTTP requests carry `Authorization: UH <deviceId> <sig>` (request-signed challenge).

## 2. Envelope

```json
{
  "protocolVersion": 1,
  "requestId": "req_…",
  "type": "request | response | event | error | notification",
  "timestamp": "2026-09-29T12:00:00Z",
  "eventId": 1901,
  "payload": { … }
}
```

Schema: [envelope.schema.json](../shared/protocol/v1/envelope.schema.json). `eventId` is
present on events only. Secrets never appear in any envelope field.

## 3. Message catalog (schemas in shared/protocol/v1/)

| Concern | Schema |
|---|---|
| Envelope, correlation, timestamps | `envelope.schema.json` |
| Identifier formats (node/device/project/session/task ids) | `identifiers.schema.json` |
| Error codes, safe messages, diagnostic linkage | `errors.schema.json` |
| Capability object, version + capability negotiation | `capabilities.schema.json` |
| Pairing payload, challenge-response, device records | `pairing.schema.json` |
| Event kinds and payloads, streaming | `events.schema.json` |
| Operations: task/file/terminal/diagnostics/update/replay | `operations.schema.json` |

At least these operations exist in the catalog (see `capabilities.OperationKind` for the full
list and how capability negotiation gates them):

- **Devices**: `device.pair`, `device.list`, `device.rename`, `device.revoke`, `device.forget`
- **Projects**: `project.list`, `project.create`, `project.open`, `project.rename`,
  `project.archive`, `project.delete` (with confirmation framing)
- **Sessions**: `session.list`, `session.create`, `session.resume`, `session.read`
- **Tasks**: `task.start`, `task.list`, `task.cancel`, `task.approve`, `task.history`
- **Files**: `file.browse`, `file.read`, `file.write`, `file.search`, `file.delete`
- **Terminal**: `terminal.exec`, `terminal.cancel`
- **Logs**: `log.stream`, `log.history`
- **Diagnostics**: `diagnostics.run`, `diagnostics.repair`
- **Runtime**: `runtime.start`, `runtime.stop`, `runtime.restart`, `runtime.health`
- **Updates**: `update.check`, `update.apply`, `update.rollback`
- **Sync/backup**: `sync.workspace`, `backup.create`, `backup.restore`
- **Recovery**: `session.replay` (see §5)

## 4. Pairing and authentication (hardened first-contact trust)

### 4.1 Threat model for first contact

The pre-hardening design pinned the node certificate/public key **after** the first successful
connection — a classic trust-on-first-use (TOFU) scheme. Its residual attack was:

> **"An attacker obtains the short-lived QR pairing token but presents a different node
> certificate/public key."**

Under TOFU this attack succeeded: the client had no prior commitment to any node identity, so a
LAN attacker who sniffs or otherwise captures the ~60s single-use token (e.g. via a compromised
camera roll, a shoulder-surfed screen, or an intercepted `PairRequest`) could impersonate the
node for that first pairing, be granted scopes, and thereafter appear as a trusted device.

**The hardened model closes this gap**: the QR payload no longer carries the token alone — it
cryptographically **binds the pairing session to the node's persistent identity** via SHA-256
fingerprints of the node identity public key and the node's TLS certificate. The client records
the expected identity **from the QR, before it ever connects**. A captured token is then
worthless to an attacker, because any peer presenting a different identity/certificate fails
verification during the TLS handshake — before authentication, before scope grant, and before
any `DeviceRecord` exists.

This is why the QR is an **out-of-band** channel: reading it optically is the trust anchor. We
assume an attacker may observe all LAN traffic and even capture the token, but cannot alter what
the camera saw on the node's screen.

### 4.2 Required pairing flow (normative)

1. The node generates or loads its **persistent** cryptographic node identity (keypair +
   certificate, held device-local per ADR-004/007 — it never travels with the portable drive).
2. The node generates a fresh **short-lived pairing token**: single-use, expires after
   approximately 60 seconds, rotated on each display.
3. The QR payload (`PairingPayload`, pairing.schema.json) contains **both**:
   - the temporary pairing token, **and**
   - the node's cryptographic binding: `nodeIdentitySha256` (SHA-256 of the node identity
     public key) and `nodeCertSha256` (SHA-256 of the node TLS certificate); optionally the
     public key PEM itself.
4. The client scans the QR and **records the expected node identity before connecting**.
5. The client connects to the advertised `endpoint`.
6. **TLS is established.**
7. The client verifies that the **presented certificate/public key matches the identity bound in
   the QR**. On mismatch: abort with `NODE_CERTIFICATE_MISMATCH` / `NODE_IDENTITY_MISMATCH`
   (`PairingFailureCode`); no trust is stored, and the token remains consumed on the real node
   (single-use).
8. Only after this verification succeeds does **challenge-response authentication** occur
   (client signs the node's nonce with its long-lived device key; node verifies).
9. **Authorization scopes** are established only after successful authentication.
10. The `DeviceRecord` is created only after the entire verification/authentication process
    succeeds.
11. Subsequent connections use the **pinned node identity plus challenge-response
    authentication**.
12. **mDNS/service discovery must NEVER establish trust by itself.** Discovery advertises public
    metadata only; a discovered node grants nothing, and a client never trusts a node it
    discovered without either a prior pairing record or a QR binding.

### 4.3 Failure semantics

`PairingFailureCode` (machine-readable, pairing.schema.json): `TOKEN_EXPIRED`,
`TOKEN_CONSUMED`, `NODE_IDENTITY_MISMATCH`, `NODE_CERTIFICATE_MISMATCH`, `CHALLENGE_FAILED`,
`PAIRED_AS_DIFFERENT_NODE` — non-revealing to a passive observer. Node identity/cert
mismatches MUST fail closed at step 7. Every step's failure is auditable client-side with the
recorded expected identity, letting the user tell a network impersonation from an expired QR.

The negative test for the headline attack is specified as **NEG-PAIR-01** in TESTING.md.

### 4.4 Device lifecycle

Renaming, revocation, forget, re-pair, last-seen, and active connections are operations on
`DeviceRecord`. Revocation is immediate for new connections; a live stream is closed at the
next event.

## 5. Event durability, crash consistency, and recovery

### 5.1 Four event classes — the exact relationship

| # | Class | Source | Durability | Purpose |
|---|---|---|---|---|
| 1 | **dsh live/transient events** | upstream `agent/*` stream during a turn | **live-only** | reasoner/tool streaming deltas; by upstream contract "transient chunk frames are not replayable" (AUDIT §2.3) |
| 2 | **dsh durable session events** | upstream `session/event` log (append-only JSONL / checksummed Zstd frames) | **durable (harness-owned)** | the authoritative conversation transcript: surface messages and log-only events with upstream `seq` ordering |
| 3 | **UH durable task events** | node event store (ours) | **durable (node-owned)** | authoritative **task lifecycle**: `task.queued/started/waiting/completed/failed/cancelled`, plus `session.created/updated`, `diagnostics.issue`, `file.changed`, `update.applied`, `sync.conflict`, `terminal.exited` |
| 4 | **UH live streaming events** | node, derived from class 1 | **live-only** | `task.output`, `task.reasoning`, `task.tool_started/finished`, `terminal.output`, `device.status_changed`, `node.state_changed`, `update.available` |

The mapping is machine-readable: `EventDurability` in
[events.schema.json](../shared/protocol/v1/events.schema.json), enforced by the linter so no event
kind exists without a durability class.

**Relationship rule:** class 4 is a *derived projection* of class 1 — it is never itself an
authority for task state. Class 3 is the authority for task *lifecycle*; class 2 is the authority
for conversation *content*. Class 3 events reference the corresponding class-2 records
(`sessionId`), so a client can reconcile "what happened to the task" (durable, ours) against
"what was actually said" (durable, harness).

### 5.2 Durability rules

- **When does an event get its eventId?** When it is **appended to the durable store**. A live
  event has no eventId at all — clients must not fabricate one from stream position. eventIds are
  strictly monotonic per node and never reused.
- **Are gaps allowed?** Yes, deliberately: live events do not consume ids, so consecutive durable
  ids may skip. Clients must treat any id strictly greater than their cursor as "next", never as
  "id implies continuity". Replayed duplicates are de-duplicated by eventId.
- **Ordering:** per-node total order over durable events. No cross-node ordering is claimed.
- **Atomicity:** a task-state transition and its durable event append are **one atomic unit** —
  the node writes the new task state and the durable event in a single write-ahead commit; the
  event is only emitted on the live stream *after* the commit succeeds. Therefore there is no
  observable window where a task is, say, `completed` but no `task.completed` exists durably.
- **Retention/compaction:** durable events are retained for a configurable window; compaction may
  summarize but must preserve every terminal task state (`completed`/`failed`/`cancelled`) and its
  lastEventId anchor. Compaction is logged (doctor checkable).

### 5.3 Crash and consistency semantics

| Scenario | Behavior |
|---|---|
| **Crash before event persistence** (task state changed in memory, commit not flushed) | On restart the supervisor re-derives task state from the durable store and the process-supervisor record. Since the task-state/event pair commit atomically, an unflushed transition is **as if it never happened**: the task stays at its last durable state (e.g. `running`), is re-marked `recovering`, then re-driven or failed. A client can never observe a phantom terminal state. |
| **Crash after event persistence** | Event is durably stored; restart replays it. Client reconnect and replay deliver it normally. |
| **Crash during task completion** | If the dsh process exited but the UH commit didn't flush, the harness-side truth is gone (process gone) — the supervisor marks the task `failed` with a recovery record and emits `task.failed` durably with `recovered: true` in the snapshot. No permanent `running`. |
| **Client disconnect during that window** | The node continues; nothing is lost. On reconnect the client replays from `lastEventId`, or if its cursor is beyond the store's current head (impossible for a real cursor; guarded anyway) it receives a snapshot. |
| **Node restart followed by reconnect** | Supervisor reconciliation runs first; orphaned `running` tasks resolve to a terminal state; the client's replay then reflects the reconciled truth. |
| **Event generated but not yet persisted** | Cannot be observed by design (§5.2 atomicity): events are only emitted post-commit. |
| **Replay when cursor is beyond retention** | `session.replay` returns `unavailable: true` with an authoritative `RecoverySnapshot`; the client reconciles and must never infer task state from event absence. |
| **Duplicate/replayed events** | De-duplicated by eventId client-side. |

### 5.4 Which source is authoritative?

- **Task state** → the **UH event store** (class 3). dsh owns the harness-internal turn lifecycle,
  but the *task* outcome is a node-owned record (ADR-005); upstream has no task exit-code contract.
- **Conversation content** → **dsh session/event logs** (class 2), read by the node through the
  adapter and served via `session.read`. We never rewrite conversation content (ARCHITECTURE §14).
- **Replay** → a **clearly defined combination**: the client's *task* timeline comes from the UH
  durable store; its *transcript* comes from dsh durable logs via the adapter. The UH store is the
  single replay cursor (`session.replay`), and `session.read` fetches content on demand.

### 5.5 Snapshot fallback and ambiguous-state resolution

A `RecoverySnapshot` (operations.schema.json) is the authoritative point-in-time node state:
nodeId, task list with states (including a `recovered` flag marking supervisor-derived states),
and session list. It is returned when replay cannot serve the cursor (retention exceeded,
corrupted index, fresh install) and after crash-recovery windows where the client's picture may
be incomplete. It contains task/session metadata only — never conversation content. Clients
reconcile: durable events remain the source of truth; the snapshot is the guaranteed fallback
that prevents a client from *permanently* inferring a false task state from disconnect, delay,
crash, restart, or an unflushed event.

### 5.6 Reconnect sequence

1. Client disconnects (ordinary loss, lock, backgrounding). **The task keeps running.**
2. Client reconnects → TLS + node-identity verification (pinned from pairing, §4) → device
   challenge-response authentication.
3. `ReconnectHandshake { deviceId, lastEventId }`.
4. Node responds with `session.replay` results: durable events `lastEventId+1 … head`, then the
   socket switches to the live stream. `unavailable: true` yields a `RecoverySnapshot` instead.
5. Duplicate `eventId`s are ignored; ordering is per-node total.

## 6. Streaming and task lifecycle

- A `task.start` request returns immediately with `taskId`; lifecycle arrives as events
  (`task.queued`, `task.started`, …). Content arrives as `task.output`,
  `task.reasoning`, `task.tool_started`, `task.tool_finished`.
- Ephemeral streaming frames are **not** a durability boundary (consistent with upstream's
  SDK semantics: "transient chunk frames are not replayable"). Durable transcript data is read
  via `session.read`, which reads the node's session/event records.
- `task.waiting` + `approvalRequired: true` carries an approval payload; clients respond with
  `task.approve` (bridging dsh permission presets, AUDIT §2.6). Without a response the task
  waits — it is never auto-approved.
- `task.cancel`: node-side cancel is SIGTERM (bounded) → force kill → `task.cancelled` with the
  node as the recorder of the outcome. Upstream's cancellation "commits neither system nor
  users" (AUDIT §2.3), so the node's record is authoritative; there is no harness-side
  cancellation event to await.

## 7. File operations and conflict semantics

- Every read returns `content`, `version`, `hash`, `modifiedAt`.
- Every write supplies `baseHash` from the last read. Mismatch against the node's current
  state → `CONFLICT` error carrying the current remote `version`/`hash` so the client can
  diff and retry. An explicit `overwrite` is audited and still refuses to clobber a *newer*
  file silently.
- Writes on the node are atomic (staged + rename); interrupted client uploads never corrupt.
- Path traversal is prevented server-side: all paths resolve within the project tree.

## 8. Terminal

Terminal is a **high-risk capability**:

- requires the `terminal` scope, granted explicitly at pairing (never by default);
- commands and sessions carry generated ids and are **audit-logged**;
- output is streamed as `terminal.output` events (`stdout`/`stderr`), cancellable, with exit
  codes in `terminal.exited`;
- output is **redacted** of secret patterns from the node's vault; environment injection never
  contains vault credentials;
- a `timeoutMs` bound applies (default 10 min, max 1 h);
- discovery alone grants nothing — `AUTH_REQUIRED`/`SCOPE_DENIED` for unauthenticated attempts.

## 9. Diagnostics, updates, and sync operations

- `diagnostics.run` returns `DiagnosticRecord[]` (id, severity, component, condition,
  evidence, recommendedAction, autoRepairSafe) — see [ARCHITECTURE.md §9](ARCHITECTURE.md#9-doctor--diagnostics).
- `update.apply`/`update.rollback` operate per channel with the staged lifecycle in
  [ARCHITECTURE.md §8](ARCHITECTURE.md#8-update-rollback-and-repair); health checks run after
  activation and failure triggers rollback automatically.
- `sync.workspace` (Android-import/export case) detects conflicts by hash+mtime and emits
  `sync.conflict` events for the user to resolve — **never** auto-overwrites.

## 10. Harness integration gaps and adapter strategy

Where upstream's surface does not yet expose something we need, we build a node-side adapter —
never a harness fork ([ADR-001](adr/ADR-001-deepseek-harness-engine.md)):

| Requirement | Upstream status (evidence) | Adapter strategy |
|---|---|---|
| Start task / send prompt | **Available** — SDK `initialize` + `session/prompt` (AUDIT §2.3) | Direct |
| Live streaming output | **Available** — `agent/*` live events (AUDIT §2.3) | Translate to `task.*` events |
| Durable transcript replay | **Available** — `session/event` logs (AUDIT §2.3) | `session.read` maps to log reads |
| Graceful cancel | **Missing** — cancelled turn "commits neither…" (AUDIT §2.3) | SIGTERM (exit 0) → bounded kill → node records outcome |
| Task exit-code contract | **Missing** — SIGTERM=0, SIGINT=130 only (AUDIT §2.4) | Node owns task state machine |
| Workspace registry API | **Missing** as API — files at `$DSH_HOME/storages/workspace.json` (AUDIT §3.3) | Node reads/writes registry atomically |
| Approval interception | **Partial** — permission presets + approvals (AUDIT §2.6) | Bridge presets to `task.waiting`/`task.approve` |
| Unknown future schema | **Versioned in code only** (AUDIT §2.5) | Schema gate: detect → fail safe → diagnostics |
| Session-format migration | Not an upstream concern | Ours: migration subsystem (ARCHITECTURE §14) |

Any new gap discovered in Phase 1 smoke tests is appended here with the same structure, per the
brief's rule: document the limitation and adapt around it rather than silently replacing the
harness.

## 11. Versioning policy

- `protocolVersion: 1` (integer major). Backward-compatible additions reuse v1 with capability
  negotiation; breaking changes require v2 and dual-version nodes during migration.
- Nodes reject unsupported versions with `PROTOCOL_VERSION_MISMATCH` and the range they support.
- Capability negotiation happens on every handshake, not just pairing.
