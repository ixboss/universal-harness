# ADR-007: Security and pairing model

**Status:** Accepted — Phase 0
**Date:** 2026-09-29

## Context

The system exposes a control surface that includes terminal execution and file modification
over the LAN. The brief sets hard rules: discovery ≠ authorization; cryptographic pairing;
encrypted transport; revocable devices; never expose unauthenticated remote command execution;
never store credentials in plaintext (even though the workspace is portable — repo A's own
README admits its portable credentials are plaintext); redact secrets from logs, screenshots,
diagnostics, QR codes, and Git repositories.

## Decision

**Four strictly separated stages: discovery → pairing → authentication → authorization.**

1. **Discovery** (mDNS) publishes public metadata only (node name, platform hint, protocol
   versions). Discovering a node grants **nothing**.
2. **Pairing** is QR-borne, 60-second-lived, single-use tokens (never a permanent secret);
   completion exchanges long-lived device identity keypairs (client-generated, stored in
   iOS Keychain / Android Keystore / desktop vault) and records a `DeviceRecord` with name,
   platform, pubkey, granted scope subset, paired-at, last-seen.
3. **Authentication** is per-connection signed challenge-response; transport is TLS with
   per-node certificates pinned at first successful pairing (TOFU, recorded per device).
4. **Authorization** is per-operation scope enforcement: `read-only`, `project-session-control`,
   `task-control`, `file-modify`, `terminal`, `node-admin`, `update`. Terminal and node-admin
   require explicit grant and are never defaulted.

Supporting rules:

- **Credentials never plaintext.** Desktop: encrypted vault in `data/portable-home/`, key
  device-local (machine keystore or passphrase-derived); Android: Keystore; iOS: Keychain.
  Vault contents are injected into task environments at spawn time and never logged.
- **Redaction** applied to logs, diagnostics, terminal output, and protocol error messages by
  construction; diagnostics must run secret-pattern scans as a self-test.
- **Revocation** is immediate for new connections; active streams close at the next event.
  Users can rename / revoke / forget / re-pair devices and view active connections.
- **Default binding** loopback + LAN; internet exposure is an explicit advanced opt-in (ADR-006).
- Terminal sessions: generated command/session ids, audit log, secret redaction, bounds,
  cancellation, exit status (PROTOCOL.md §8).

## Alternatives considered

1. **Pre-shared password / IP-based trust.** Rejected: "IP address = authorization" is the
   failure mode the brief names.
2. **Always-on cloud identity provider.** Rejected: violates offline-first (ADR-006).
3. **Plaintext-with-warnings** (inherited from repo A). Rejected: documented-insecure.

## Consequences

- A restored portable backup prompts for re-authentication (the vault key is device-local) —
  accepted trade-off, explained in UX (ADR-004).
- Diagnostics/QR/export features carry redaction obligations as first-class requirements.
- Scope checks exist on every operation, so capability gating and error codes are consistent
  (SCOPE_DENIED, DEVICE_REVOKED, AUTH_REQUIRED).

## Risks

- TOFU pinning is vulnerable to first-contact interception on hostile LANs (R-07) — mitigated
  by QR being out-of-band and by revocation; documented as residual.
- Secret redaction completeness — mitigated by leakage scanning tests (TESTING.md §3).
