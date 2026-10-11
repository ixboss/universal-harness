# ADR-010: iPhone/iPad are retired from the product scope

**Status:** Accepted — 2026-10-11 (supersedes the client-technology decision of
[ADR-002](ADR-002-ios-client-only.md))
**Date:** 2026-10-11

## Context

ADR-002 decided that iPhone/iPad would be a **control client only** — never a local execution
host — and Phase 4 of the roadmap planned a native Swift/SwiftUI client for that role
(ROADMAP.md). Two further directions were explored and rejected before this decision:

1. **A native iOS client** required a macOS host, Xcode, an Apple Developer account and code
   signing. None of that is available on the project's development machine, so the client could
   never be built or tested here; the compatibility rows would have stayed "Not tested"
   indefinitely (R-10).
2. **A browser-based Web Controller for iPhone/iPad** was proposed as a lower-complexity
   alternative. A feasibility audit found it would still require a publicly-trusted certificate
   for a LAN-resolving DNS name (browsers cannot pin certificates, and WebCrypto needs a secure
   context), i.e. a domain, public DNS and certificate issuance — a partial deviation from
   ADR-006's "cloud is never a dependency" — plus a new HTTP routing surface, static serving,
   CSP, an SSE event channel and a per-connection replay cursor on the node.

Neither direction advances the project's actual mission. Universal Harness is a **portable,
secure, cross-platform AI coding harness**: Windows/Linux/macOS desktop execution nodes, an
Android PRoot execution node, one versioned protocol, LAN-first operation, and recoverable
sessions. A phone client is a convenience surface, not a capability the core product needs.

## Decision

**iPhone/iPad are removed from the active product scope.**

- No native iOS/iPadOS application will be built.
- No browser-based Web Controller **for iPhone/iPad** will be built.
- No work is spent on Safari compatibility, iOS-specific authentication, Apple tooling
  (Xcode, signing, provisioning, Apple Developer accounts, xtool), or iPhone pairing workflows.
- **No domain, public DNS, public certificate, or external service** will be introduced to
  support iPhone/iPad.

**What is explicitly preserved:** Windows/Linux/macOS desktop execution; the Android PRoot
execution node; Universal Protocol v1 and `shared/protocol/`; the engine-adapter architecture
(ADR-001); pairing, authentication, scopes and revocation (ADR-007, ADR-009); durable event
replay and `RecoverySnapshot` (ADR-005); portability and migration (ADR-004); LAN-first
operation with no mandatory cloud (ADR-006); and the `core/client` controller library with the
`uh connect` CLI.

## Alternatives considered

1. **Native iOS client (the former Phase 4).** Rejected: unbuildable and untestable on the
   project's host, and it required Apple tooling and an account for a convenience surface.
2. **Browser Web Controller for iPhone/iPad.** Rejected: it did not remove the dependency
   problem — it replaced Apple tooling with a domain, public DNS and a publicly-trusted
   certificate, while adding a new node-side HTTP/SSE surface. It also could not preserve the
   certificate-pinning guarantee the other clients have (browsers expose no peer-certificate
   fingerprint), so it would have shipped a documented security reduction for the sake of a
   phone UI.
3. **A browser interface for desktop/Android users.** Rejected for now: the `uh connect` CLI
   and `core/client` already cover remote control, so a browser UI would add a routing table,
   static serving, CSP and an event channel for no capability the product lacks. It may be
   revisited if a concrete need appears; it is not a planned deliverable.

## Consequences

- **The project's development and verification surface shrinks to what can actually be built
  and tested here**: the Node core, the Android node, and the CLI/controller. That is the whole
  of the honest verification story.
- **R-10 is closed as moot** — its premise ("the iOS client cannot be built/tested on this
  host") no longer applies because there is no iOS client.
- **Phase 4 of the roadmap is marked retired, not renumbered.** Phases 5–7 keep their numbers so
  that existing cross-references and git history remain valid.
- **The `ios/` placeholder directory is removed.** It contained only a Phase-0 README with no
  code; this ADR and ADR-002's status annotation are the record.
- **Protocol neutrality is retained deliberately.** The `platform` enum in
  `shared/protocol/v1/pairing.schema.json` still accepts `ios` and `web`, and `core/auth/mod.mjs`
  still accepts them. These are platform-neutral protocol values, not iOS support; narrowing the
  enum would be a breaking v1 schema change with no benefit. The protocol remains client-agnostic
  and any future client — on any platform — can implement it.
- **No security guarantee is weakened and no working functionality is removed.** Certificate
  pinning remains mandatory for the clients that exist (`core/client`, `uh connect`, the Android
  node's peers).

## Risks

- **Scope creep back toward a client platform** — mitigated by recording this decision and by the
  standing rule against faking capabilities (ROADMAP.md "Standing rules").
- **Protocol drift is no longer cross-checked against a second client stack.** ADR-002's
  mitigation (a shared fixture suite across stacks) now covers the Kotlin `android/` stack only;
  closing that gap is tracked in ROADMAP.md Phase 2's definition of done.
