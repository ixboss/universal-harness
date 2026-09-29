# core/adapter

**The only seam to dsh** (brief §8; ARCHITECTURE.md §20.3). Spawns the pinned, unmodified
`dsh --profile sdk` on the bundled Node and speaks newline-delimited JSON-RPC over stdio:
requests `initialize` / `session/prompt` / `shutdown`, notifications `session.event` /
`session.status` / `subagent.started` / `subagent.finished`. dsh's stdout is reserved for
protocol frames; non-JSON lines are tolerated, never crashing the pump.

Capabilities: locate + verify + launch + initialize + prompt + stream events + terminate
(graceful request → natural-exit grace → SIGTERM → bounded wait → SIGKILL → tree kill, so no
orphaned dsh survives) + recover + report exit codes/stderr + diagnostics. Never imports dsh
internals; an unverified runtime is refused before spawn.

Known upstream gap (R-20): the SDK server does not wire `agents.resume`, so a *persisted* session
cannot be reopened over the seam in a new process. Reopen is therefore UH-owned: durable read of
the prior log + continuation in a new session linked through `core/sessions`.

## Status

Phase 1 — **implemented + automated-tested** (9 lifecycle tests). Also executed against the real
pinned dsh on Windows x64 in the smoke chain.
