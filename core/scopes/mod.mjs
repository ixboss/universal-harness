// Universal Harness — authorization scopes (brief §6).
//
// Every operation declares the scope a device must hold to perform it. Scope is
// granted at pairing (or re-granted by an admin) and recorded per DeviceRecord.
// A request missing the required scope gets a deterministic SCOPE_DENIED error —
// never a silent acceptance and never a crash.
//
// The mapping is data, not control flow: the server consults `requiredScopes`
// at dispatch time, so adding an operation means declaring its scope here and
// nowhere else. 'read-only' is the narrowest grant; 'node-admin' is the pairing
// and revocation scope and implies nothing about task control — the sets are
// explicit, not hierarchical, so a compromise of one grant cannot widen another.

export const SCOPE = {
  READ_ONLY: 'read-only',
  PROJECT_SESSION_CONTROL: 'project-session-control',
  TASK_CONTROL: 'task-control',
  FILE_MODIFY: 'file-modify',
  TERMINAL: 'terminal',
  NODE_ADMIN: 'node-admin',
  UPDATE: 'update',
};

/**
 * Operations that require each scope. An operation appearing under a scope is
 * permitted by that scope. Operations absent from the table entirely are
 * unauthenticated by design (node.hello, auth.connect, device.pair) — they are
 * the handshake itself and carry no authority.
 */
export const SCOPE_OPERATIONS = {
  [SCOPE.READ_ONLY]: [
    'session.list', 'session.read', 'session.replay',
    'project.list', 'project.open',
    'task.list', 'task.history',
    'file.browse', 'file.read',
    'diagnostics.run',
  ],
  [SCOPE.PROJECT_SESSION_CONTROL]: [
    'project.create', 'session.create', 'session.resume',
  ],
  [SCOPE.TASK_CONTROL]: [
    'task.start', 'task.cancel', 'task.approve',
  ],
  [SCOPE.FILE_MODIFY]: [
    'file.write',
  ],
  [SCOPE.TERMINAL]: [
    'terminal.exec', 'terminal.cancel',
  ],
  [SCOPE.NODE_ADMIN]: [
    'device.list', 'device.revoke',
  ],
  [SCOPE.UPDATE]: [
    'update.check', 'update.apply', 'update.rollback',
  ],
};

/** Reverse index built once: operation -> the scopes that satisfy it. */
const REQUIRED_SCOPES = (() => {
  const map = Object.create(null);
  for (const [scope, ops] of Object.entries(SCOPE_OPERATIONS)) {
    for (const op of ops) {
      (map[op] = map[op] || []).push(scope);
    }
  }
  return map;
})();

/**
 * Operations that establish or derive trust. They are handled before any
 * authorization check because authorizing them would be circular.
 */
export const UNAUTHENTICATED_OPERATIONS = new Set([
  'node.hello', // the node's greeting; carries no client-supplied authority
  'auth.connect', // proves identity; authorization is its *result*
  'device.pair', // establishes the first DeviceRecord; bounded by the token
]);

/**
 * @returns {string[]|null} scopes that would permit `op`, or null when the
 * operation needs no scope (handshake operations).
 */
export function requiredScopes(op) {
  if (UNAUTHENTICATED_OPERATIONS.has(op)) return null;
  return REQUIRED_SCOPES[op] || [];
}

/**
 * Decide an authorization request. Returns { allowed } or { allowed: false,
 * scope } naming the missing scope, so the error payload is deterministic and
 * the client can reason about what to request.
 *
 * @param {string} op payload.kind
 * @param {string[]} grantedScopes scopes recorded on the caller's DeviceRecord
 */
export function authorize(op, grantedScopes) {
  const needed = requiredScopes(op);
  if (needed === null) return { allowed: true };
  if (!Array.isArray(grantedScopes) || grantedScopes.length === 0) {
    return { allowed: false, scope: needed[0], reason: 'no scopes granted to this device' };
  }
  const have = new Set(grantedScopes);
  for (const s of needed) {
    if (have.has(s)) return { allowed: true };
  }
  return { allowed: false, scope: needed[0], reason: `operation "${op}" requires one of: ${needed.join(', ')}` };
}

/** True when granting `requested` would widen the caller's existing `held` set. */
export function isEscalation(requested, held) {
  const have = new Set(held || []);
  return (requested || []).some((s) => !have.has(s));
}
