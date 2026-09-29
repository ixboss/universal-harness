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

## 4. Pairing and authentication

1. Node runs `UniversalHarness pair` → generates a fresh `PairingPayload` (60 s lifetime,
   single-use token, **no permanent secret**), renders QR.
2. Client scans → connects to `endpoint` with the token → presents its long-lived public key
   (Keychain/Keystore-generated).
3. Node issues `PairChallenge`; client signs; node verifies and records the `DeviceRecord`
   (name, platform, key, granted scopes subset, `pairedAt`).
4. Node returns `deviceId`, its own public key + certificate. Client pins both.
5. Subsequent connections authenticate with signed challenges; `AUTH_FAILED` /
  `CHALLENGE_FAILED` / `DEVICE_REVOKED` are defined, non-revealing errors.

Renaming, revocation, forget, re-pair, last-seen, and active connections are all operations on
`DeviceRecord`. Revocation is immediate for new connections; a live stream is closed at the
next event.

## 5. Reconnect and missed-event recovery

1. Client disconnects (ordinary loss, lock, app backgrounded). **The task keeps running.**
2. Client reconnects → TLS + device authentication.
3. `ReconnectHandshake { deviceId, lastEventId }`.
4. Node responds with `session.replay` results: events `lastEventId+1 … head`, then switches
   the socket to the live stream.
5. If event history is unavailable or beyond retention: node responds with an **authoritative
   snapshot** — current task states, session states, node capabilities — plus reconciliation
   hints. The client reconciles; duplicate `eventId`s are ignored.

Event ordering is per-node total via monotonic `eventId` (mirrors upstream's own `seq`-numbered
durability model, AUDIT §2.5).

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
