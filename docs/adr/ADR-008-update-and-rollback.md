# ADR-008: Independent updates with staged activation and rollback

**Status:** Accepted — Phase 0
**Date:** 2026-09-29

## Context

The brief requires updates to be versioned, integrity-verified, staged before installation,
rollback-capable, offline-tolerant, admin-free where possible, and never able to leave the
portable installation unusable. Four genuinely independent version streams exist: our own
wrapper, the pinned `@deepseek-ai/dsh` harness (pre-1.0, fast-moving — R-02), per-platform
Node runtimes, and optional toolchains (plus the Android rootfs as a fifth, node-local
channel). The reference wrapper's manifest model (AUDIT §3.2) proves SHA-256-pinned
per-platform distribution is workable; upstream pre-1.0 drift makes rollback non-optional.

## Decision

**Each channel updates independently through one shared lifecycle:**

```
download → verify (SHA-256 or stronger) → stage → validate → activate (atomic) → health-check → rollback on failure
```

- Versioned manifest per channel records exact versions, download sources, and integrity
  hashes; manifests are retained under `manifest/known/` so drift and downgrade choices are
  inspectable offline.
- Updates **stage** outside the live path; activation is an atomic promote (rename). A partial
  or corrupted download can never replace a working runtime.
- Post-activation **health checks** run automatically; failure rolls back to the previous
  known-good version using the same verify/activate dance.
- `update.check` / `update.apply` / `update.rollback` are protocol operations gated by the
  `update` scope (ADR-007); the CLI mirrors them (`UniversalHarness update`,
  `UniversalHarness update --rollback <channel>`).
- No user data is touched by any update channel; `reset` likewise preserves projects and
  `models/` after explicit confirmation.
- Works without admin privileges (user-space portable layout), degrades gracefully offline,
  and records update state as doctor diagnostics.

## Alternatives considered

1. **Single monolithic version + in-place overwrite.** Rejected: one bad component bricks the
   whole installation; no independent rollback; contradicts "never leave it unusable".
2. **Background silent updates.** Rejected: surprise runtime swaps break running tasks;
   upgrades should be deliberate and announce themselves (`update.available` /
  `update.applied` events).
3. **Unpinned "latest" always.** Rejected for a pre-1.0 upstream: uncontrolled drift (R-02).

## Consequences

- Rollback requires retaining the previous version until pruning (a storage-accounting line
  item, ARCHITECTURE §17).
- Health checks must be cheap and safe (no destructive probes).
- Harness updates interact with session schema drift (R-14): activation refuses versions whose
  session format exceeds what our migration layer understands, surfaced as an actionable
  diagnostic instead of a silent breakage.

## Risks

- Health check false-negatives block good updates — mitigated by allowing explicit
  `--force`/rollback paths with recorded evidence.
- Manifest tampering as an attack vector — mitigated by integrity fields on manifests
  themselves and pinned update sources.
