# core/security

Device identity, pairing, authentication, authorization, and the credential vault
(ADR-007, PROTOCOL.md §4).

## Scope

- **Node identity** — stable keypair + certificate generation; private key stays device-local.
- **Pairing server-side** — 60-second single-use tokens, QR payload rendering, challenge
  issuance, device key verification, `DeviceRecord` store (name, platform, scopes, status,
  lastSeen, pairedAt).
- **Authentication** — per-connection signed challenge-response.
- **Authorization** — per-operation scope enforcement (`read-only` … `update`); terminal and
  node-admin never default.
- **Device management** — rename / revoke / forget / re-pair; active connection tracking;
  revocation semantics (immediate for new connections, next-event for live streams).
- **Credential vault** — encrypted-at-rest storage in `data/portable-home/`; key is
  device-local (machine keystore or passphrase-derived); injects secrets into task
  environments at spawn; **never plaintext** (upgrades the inherited flaw, ADR-004).
- **Redaction** — patterns applied to logs, diagnostics, terminal output, and protocol errors.

## Boundaries

- Vault encryption primitives must be auditable and dependency-light.
- No network code: pairing transport lives in `core/server`.

## Status

Phase 0 — skeleton. Implementation is Phase 1–2.
