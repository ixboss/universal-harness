# core/config

Portable configuration (`data/config/`) with secrets routed to device-local secure storage
(brief §15). A secret set via the config API is never serialized into the portable tree; on a
platform without secure storage the write **fails explicitly** rather than degrading to plaintext.

## Status

Phase 1 — **implemented + automated-tested** (`tests/security.test.mjs`).
