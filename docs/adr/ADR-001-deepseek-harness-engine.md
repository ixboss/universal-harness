# ADR-001: DeepSeek Harness remains the execution engine

**Status:** Accepted — Phase 0
**Date:** 2026-09-29

## Context

Universal Harness exists to make an existing agent harness portable, multi-node, and remotely
controllable. The upstream project — [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness),
published as npm `@deepseek-ai/dsh` — is an MIT-licensed, actively developed (pre-1.0, rapid
iteration) agent harness built on the Cordis plugin framework. Both audited wrapper projects
wrap *it*, not a fork of it.

The brief is explicit: Universal Harness must not replace the AI agent, model orchestration,
reasoning, core harness behavior, or upstream task execution. If the upstream interface lacks
something, we document the limitation and adapt around it.

## Decision

**`@deepseek-ai/dsh` is the sole execution engine, consumed unmodified.** Specifically:

- Installed as a pinned npm package with integrity metadata, into a private portable prefix
  (never a global install, never a source fork).
- Programmatic control goes through `dsh --profile sdk` — the SDK JSON-RPC application
  (source-verified in [AUDIT.md §2.3](../AUDIT.md#23-the-sdk-profile--our-integration-seam)).
- Local human UI goes through `dsh web` (browser UI at `127.0.0.1:3080`) as a passthrough.
- Configuration via `DSH_HOME` redirect + permission presets; secrets injected from our
  encrypted vault.
- Every gap between upstream's surface and our needs is handled by a **node-side adapter**,
  catalogued in [PROTOCOL.md §10](../PROTOCOL.md#10-harness-integration-gaps-and-adapter-strategy).

## Alternatives considered

1. **Fork upstream and extend.** Rejected: freezes us against a fast-moving pre-1.0 project;
   violates the brief's "not a replacement" principle; creates a permanent merge burden.
2. **Web-UI scraping as the control surface.** Rejected: cannot yield durable, versioned,
   replayable task state; fragile to UI changes; the SDK profile exists for exactly this.
3. **Reimplement a minimal agent.** Rejected: out of scope by the brief and unnecessary — the
   engine is MIT and freely bundleable.

## Consequences

- Our reliability is partly upstream's: pinning + integrity verification + rollback are
  first-class, not afterthoughts (R-02, R-14).
- Some protocol semantics mirror upstream limits (e.g. cancellation has no durable settlement
   upstream, so the node owns task outcomes — see ADR-005).
- We must keep an integration-gap table current as upstream evolves (PROTOCOL.md §10).

## Risks

- Upstream breaking changes (R-02) — mitigated by pinning and schema gates.
- Gap table drifts out of date — mitigated by per-phase review against upstream releases.
