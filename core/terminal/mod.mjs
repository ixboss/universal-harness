// Universal Harness — the terminal execution interface (brief §13).
//
// The interface exists and is schema-complete (operations.schema.json
// TerminalRequest / TerminalCancelRequest), but v1 does not execute terminal
// commands. The brief is explicit: rather than ship an insecure shortcut, the
// capability is advertised as absent and every request gets a deterministic
// CAPABILITY_UNSUPPORTED error.
//
// What "disabled" means concretely:
//   - The node's advertised operations omit terminal.exec / terminal.cancel.
//   - A request for either is rejected before any process is spawned, with the
//     same error shape as any other unsupported capability, and it is auditable.
//
// The lifecycle below documents how a future implementation must behave, so the
// extension point is explicit without being reachable.

export const TERMINAL_KINDS = Object.freeze({
  EXEC: 'terminal.exec',
  CANCEL: 'terminal.cancel',
});

export const TERMINAL_DISABLED = true;

/**
 * The v1 terminal handler: refuses, deterministically. Returns the protocol
 * error payload the server should emit. `audit` records the attempt so a
 * refused request is still observable by the operator.
 */
export function handleTerminalRequest({ kind, audit = null }) {
  if (audit) audit({ kind, outcome: 'refused', reason: 'terminal execution is not implemented in v1' });
  return {
    ok: false,
    code: 'CAPABILITY_UNSUPPORTED',
    message: 'Terminal execution is not available on this node.',
    detail: 'The terminal interface is defined by the protocol but not implemented; the node advertises no terminal operations.',
    retryable: false,
  };
}

/**
 * Required lifecycle for a future implementation, stated here so the contract
 * is not rediscovered later. A real handler must:
 *   1. require the 'terminal' scope (core/scopes) — already wired;
 *   2. resolve cwd through the same safeResolve() boundary as file ops;
 *   3. spawn with an inherited-but-filtered env, never the node's own env;
 *   4. stream output as live-only terminal.output events, redacted by redact();
 *   5. emit a durable terminal.exited event with the exit code on completion;
 *   6. honor terminal.cancel and enforce timeoutMs with a bounded teardown
 *      (SIGTERM, wait, kill) mirroring the dsh adapter's cancellation;
 *   7. never place the command line or env in any log or error payload.
 */
export const TERMINAL_IMPLEMENTATION_CONTRACT = Object.freeze([
  'require-terminal-scope',
  'safe-resolve-cwd',
  'filtered-env',
  'redacted-live-output',
  'durable-exit-event',
  'bounded-cancellation',
  'no-secrets-in-logs',
]);
