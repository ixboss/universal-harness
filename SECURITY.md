# Security Policy

Universal Harness pairs a controller with a node that runs agent harnesses as
the node's OS user. `task-control` implies **arbitrary code execution** on the
node host — see [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md) (T-1, confirmed by
experiment) before granting scopes.

## Supported versions

The `main` branch and the latest tagged release receive security fixes.

## Reporting a vulnerability

Use GitHub **Security Advisories → Report a vulnerability**
(private disclosure) at https://github.com/ixboss/universal-harness/security/advisories/new.

Please include: affected version/commit, reproduction steps, and impact.
Do not open a public issue for anything exploitable. You can expect a first
response within 7 days; coordinated disclosure is the default.

## Out of scope

- Vulnerabilities in upstream harnesses (dsh, claude, gemini) — report those
  upstream; we pin dsh exactly and never modify it (ADR-001).
- Reports requiring physical access to an operator's unlocked machine.
- Rate-limit / DoS by authenticated devices that already hold `task-control`
  (they can already execute code on the node host).

## Hardening defaults

- Secrets never live in the portable tree; OS secure storage or explicit
  failure (`SECURE_STORAGE_UNAVAILABLE`), never plaintext fallback.
- Node identity and TLS keys are device-local (0600 / DPAPI CurrentUser).
- Challenge-response authentication with single-use nonces; TLS certificate
  pinning; deny-by-default scopes.
- Tasks run inside their project directory with an allowlisted environment.
