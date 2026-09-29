# core/logging

Redacted JSONL logger writing to `data/logs/uh.log`. Every field passes through redaction, so a
secret that reaches the logger never reaches the file (proven by a dedicated negative test).

## Status

Phase 1 — **implemented + automated-tested** (`tests/security.test.mjs`).
