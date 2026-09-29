# core/errors

Stable error contract (brief §16): every failure is a `UhError` with a stable `code`, a
category, a **safe** context object, and an actionable `action` string. Comprehensive redaction
(`redact`, `redactObject`, `describeEnvSafe`) ensures keys, tokens, and private keys never reach
logs or diagnostics. Codes: `UH_ROOT_NOT_FOUND`, `RUNTIME_MISSING` / `RUNTIME_HASH_MISMATCH` /
`RUNTIME_ARCH_UNSUPPORTED` / `RUNTIME_VERSION_MISMATCH`, `DSH_MISSING` / `DSH_START_FAILED` /
`DSH_INIT_FAILED` / `DSH_PROTOCOL_ERROR` / `DSH_TIMEOUT` / `DSH_ABNORMAL_EXIT`,
`SECURE_STORAGE_UNAVAILABLE`, `BACKUP_INVALID` / `BACKUP_CONFLICT`, `MIGRATION_REFUSED`, …

## Status

Phase 1 — **implemented + automated-tested** (`tests/security.test.mjs` redaction/env summary;
`tests/process.test.mjs` asserts specific codes).
