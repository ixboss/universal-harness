// Shared test helpers for the Phase 2 protocol/server test suites.
//
// `wireClient` now lives in core/client (Phase 3C moved it into the production
// client library); this file re-exports it so the existing suites keep their
// import paths. One implementation, two consumers — there is no second wire.

export { wireClient } from '../../core/client/wire.mjs';

/** Throw with a readable message when `cond` is falsy (test assertions). */
export function check(cond, message) {
  if (!cond) throw new Error(`assertion failed: ${message}`);
  return cond;
}
