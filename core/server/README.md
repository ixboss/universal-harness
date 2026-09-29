# core/server

Execution-node server: the LAN-facing surface that turns the Universal Protocol into real
control over a node's harness processes (ARCHITECTURE.md §3, PROTOCOL.md).

## Scope

- **TLS server** (HTTPS + WSS on the same endpoint), default binding loopback + LAN.
- **Session management** — authenticated connections, device challenge verification, per-device
  scope enforcement, connection lifecycle.
- **Adapter layer to dsh** — the node-side integration (PROTOCOL.md §10): spawns
  `dsh --profile sdk`, translates SDK JSON-RPC events to protocol events, bridges permission
  presets to `task.waiting` / `task.approve`, owns the task state machine and supervisor
  reconciliation (ADR-005), implements cancel (SIGTERM → bounded kill → recorded outcome).
- **Event log** — append-only, monotonic `eventId`, replay cursors, snapshot fallback
  (ADR-005, PROTOCOL.md §5).
- **Operation handlers** — projects, sessions, tasks, files (optimistic concurrency), terminal
  (audited + redacted), logs, diagnostics, updates, runtime lifecycle, sync/backup.
- **Terminal sessions** — explicit scope, generated ids, audit log, bounds, cancellation.
- **mDNS advertisement** — public metadata only; discovery never grants authorization.

## Boundaries

- Protocol message handling lives in `core/protocol`; dsh specifics stay in the adapter.
- Never exposes unauthenticated command execution (ADR-007).

## Status

Phase 1 — still a skeleton. Phase 2 deliverable (desktop), Phase 3 (Android, in Kotlin).
