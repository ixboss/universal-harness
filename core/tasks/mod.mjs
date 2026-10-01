// Universal Harness — the task state machine (brief §9; PROTOCOL §6).
//
// Task state is node-owned and authoritative (ADR-005). The states are exactly
// the schema set plus the two the brief names: `created` (accepted, not yet
// queued) and `cancelling` (cancel requested, awaiting settlement). There is no
// ambiguous intermediate state: `recovering` is the only "we are not sure" state
// and it is explicit.
//
// Every transition is validated here before anything is written, so an invalid
// transition is rejected deterministically with TASK_ALREADY_DONE or
// INVALID_MESSAGE rather than silently accepted.

export const TASK_STATES = [
  'created',      // accepted by the node, not yet queued
  'queued',       // queued for an executor slot
  'starting',     // executor launch in progress
  'running',      // executor turn in flight
  'waiting',      // awaiting an interactive approval
  'cancelling',   // cancel requested, awaiting settlement
  'recovering',   // supervisor re-deriving state after an abnormal end
  'completed',    // terminal: succeeded
  'failed',       // terminal: did not succeed
  'cancelled',    // terminal: cancelled by request
];

export const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled']);

const TRANSITIONS = new Map([
  // The happy path.
  ['created', ['queued', 'cancelled']],
  ['queued', ['starting', 'cancelled', 'failed']],
  ['starting', ['running', 'failed', 'cancelled', 'waiting']],
  ['running', ['waiting', 'cancelling', 'completed', 'failed', 'recovering']],
  ['waiting', ['running', 'cancelling', 'failed', 'cancelled']],
  // Cancellation settles into cancelled, or failed if the process died during
  // teardown — never back into running.
  ['cancelling', ['cancelled', 'failed']],
  // Recovery either re-drives the task or settles it; it never silently
  // becomes 'completed' (brief §15: a vanished dsh process is not a success).
  ['recovering', ['starting', 'running', 'failed', 'cancelled']],
]);

const STATE_SET = new Set(TASK_STATES);

/**
 * Validate a requested transition. Returns { ok } or { ok: false, code } where
 * code is a protocol ErrorCode: TASK_ALREADY_DONE when the task is already
 * terminal (the common, benign race), INVALID_MESSAGE for any other illegal
 * step.
 */
export function checkTransition(from, to) {
  if (!STATE_SET.has(to)) return { ok: false, code: 'INVALID_MESSAGE', reason: `unknown task state "${to}"` };
  if (from === to) return { ok: false, code: 'INVALID_MESSAGE', reason: `task already in state "${to}"` };
  if (TERMINAL_STATES.has(from)) {
    return { ok: false, code: 'TASK_ALREADY_DONE', reason: `task is terminal (${from}); no further transitions` };
  }
  const allowed = TRANSITIONS.get(from);
  if (!allowed || !allowed.includes(to)) {
    return { ok: false, code: 'INVALID_MESSAGE', reason: `illegal task transition ${from} -> ${to}` };
  }
  return { ok: true };
}

/** True when `state` may still produce work (i.e. the task is alive). */
export function isActive(state) {
  return !TERMINAL_STATES.has(state);
}

/**
 * Decide the recovery outcome for a task found in a live state after a node
 * restart (brief §15). A dsh process that vanished is an explicit failure, not
 * a success; only a durable terminal record can certify completion.
 */
export function recoveryTarget(state) {
  if (TERMINAL_STATES.has(state)) return { state, outcome: 'durable-terminal' };
  if (state === 'running' || state === 'starting') return { state: 'failed', outcome: 'process-vanished' };
  if (state === 'waiting') return { state: 'failed', outcome: 'approval-lost' };
  if (state === 'cancelling') return { state: 'cancelled', outcome: 'cancel-confirmed' };
  // created/queued/recovering can simply be re-driven.
  return { state: 'queued', outcome: 'requeue' };
}
