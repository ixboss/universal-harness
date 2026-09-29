# shared

Language-neutral, shared contracts. The one place where the three implementation stacks
(TypeScript `core/`, Kotlin `android/`, Swift `ios/`) must agree — see TESTING.md §6.

## shared/protocol/

Universal Protocol v1 — **machine-readable source of truth** (PROTOCOL.md is the prose
companion):

| File | Contents |
|---|---|
| `v1/envelope.schema.json` | Message envelope: protocolVersion, requestId, type, timestamp, eventId, payload |
| `v1/identifiers.schema.json` | Canonical id formats + authorization scope tokens |
| `v1/errors.schema.json` | Error codes, safe messages, diagnostics linkage |
| `v1/capabilities.schema.json` | Capability object, protocol-version negotiation, operation catalog |
| `v1/pairing.schema.json` | QR pairing payload, challenge-response, device records |
| `v1/events.schema.json` | Event kinds + payloads (task/session/node/file/update/sync/terminal) |
| `v1/operations.schema.json` | Operations: reconnect handshake, task/file/terminal/diagnostics/update/replay |

Conformance: every implementation must pass the shared fixture suite validating these schemas
(identical fixtures, three stacks).

## Status

Phase 0 — schema contract complete (JSON Schema 2020-12). Fixtures arrive with Phase 2.
