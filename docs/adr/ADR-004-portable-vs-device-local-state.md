# ADR-004: Portable state vs. device-local state

**Status:** Accepted — Phase 0
**Date:** 2026-09-29

## Context

A portable workspace that moves between Windows, Linux, macOS, and Android will carry *some*
state and must not carry *other* state. Two failure modes frame this: (a) blindly traveling
device secrets would make "portable" a security incident — repo A's own README admits
credentials travel in plaintext on the drive; (b) device-specific runtime state traveling
verbatim would break on a different OS or machine.

## Decision

**Split state into two explicit categories with a third, honest sub-distinction.**

**Portable state** (travels with the drive): projects, workspace registry, sessions and
conversation history, harness configuration, provider profiles, skills/plugins configuration,
workspace metadata (checkpoints), safe-to-migrate caches/projections, migration metadata +
backups, manifest/runtime metadata.

**Device-local state** (never blindly travels): node identity keypair (private part), pairing
keys, Keychain/Keystore/master-key material, OS-specific credentials, temporary files,
device-specific runtime caches, discovery state, event cursors and locks.

**The "same environment" contract** is stated honestly: we do not claim OS environments are
byte-identical. The promise is *same Universal Harness experience and portable project/session
state, with platform-specific execution capabilities*. OS binaries, native tools, shell
environment, device integrations, the Android PRoot environment, and hardware-specific config
are platform-specific by design.

**Portable credentials are never plaintext.** The vault container may travel, but the key that
opens it is device-local; restoring on a new machine prompts re-authentication rather than
exposing secrets. This deliberately closes the inherited plaintext flaw.

## Alternatives considered

1. **Everything portable.** Rejected: turns the USB stick into a credential compromise.
2. **Nothing portable / per-device resync.** Rejected: defeats the product's core promise.
3. **Plaintext-with-warning** (repo A's approach).** Rejected: documented-insecure by its own
   author; unacceptable for a project that may be distributed.

## Consequences

- Backup/restore prompts for re-authentication — accepted trade-off, explained in UX copy.
- Migration is a first-class subsystem (ARCHITECTURE §14) rather than an afterthought.
- Android differs by necessity: SAF import/export, never execution-from-USB (ADR-003).
- Diagnostics must distinguish "portable state damaged" from "device state missing" so users
  get the right repair guidance.

## Risks

- Users may expect 1:1 environment identity — mitigated by explicit documentation and
  capability negotiation that surfaces platform differences.
