# ADR-002: iOS/iPadOS is a control client only

**Status:** Accepted — Phase 0
**Date:** 2026-09-29

## Context

The brief defines the product model: execution nodes (Windows, Linux, macOS, Android) run the
Harness; control clients control them. The iPhone/iPad must be a first-class remote client, not
a local DeepSeek Harness runtime. Technically this is also the only coherent option: the
Harness's desktop runtimes and the Android PRoot Linux userspace do not execute on iOS, and iOS
sandboxing forbids the process model the engine requires.

## Decision

**iPhone/iPad is a control client only.** It connects to execution nodes over the Universal
Protocol and supports: node discovery, pairing, status and capabilities, project/session
browsing, conversation viewing, prompt sending, streaming agent output, task control,
terminal access, file browsing/editing, logs, diagnostics, update/repair controls, and
reconnect/recovery. It never owns tasks.

## Alternatives considered

1. **Local harness on iOS.** Rejected: technically incoherent (no Linux userspace, no
   permitted process model) and explicitly out of scope.
2. **Web-only client instead of native.** Rejected as the primary client: the brief requires a
   native remote-control feel, deep links, Keychain secret storage, and notifications. A web
   client remains a possible future secondary surface.

## Consequences

- No engine, runtime, or PRoot concerns on iOS — scope narrows to protocol fidelity and UX.
- Secrets stay in Keychain; device identity is Keychain-backed.
- Testing requires a macOS host and real devices: **not available on this Windows machine**
  (R-10). iOS compatibility rows remain **Not tested** until then — the Swift client is authored
  in Phase 4 against the machine-readable schemas so it is real, not a mock.

## Risks

- Protocol drift between iOS and other stacks — mitigated by the shared JSON Schema fixture
  suite (TESTING.md §6).
- Unverifiable state on this host — mitigated by honest matrix bookkeeping, never by marking
  anything verified.
