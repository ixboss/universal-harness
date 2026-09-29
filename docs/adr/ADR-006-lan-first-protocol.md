# ADR-006: LAN-first, cloud-optional protocol

**Status:** Accepted — Phase 0
**Date:** 2026-09-29

## Context

The brief requires that a USB stick + an execution node + LAN + iPhone work fully with no
cloud server, hosted database, account, relay, or subscription — and that LAN operation
continue if the internet disappears, subject only to whatever external model provider a task
actually uses. Both audited wrapper projects are already cloud-free by design (Mobile-Harness
advertises "zero Cloud intermediaries"), so this is an alignment decision, not a stretch.

## Decision

**The core architecture is LAN-first and offline-capable; cloud is never a dependency.**

- Discovery: mDNS/Bonjour advertising public metadata only; manual endpoint entry retained as
  an advanced fallback for hostile networks (AP isolation, IPv6-only).
- Transport: direct WSS/HTTPS between client and node, TLS with per-node certificates pinned
  at pairing. No relay in the path.
- Pairing: QR-borne short-lived token + challenge-response, entirely local.
- Node binding default: loopback + LAN. Internet exposure is an explicit advanced opt-in with
  warnings and is outside the v1 conformance surface.
- A future optional cloud relay may be added as an *additive* capability (e.g., remote access
  outside the LAN), never as a required component.

## Alternatives considered

1. **Managed relay by default (server-mediated pairing).** Rejected: adds an account and a
   dependency; the brief forbids it; it also widens the attack surface for remote command
   execution.
2. **Cloud-synced state as source of truth.** Rejected: the node is authoritative (ADR-005);
   cloud sync would invert ownership and introduce split-brain.
3. **Internet-exposed nodes.** Rejected as default: unauthenticated-ish exposure of a task and
   terminal execution surface is precisely the failure mode the brief warns against.

## Consequences

- Simpler security model: no third-party trust, no account service, no credential relay.
- Diagnostics must include LAN-health checks (doctor: network, remote server, pairing state).
- `device.status_changed` events are LAN-derived; "offline" means unreachable on LAN, not
   "task stopped" — the UI must say so (ARCHITECTURE §18).
- Later cloud work must be additive and capability-gated so LAN-only installs stay supported.

## Risks

- Hostile/odd networks break discovery (R-15) — mitigated by manual endpoint fallback.
