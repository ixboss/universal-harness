# ADR-005: Execution node owns active task state

**Status:** Accepted — Phase 0
**Date:** 2026-09-29

## Context

The brief's §13/§19 requirements are explicit: tasks must continue when the controlling iPhone
disconnects, locks, or backgrounds; the node is authoritative; clients reconcile on reconnect.
This is also forced by upstream reality: cancellation of an in-flight dsh turn "commits neither
system nor users" (AUDIT §2.3), and dsh exposes no task-level exit-code contract — only
process-level signals (SIGTERM → 0, SIGINT → 130, AUDIT §2.4). Something must own task state,
and it cannot be the client or the harness.

## Decision

**Execution nodes are the authoritative owners of active task state.** Concretely:

- Tasks live in the node's durable task store with a state machine:
  `queued → starting → running → recovering → completed | failed | cancelled`.
- Cancellation is node-implemented: SIGTERM with a bounded wait, then force kill; the **node**
  records the outcome. We do not wait for a harness cancellation event that never comes.
- A supervisor reconciles process liveness against task records on every start, reconnect, and
  restart — orphaned `running` tasks become `failed` with a recovery record (or resume where
  resumption is supported). No permanent `running` is possible.
- Clients receive state via the event stream; on reconnect they replay missed events
  (`session.replay`) or reconcile from an authoritative snapshot.
- `Project A → Session X → Task Y → owned by Node 1`: the iPhone observes and controls Task Y,
  it never owns it (entity model in ARCHITECTURE §4.5).

## Alternatives considered

1. **Client-owned tasks.** Rejected outright by the brief and by physics — a phone that
   backgrounded or lost signal would orphan work.
2. **Harness-owned task state.** Rejected: upstream's durable unit is the *session*, not a
   remote-controllable *task*, and its cancellation semantics leave no settlement to observe.
3. **Quorum/distributed ownership.** Rejected: over-engineering; the node that spawns the
   process is the natural and simplest authoritative owner.

## Consequences

- The node's event log becomes a critical durable artifact — append-only, checksummed,
  monotonic event ids, retained for replay with a defined window and snapshot fallback.
- Multi-node concurrency must be prevented per workspace (ADR-adjacent concurrency rules,
  ARCHITECTURE §10) so two nodes cannot unknowingly mutate one active workspace.
- Task history (task, project, duration, result, timestamp) becomes a node-side feature
  enabling "continue last session / run last task" quick actions.

## Risks

- Node crash mid-task: mitigated by supervisor reconciliation and recovery state (R-11).
- Event-log loss: mitigated by checksummed append-only frames and snapshot fallback; worst
  case is reconciliation, not silent corruption.
