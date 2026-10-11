// Universal Harness — controller-side wire buffer (Phase 3C).
//
// The production counterpart of what the test fixtures have used since Phase 2:
// a permanent collecting buffer attached to a Transport so no envelope is lost
// to ordering (a lazy listener registration would miss the greeting or a reply
// that was already in flight). The node server, the UniversalClient, and the
// test suites all speak through this one helper — there is no second wire
// implementation.

import { requestEnvelope } from '../protocol/mod.mjs';

/**
 * Attach a collecting buffer to a transport.
 *
 * @returns {{all: object[], next: Function, byKind: Function, wait: Function, request: Function}}
 */
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
    /** All envelopes received so far. */
    get received() { return received; },
    /** Resolve with the next envelope matching `predicate` (or any envelope). */
    next(predicate = () => true, { timeoutMs = 10000 } = {}) {
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
    async wait(kind, n = 1, { timeoutMs = 10000 } = {}) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (this.byKind(kind).length >= n) return this.byKind(kind);
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`timed out waiting for ${n} "${kind}" envelope(s)`);
    },
    /**
     * Send a request envelope and await its reply, which may be a response or
     * a protocol error — both carry the requestId. Resolves
     * { ok, payload, envelope }.
     */
    async request(kind, payload, requestId, { timeoutMs = 10000 } = {}) {
      transport.send(requestEnvelope(kind, payload, requestId));
      const reply = await this.next((e) => e.requestId === requestId && (e.type === 'response' || e.type === 'error'), { timeoutMs });
      return { ok: reply.type === 'response', payload: reply.payload, envelope: reply };
    },
  };
}
