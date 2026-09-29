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
   versions). Discovering a node grants **nothing** — a client never trusts a node it discovered
   without either a prior pairing record or a fresh QR binding.
2. **Pairing** is QR-borne, 60-second-lived, single-use tokens (never a permanent secret) that are
   **cryptographically bound to the node's persistent identity**: the QR payload carries
   `nodeIdentitySha256` (SHA-256 of the node identity public key) and `nodeCertSha256` (SHA-256 of
   the node TLS certificate), per [pairing.schema.json](../../shared/protocol/v1/pairing.schema.json).
   The client records the expected identity **from the QR before connecting**, verifies the
   presented certificate/key during the TLS handshake, and only then proceeds to authentication.
   Completion records a `DeviceRecord` (name, platform, given scopes subset, pairedAt, lastSeen).
3. **Authentication** is per-connection signed challenge-response, using the node identity pinned
   from the QR and the client's device keypair.
4. **Authorization** is per-operation scope enforcement: `read-only`, `project-session-control`,
   `task-control`, `file-modify`, `terminal`, `node-admin`, `update`. Terminal and node-admin
   require explicit grant and are never defaulted.

### Headline attack this closes

> "An attacker obtains the short-lived QR pairing token but presents a different node
> certificate/public key."

Under the previous TOFU design, a captured token was sufficient to be trusted on first contact,
because the client committed to a node identity only *after* connecting. The hardened flow makes
the QR an **out-of-band commitment channel**: the client pins the expected node identity from the
QR before opening any connection, and a peer whose presented identity or certificate differs
fails closed with `NODE_IDENTITY_MISMATCH` / `NODE_CERTIFICATE_MISMATCH` — before authentication,
before scope grant, before any `DeviceRecord` is created. Stealing the token no longer steals
trust; only compromising the node's private key does. (Specified as negative test NEG-PAIR-01 in
[TESTING.md](../TESTING.md).)

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

- QR token capture combined with identity spoofing: closed by the QR identity binding (this
  ADR, NEG-PAIR-01). Residual assumption: the QR is read optically (trusted display + camera);
  a compromised node-side display or a maliciously QRed wrong key cannot be distinguished at
  the protocol layer — recorded as R-07.
- Secret redaction completeness — mitigated by leakage scanning tests (TESTING.md §3).
