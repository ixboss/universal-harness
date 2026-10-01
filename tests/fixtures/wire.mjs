// Shared test helpers for the Phase 2 protocol/server test suites.
//
// `wireClient` attaches a permanent buffer to a transport so no envelope is
// lost to ordering: the memory transport delivers synchronously, so a helper
// that registers its listener only when called would miss the reply it is
// waiting for. Callers use `request`/`next`/`wait` instead.

import { requestEnvelope } from '../../core/protocol/mod.mjs';

/** Attach a collecting buffer to a transport. Returns { all, next, byKind, wait, request }. */
export function wireClient(transport) {
  const received = [];
  const waiters = [];
  transport.onMessage((env) => {
    received.push(env);
    for (const w of waiters.splice(0)) {
      if (w.predicate(env)) { w.resolve(env); }
      else { waiters.push(w); }
    }
  });
  return {
    all: received,
    /** Resolve with the next envelope matching `predicate` (or any envelope). */
    next(predicate = () => true, { timeoutMs = 5000 } = {}) {
      const hit = received.find((e) => predicate(e));
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for envelope after ${timeoutMs}ms`)), timeoutMs);
        waiters.push({ predicate, resolve: (e) => { clearTimeout(timer); resolve(e); } });
      });
    },
    /** All envelopes of a payload kind, so far. */
    byKind(kind) {
      return received.filter((e) => e.payload?.kind === kind);
    },
    /** Wait until at least `n` envelopes of a kind have arrived. */
    async wait(kind, n = 1, { timeoutMs = 5000 } = {}) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (this.byKind(kind).length >= n) return this.byKind(kind);
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`timed out waiting for ${n} "${kind}" envelope(s)`);
    },
    /**
     * Send a request envelope and await its reply, which may be a response or a
     * protocol error — both carry the requestId. Resolves
     * { ok, payload, envelope }.
     */
    async request(kind, payload, requestId, { timeoutMs = 5000 } = {}) {
      transport.send(requestEnvelope(kind, payload, requestId));
      const reply = await this.next((e) => e.requestId === requestId && (e.type === 'response' || e.type === 'error'), { timeoutMs });
      return { ok: reply.type === 'response', payload: reply.payload, envelope: reply };
    },
  };
}

/** Throw with a readable message when `cond` is falsy (test assertions). */
export function check(cond, message) {
  if (!cond) throw new Error(`assertion failed: ${message}`);
  return cond;
}
