# ADR-009: Revocation re-admission and linked-continuation session resume

Status: Accepted (Phase 3C, 2026-09-30)

## Context

Phase 3C required two explicit semantic decisions.

**1. What happens to a revoked device record.** `revokeDevice` sets a
DeviceRecord's status to `revoked`; `verifyChallenge` refuses authentication
for it (`DEVICE_REVOKED`). But re-pairing the same device key refreshes the
record in place — including flipping the status back to `active`
(core/auth `pair()`). That is Option B in the Phase 3C brief:

* Option A — revocation is sticky: a revoked record can never become active
  again through pairing.
* Option B — a new owner-minted pairing token explicitly authorizes
  re-admission.

**2. What `session.resume` means.** The dsh SDK seam creates sessions but
cannot reopen a persisted dsh conversation in place (R-20,
docs/AUDIT.md). Universal Harness therefore records lineage
(`priorSessionId`) and continuations run under a new dsh session id.

## Decision

**Revocation: Option B — owner-gated re-admission.** The pairing model is
already ownership-based: a pairing token is minted by a local `uh pair`
invocation, is single-use, expires in 60 seconds, is 192-bit random, is
persisted only as a SHA-256 hash, and is bound to the node's identity
fingerprint (ADR-007, NEG-PAIR-01). Only someone with node-side access can
produce one. Re-admitting a revoked device through such a token is therefore
an explicit owner act with the same strength as the original pairing — and it
never mints a second deviceId for the same key; the record is refreshed in
place. The behavior is asserted by test ("a revoked device is re-admitted
only by a fresh owner-minted pairing"). Self-service re-admission remains
impossible: without a fresh token, `verifyChallenge` refuses a revoked device
indefinitely.

**Session resume: linked continuation, stated on the wire.** `session.resume`
creates a NEW session whose `priorSessionId` is the requested session, and
the response carries `resumedFromSessionId` explicitly. It does NOT reopen,
copy, or resume the dsh conversation; task work submitted against the
continuation runs in a fresh dsh conversation under the new id. Universal
Harness never rewrites dsh-owned session headers (ADR-001) and never
synthesizes conversation content. Controllers that want conversation context
read it via `session.read` (dsh transcript paging) from the original session.

## Consequences

* Revocation is an operational tool, not a forgetting tool: `forget: true`
  removes the record entirely for a clean slate; `revoke` + re-pair restores
  the same device identity when the owner chooses to.
* "Resuming" work across controllers/nodes means: read the original session's
  lineage, submit a task against the continuation session, and rely on the
  linked-continuation chain (`priorSessionId`) for the narrative. Cross-node
  byte-portability of conversations remains Phase 5 work constrained by
  R-03/R-14.
