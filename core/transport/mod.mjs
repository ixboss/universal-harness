// Universal Harness — transport layer.
//
// The protocol layer (core/protocol) is deliberately transport-agnostic: it
// validates and routes envelopes, and this layer moves bytes. A Transport is
// one duplex frame channel carrying a single client<->node conversation. The
// node server owns many Transports (one per connected client); a client owns
// one.
//
// Framing: newline-delimited UTF-8 JSON, one envelope per line. This is the
// same line discipline upstream dsh uses for its SDK JSON-RPC, so a local
// stdio transport and a future loopback socket share one decoder.
//
// Phase 2 implements two transports, both local:
//   - stdio:  `uh serve` speaks the protocol on its own stdin/stdout.
//   - memory: an in-process pair for deterministic tests (brief §19: no paid
//             provider, no flaky I/O — a test double, not a fake of behaviour).
// The shape is symmetric so a loopback/TLS transport can be added later
// without touching protocol or server code.

import { once } from 'node:events';
import { MAX_ENVELOPE_BYTES } from '../protocol/mod.mjs';

const NEWLINE = 0x0a;

export class FrameError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'FrameError';
    this.frameError = kind; // 'oversized' | 'malformed'
  }
}

export class TransportError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'TransportError';
    this.transportError = kind; // 'closed' | 'read' | 'write' | 'oversized'
  }
}

/**
 * Decode a stream of newline-delimited JSON frames. Rejects oversized lines
 * and malformed JSON rather than buffering them — a hostile or buggy peer must
 * not be able to make us hold a giant partial frame in memory. After such a
 * rejection the decoder is poisoned: one bad frame ends the conversation, the
 * same choice a JSON-RPC peer makes.
 */
export function createFrameDecoder(onFrame, onError, { maxBytes = MAX_ENVELOPE_BYTES } = {}) {
  let buffer = Buffer.alloc(0);
  let poisoned = false;

  function flush() {
    while (!poisoned) {
      const nl = buffer.indexOf(NEWLINE);
      if (nl < 0) {
        // A partial frame with no newline must not accumulate without bound:
        // it faces the same ceiling a complete frame would. Without this cap a
        // peer could stream gigabytes that never terminate, defeating the
        // oversized-frame defence above.
        if (buffer.length > maxBytes) {
          poisoned = true;
          onError(new FrameError('oversized', `partial frame of ${buffer.length} bytes exceeds ${maxBytes} before any newline`));
        }
        return;
      }
      const line = buffer.subarray(0, nl);
      buffer = buffer.subarray(nl + 1);
      if (line.length === 0) continue; // tolerate blank lines (CRLF peers)
      if (line.length > maxBytes) {
        poisoned = true;
        onError(new FrameError('oversized', `frame of ${line.length} bytes exceeds ${maxBytes}`));
        return;
      }
      let parsed;
      try { parsed = JSON.parse(line.toString('utf8')); }
      catch (e) {
        poisoned = true;
        onError(new FrameError('malformed', `undecodable frame: ${e.message}`));
        return;
      }
      onFrame(parsed);
    }
  }

  return {
    push(chunk) {
      if (poisoned || !chunk) return;
      buffer = buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([buffer, Buffer.from(chunk)]);
      flush();
    },
    get pending() { return buffer.length; },
    get poisoned() { return poisoned; },
    reset() { buffer = Buffer.alloc(0); poisoned = false; },
  };
}

/** Encode one envelope as a frame. */
export function encodeFrame(envelope) {
  return Buffer.from(JSON.stringify(envelope) + '\n', 'utf8');
}

/**
 * Build a Transport. `send` enqueues the write and reports delivery failure
 * asynchronously through onClose/onError, the way a socket does — the protocol
 * layer never blocks on the wire.
 *
 * Returns { transport, notify }. `notify` is the privileged handle the
 * transport's own I/O code uses to deliver inbound frames and lifecycle events;
 * it is not part of the public shape.
 */
function buildTransport({ send, teardown, describe }) {
  const listeners = { message: [], close: [], error: [] };
  let closed = false;

  function emit(name, arg) {
    for (const fn of listeners[name]) {
      try { fn(arg); } catch (e) { /* a handler bug must not kill the transport */ }
    }
  }

  const transport = {
    get closed() { return closed; },
    send(envelope) {
      if (closed) throw new TransportError('closed', 'transport is closed');
      send(envelope);
      return true;
    },
    onMessage(fn) { listeners.message.push(fn); return transport; },
    onClose(fn) { listeners.close.push(fn); return transport; },
    onError(fn) { listeners.error.push(fn); return transport; },
    close(reason = 'closed locally') {
      if (closed) return;
      closed = true;
      teardown(reason);
      emit('close', reason);
    },
    describe: describe || (() => 'transport'),
  };

  const notify = {
    message: (env) => emit('message', env),
    // Inbound lifecycle events must not double-close; the local close() path
    // already emitted.
    close: (reason) => {
      if (closed) return;
      closed = true;
      teardown(reason);
      emit('close', reason);
    },
    error: (e) => emit('error', e),
  };
  // Privileged inbound handle for this module's I/O code. Non-enumerable so the
  // public shape stays clean and JSON-serialisable.
  Object.defineProperty(transport, '_notify', { value: notify, enumerable: false });
  return { transport, notify };
}

/**
 * A Transport over an arbitrary readable/writable pair — stdin/stdout on the
 * server, a child's pipes on the client.
 */
export function createStreamTransport({ input, output, name = 'stream' }) {
  const queue = [];
  let writing = false;

  const { transport, notify } = buildTransport({
    describe: () => name,
    send(envelope) {
      queue.push(encodeFrame(envelope));
      pump();
    },
    teardown() {
      try { input.pause(); } catch {}
      queue.length = 0;
      try { output.end(); } catch {}
    },
  });

  function pump() {
    if (writing || queue.length === 0) return;
    writing = true;
    const frame = queue.shift();
    const written = () => { writing = false; pump(); };
    const ok = output.write(frame, (err) => {
      if (err) notify.error(new TransportError('write', err.message));
      written();
    });
    if (!ok) output.once('drain', written);
  }

  const decoder = createFrameDecoder(notify.message, (e) => {
    notify.error(e);
    notify.close(e.frameError === 'oversized' ? 'oversized frame rejected' : 'malformed frame rejected');
  });

  input.on('data', (chunk) => decoder.push(chunk));
  input.on('end', () => notify.close('peer ended'));
  input.on('error', (e) => notify.error(new TransportError('read', e.message)));
  output.on('error', (e) => notify.error(new TransportError('write', e.message)));

  return transport;
}

/**
 * An in-process connected pair for tests. Delivery goes through the same
 * encode/decode path as a real stream, so protocol behaviour is exercised
 * identically. Either side simulates a disconnect by calling close().
 *
 * Returns { client, node }, each a full Transport.
 */
export function createMemoryTransportPair({ name = 'memory' } = {}) {
  // Each side owns a decoder and a notify handle; the wire between them is the
  // `wire` closure variable below, replaced atomically on close.
  const sides = {
    client: { decoder: null, notify: null },
    node: { decoder: null, notify: null },
  };
  let connected = true;

  const wire = (from) => (buf) => {
    if (!connected) {
      sides[from].notify.error(new TransportError('closed', 'peer disconnected'));
      return;
    }
    const to = from === 'client' ? 'node' : 'client';
    sides[to].decoder.push(buf);
  };

  const make = (label) => {
    const { transport, notify } = buildTransport({
      describe: () => `${name}:${label}`,
      send(envelope) { wire(label)(encodeFrame(envelope)); },
      teardown() {
        if (!connected) return;
        connected = false;
        const to = label === 'client' ? 'node' : 'client';
        // The peer observes a clean half-close, exactly like a socket end.
        sides[to].notify.close('peer disconnected');
      },
    });
    sides[label].notify = notify;
    sides[label].decoder = createFrameDecoder(notify.message, (e) => {
      notify.error(e);
      notify.close(e.frameError === 'oversized' ? 'oversized frame rejected' : 'malformed frame rejected');
    });
    return transport;
  };

  const client = make('client');
  const node = make('node');
  return { client, node };
}

/**
 * Client-side transport over a child process's stdio — how an in-process client
 * talks to a real `uh serve` subprocess. The child's stderr is surfaced through
 * onError as diagnostic text, never decoded as protocol frames.
 */
export async function createProcessTransport({ spawn, args = [], env = {}, cwd, name = 'process', readyMark = null }) {
  const child = spawn(args, { env: { ...process.env, ...env }, cwd, stdio: ['pipe', 'pipe', 'pipe'] });

  // Optionally wait for the child to print a readiness mark on stdout before
  // returning, so callers do not race the server's startup.
  if (readyMark) {
    await once(child.stdout, 'readable').catch(() => {});
  }

  const transport = createStreamTransport({ input: child.stdout, output: child.stdin, name });

  let stderrText = '';
  child.stderr.on('data', (c) => {
    stderrText += c.toString('utf8');
    if (stderrText.length > 8192) stderrText = stderrText.slice(-8192);
  });

  child.on('exit', (code, signal) => {
    const reason = code === null ? `killed by ${signal}` : `exit ${code}`;
    transport._notify.close(`${reason}${stderrText ? `\n${stderrText.trim()}` : ''}`);
  });

  transport.child = child;
  transport.kill = (signal = 'SIGTERM') => { try { child.kill(signal); } catch {} };
  return transport;
}
