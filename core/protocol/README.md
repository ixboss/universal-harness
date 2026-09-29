# core/protocol

Universal Protocol v1 — TypeScript implementation for **execution nodes** (desktop, and
mirrored in the Android Kotlin node). This package is the sibling of the language-neutral
contract in [shared/protocol/v1/](../../shared/protocol/v1/), which remains the source of truth.

## Scope

- Envelope construction/validation (`protocolVersion`, `requestId`, `type`, `timestamp`,
  `eventId`, `payload`).
- Message dispatch: request/response correlation, error mapping (`AUTH_REQUIRED` … `UNAVAILABLE`).
- Event log: append-only, monotonic `eventId`, checksummed frames; replay cursors; snapshot
  fallback when history is unavailable (PROTOCOL.md §5).
- Capability negotiation and per-operation scope enforcement.
- Version negotiation (`PROTOCOL_VERSION_MISMATCH` with supported range).

## Boundaries

- **Does not** know about dsh: it consumes events from `core/server`'s adapter layer.
- **Does not** import platform-specific code; node-specifics go in `core/server`.
- All identifiers follow [shared/protocol/v1/identifiers.schema.json](../../shared/protocol/v1/identifiers.schema.json).

## Status

Phase 0 — skeleton. Implementation is Phase 2.
