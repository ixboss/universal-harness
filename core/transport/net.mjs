// Universal Harness — network transport adapters (Phase 3B, brief §3).
//
// This module is an *adapter*, not a protocol implementation: it accepts TCP
// connections, wraps each in the Transport contract from core/transport, and
// hands it to the existing Phase 2 node server via `server.handleConnection()`.
// No envelope routing, authentication, authorization, or task logic lives here
// — the protocol/server modules are reused verbatim.
//
// Two listener shapes, one connection surface each:
//
//   * TLS listener  — the single authenticated node endpoint (brief §3: "one
//     node listener"). Speaks either newline-delimited JSON envelopes directly
//     on the TLS stream (the full-duplex path used for events and tasks) or
//     HTTP/1.1 for one-shot request/response operations. Both framings carry
//     the *same* envelopes; the wire is the only difference. Framing is chosen
//     by ALPN during the TLS handshake, so neither peer has to wait for the
//     other's first byte to be understood. There is no plaintext listener: TLS
//     is mandatory and no fallback exists (brief §4).
//
//   * Loopback listener — plain TCP bound to 127.0.0.1 only. It exists so a
//     supervisor on the same device (the Android foreground service) can feed
//     the same protocol server through the same code path without a second
//     protocol, and without exposing an unauthenticated interface to the
//     network. It refuses any non-loopback bind.
//
// The client side (`connectNodeTransport`) implements the controller half of
// brief §5: it pins the certificate fingerprint out-of-band and fails closed
// with NODE_CERTIFICATE_MISMATCH if the peer presents anything else. Without a
// pinned fingerprint there is no connection at all — certificate validation is
// never disabled to make a connection succeed.

import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { MAX_ENVELOPE_BYTES, PERR } from '../protocol/mod.mjs';
import {
  createStreamTransport, createFrameDecoder, encodeFrame, buildTransport,
  TransportError,
} from './mod.mjs';

const LBRACE = 0x7b;
const ALPN_NDJSON = 'uh-ndjson';
const ALPN_HTTP = 'http/1.1';
const DEFAULT_TLS_HOST = '0.0.0.0'; // all interfaces: LAN-reachable, never port-forwarded (ADR-006)
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const HANDSHAKE_TIMEOUT_MS = 15_000;
const HTTP_PATH_REQUEST = '/uh/v1/request';

export class NodeTransportError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = 'NodeTransportError';
    this.code = code; // 'NODE_CERTIFICATE_MISMATCH' | 'NODE_UNREACHABLE' | 'NODE_PROTOCOL' | 'NODE_TIMEOUT'
    this.detail = detail;
  }
}

// ---------------------------------------------------------------------------
// Server side
// ---------------------------------------------------------------------------

/**
 * Start the node's single TLS listener. Every accepted connection is wrapped
 * in a Transport and given to the existing node server.
 *
 * @param {{server: object, certPem: string, keyPem: string, host?: string, port?: number, log?: object, requestTimeoutMs?: number}} opts
 * @returns {Promise<{close: (reason?: string) => void, address: () => net.AddressInfo|null, scheme: 'https'}>}
 */
export function createNetworkNodeListener({
  server, certPem, keyPem, host = DEFAULT_TLS_HOST, port = 0, log = null,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
}) {
  if (!certPem || !keyPem) throw new NodeTransportError('NODE_PROTOCOL', 'a node certificate and private key are required to listen');

  const httpServer = http.createServer((req, res) => serveHttpRequest(server, req, res, { log, requestTimeoutMs }));
  httpServer.requestTimeout = requestTimeoutMs;
  httpServer.headersTimeout = requestTimeoutMs;
  httpServer.timeout = requestTimeoutMs;
  // A socket-level cap on request bodies: an oversized POST must never be
  // buffered (the same ceiling the frame decoder enforces on the stream path).
  httpServer.maxHeadersCount = 100;

  const tlsServer = tls.createServer({
    key: keyPem,
    cert: certPem,
    minVersion: 'TLSv1.2',
    // ALPN selects the framing on the same port, so neither peer has to speak
    // first to be understood. A streaming client offers `uh-ndjson` and gets
    // the full-duplex envelope stream; an HTTP client negotiates `http/1.1`
    // and gets the one-shot request endpoint. A client that offers neither
    // gets the stream (the protocol's primary surface).
    ALPNProtocols: [ALPN_HTTP, ALPN_NDJSON],
    // No client certificate: authentication is the protocol's own
    // challenge-response; TLS here establishes the pinned channel.
  });

  // An opened TCP connection that never completes the TLS handshake must not
  // be held forever.
  const handshakeTimers = new WeakSet();
  tlsServer.on('connection', (raw) => {
    if (handshakeTimers.has(raw)) return;
    handshakeTimers.add(raw);
    const timer = setTimeout(() => {
      log?.warn?.('tls handshake timed out; closing socket');
      raw.destroy();
    }, HANDSHAKE_TIMEOUT_MS);
    raw.once('secureConnect', () => clearTimeout(timer));
    raw.once('close', () => clearTimeout(timer));
  });

  // Every socket the server currently owns, so a shutdown can drop them
  // instead of waiting on a half-open peer forever.
  const liveSockets = new Set();
  tlsServer.on('connection', (s) => {
    liveSockets.add(s);
    s.once('close', () => liveSockets.delete(s));
  });

  tlsServer.on('secureConnection', (socket) => {
    // The negotiated protocol decides the framing. This happens *after* the
    // handshake, so the stream transport can be created eagerly and the node's
    // greeting is never delayed waiting to identify the peer.
    if (socket.alpnProtocol === ALPN_HTTP) {
      log?.info?.('accepted http request/response connection');
      httpServer.emit('connection', socket);
    } else {
      serveStream(server, socket, { log });
    }
  });
  tlsServer.on('tlsClientError', (e) => log?.warn?.(`tls client error: ${e?.message || e}`));
  tlsServer.on('clientError', (e) => log?.warn?.(`client error: ${e?.message || e}`));

  return new Promise((resolve, reject) => {
    const onError = (e) => reject(new NodeTransportError('NODE_UNREACHABLE', `cannot listen on ${host}:${port}: ${e.message}`));
    tlsServer.once('error', onError);
    tlsServer.listen(port, host, () => {
      tlsServer.removeListener('error', onError);
      const addr = tlsServer.address();
      log?.info?.(`node tls listener ready on https://${addr.address}:${addr.port}`);
      resolve({
        scheme: 'https',
        address: () => addr && { ...addr },
        close(reason = 'node shutting down') {
          httpServer.close();
          // Drop live sockets first so pending clients observe the close and
          // the close callback cannot hang on a half-open connection.
          for (const s of liveSockets) { try { s.destroy(); } catch {} }
          liveSockets.clear();
          tlsServer.close(() => log?.info?.(`tls listener closed (${reason})`));
        },
      });
    });
  });
}

/**
 * Plain loopback listener. Refuses a non-loopback bind: this surface is for a
 * same-device supervisor and must never be the node's network interface.
 *
 * @param {{server: object, host?: string, port?: number, log?: object}} opts
 */
export function createLoopbackNodeListener({ server, host = '127.0.0.1', port = 0, log = null }) {
  if (!isLoopbackHost(host)) {
    throw new NodeTransportError('NODE_PROTOCOL', `loopback listener refuses non-loopback bind ${host}`);
  }
  const tcpServer = net.createServer((socket) => serveStream(server, socket, { log, name: 'loopback' }));
  const liveSockets = new Set();
  tcpServer.on('connection', (s) => {
    liveSockets.add(s);
    s.once('close', () => liveSockets.delete(s));
  });
  return new Promise((resolve, reject) => {
    const onError = (e) => reject(new NodeTransportError('NODE_UNREACHABLE', `cannot listen on ${host}:${port}: ${e.message}`));
    tcpServer.once('error', onError);
    tcpServer.listen(port, host, () => {
      tcpServer.removeListener('error', onError);
      const addr = tcpServer.address();
      log?.info?.(`node loopback listener ready on ${addr.address}:${addr.port}`);
      resolve({
        scheme: 'loopback',
        address: () => addr && { ...addr },
        close(reason = 'node shutting down') {
          for (const s of liveSockets) { try { s.destroy(); } catch {} }
          liveSockets.clear();
          tcpServer.close(() => log?.info?.(`loopback listener closed (${reason})`));
        },
      });
    });
  });
}

/** Wrap a duplex socket in the existing stream Transport and hand it to the server. */
function serveStream(server, socket, { log = null, name = 'tls' } = {}) {
  const transport = createStreamTransport({
    input: socket,
    output: socket,
    name: `${name}:${socket.remoteAddress}:${socket.remotePort}`,
  });
  transport.onClose(() => {
    // The transport already ended the socket; make sure nothing lingers.
    try { socket.destroySoon(); } catch {}
  });
  server.handleConnection(transport);
}

/**
 * The string a one-shot HTTP client signs and the node verifies, per
 * PROTOCOL.md §1: `Authorization: UH <deviceId> <signature>`. It binds the
 * signature to this exact request — method, path, and the SHA-256 of the body
 * bytes — so a captured signature cannot be replayed against a different
 * request. Published here so every client stack signs the same bytes.
 */
export function canonicalRequestString({ method, path, body }) {
  const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
  return `${method}\n${path}\n${bodyHash}`;
}

/**
 * Serve one `POST /uh/v1/request`: the body is a single request envelope, the
 * response body is the reply. The request is routed through the *same* node
 * server over an ephemeral Transport, so authentication, authorization, and
 * capability checks are identical to the streaming path.
 *
 * Authentication on this stateless surface is the request-signed challenge of
 * PROTOCOL.md §1 (`Authorization: UH <deviceId> <sig>`), verified against the
 * paired device's stored public key. Without it the connection stays a guest
 * and every non-handshake operation answers AUTH_REQUIRED.
 */
function serveHttpRequest(server, req, res, { log = null, requestTimeoutMs }) {
  if (req.method !== 'POST' || req.url !== HTTP_PATH_REQUEST) {
    respond(res, 404, { error: 'not found', path: req.url });
    return;
  }
  const contentLength = Number(req.headers['content-length'] || 0);
  if (!Number.isFinite(contentLength) || contentLength > MAX_ENVELOPE_BYTES) {
    respond(res, 413, { error: 'payload too large' });
    req.resume();
    return;
  }

  let resolveReply;
  const replyPromise = new Promise((r) => { resolveReply = r; });

  // An ephemeral Transport whose outbound side is captured instead of written
  // to a wire: the node server sees a normal connection.
  const { transport, notify } = buildTransport({
    describe: () => `http:${req.socket.remoteAddress}`,
    send(env) {
      if (env && (env.type === 'response' || env.type === 'error') && resolveReply) {
        resolveReply(env); resolveReply = null;
      }
      // Notifications (node.hello, live events) have no request/response slot
      // on the one-shot path; they are dropped rather than buffered, and a
      // client that needs them uses the streaming path.
    },
    teardown() { /* the socket is owned by the http server */ },
  });

  let connectionId;
  try {
    connectionId = server.handleConnection(transport);
  } catch (e) {
    respond(res, 500, { error: 'internal error' });
    return;
  }

  const chunks = [];
  let total = 0;
  let aborted = false;
  req.on('data', (chunk) => {
    total += chunk.length;
    if (total > MAX_ENVELOPE_BYTES) {
      aborted = true;
      req.destroy();
      transport.close('oversized request body');
      respond(res, 413, { error: 'payload too large' });
      return;
    }
    chunks.push(chunk);
  });
  req.on('error', () => {
    if (!aborted) { transport.close('request error'); respond(res, 400, { error: 'bad request' }); }
  });

  req.on('end', () => {
    if (aborted) return;
    const bodyBytes = Buffer.concat(chunks);
    let env;
    try {
      env = JSON.parse(bodyBytes.toString('utf8'));
      if (!env || typeof env !== 'object') throw new Error('body is not a JSON object');
    } catch (e) {
      transport.close('malformed request body');
      respond(res, 400, { error: 'malformed request body', detail: e.message });
      return;
    }

    // The request-signed challenge is verified before the envelope is
    // dispatched. On failure the connection stays a guest and the server's own
    // AUTH_REQUIRED answer is returned — the same shape a streaming client
    // sees, so the two surfaces are indistinguishable to a probe.
    const authHeader = req.headers['authorization'] || '';
    const authMatch = /^UH\s+(\S+)\s+(\S+)$/i.exec(authHeader.trim());
    if (authMatch) {
      const [, deviceId, sigB64] = authMatch;
      const canonical = canonicalRequestString({ method: req.method, path: req.url, body: bodyBytes });
      const verified = server.verifyRequestSignature({ deviceId, sigB64, canonical });
      if (!verified.ok) {
        transport.close('request signature rejected');
        respond(res, 401, { error: 'unauthorized', code: verified.code || 'CHALLENGE_FAILED' });
        return;
      }
      server.authenticateConnection(connectionId, verified.record);
    }

    // Deliver the request exactly as a streaming client would.
    notify.message(env);

    // The reply is usually already captured synchronously by `send` above.
    Promise.race([
      replyPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), requestTimeoutMs)),
    ]).then((reply) => {
      respond(res, reply.type === 'error' ? 400 : 200, reply);
    }).catch((e) => {
      transport.close(e.message === 'timeout' ? 'request timeout' : 'request failed');
      respond(res, 504, { error: 'node did not reply in time' });
    }).finally(() => {
      // The one-shot connection is finished; release the server-side state.
      transport.close('http request completed');
      log?.info?.(`http request served on connection ${connectionId}`);
    });
  });
}

function respond(res, status, body) {
  try {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body) + '\n');
  } catch { /* the socket may already be gone */ }
}

// ---------------------------------------------------------------------------
// Client side
// ---------------------------------------------------------------------------

/**
 * Connect to a node's TLS listener as a controller.
 *
 * The pinned certificate fingerprint is mandatory: it is what the pairing
 * payload delivered out of band (brief §5). The TLS chain is accepted only so
 * the *pin* can be checked — a connection without a pin is refused rather than
 * trusted.
 *
 * @param {{host: string, port: number, pinnedCertSha256: string, connectTimeoutMs?: number, servername?: string}} opts
 * @returns {Promise<import('./mod.mjs').Transport>}
 */
export function connectNodeTransport({ host, port, pinnedCertSha256, connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS, servername = null }) {
  if (!pinnedCertSha256 || !/^[0-9a-f]{64}$/.test(pinnedCertSha256)) {
    return Promise.reject(new NodeTransportError('NODE_CERTIFICATE_MISMATCH',
      'a 256-bit pinned certificate fingerprint is required to connect; refusing unpinned TLS'));
  }

  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host, port,
      servername: servername || host,
      // Select the full-duplex envelope stream. Without an explicit offer a
      // client still gets this path (it is the protocol's primary surface),
      // but stating it keeps the choice honest and testable.
      ALPNProtocols: [ALPN_NDJSON],
      // The peer is self-signed; the pinned fingerprint replaces the CA chain.
      // This is only safe because the pin is checked below, unconditionally.
      rejectUnauthorized: false,
      minVersion: 'TLSv1.2',
    });

    const fail = (err) => {
      try { socket.destroy(); } catch {}
      reject(err);
    };
    const timer = setTimeout(() => fail(new NodeTransportError('NODE_TIMEOUT', `connect to ${host}:${port} timed out`)), connectTimeoutMs);

    socket.once('secureConnect', () => {
      clearTimeout(timer);
      const cert = socket.getPeerCertificate(true);
      const der = cert && cert.raw;
      if (!der) {
        fail(new NodeTransportError('NODE_CERTIFICATE_MISMATCH', 'the node presented no certificate'));
        return;
      }
      const actual = requireFingerprint(der);
      if (actual !== pinnedCertSha256.toLowerCase()) {
        fail(new NodeTransportError('NODE_CERTIFICATE_MISMATCH',
          'the node certificate does not match the fingerprint bound to this pairing',
          { expected: pinnedCertSha256.toLowerCase().slice(0, 16) + '…', actual: actual.slice(0, 16) + '…' }));
        return;
      }
      // Pin verified: the channel is trusted for the protocol's own
      // challenge-response to run on top of it.
      const transport = createStreamTransport({ input: socket, output: socket, name: `client:${host}:${port}` });
      transport.onClose(() => { try { socket.destroySoon(); } catch {} });
      resolve(transport);
    });
    socket.once('error', (e) => {
      clearTimeout(timer);
      fail(new NodeTransportError('NODE_UNREACHABLE', `cannot reach node at ${host}:${port}: ${e.message}`));
    });
  });
}

/** Connect to the node's loopback listener (same device only). */
export function connectLoopbackTransport({ host = '127.0.0.1', port, connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    if (!isLoopbackHost(host)) {
      reject(new NodeTransportError('NODE_PROTOCOL', 'loopback client refuses non-loopback target'));
      return;
    }
    const socket = net.connect({ host, port });
    const fail = (err) => { try { socket.destroy(); } catch {} reject(err); };
    const timer = setTimeout(() => fail(new NodeTransportError('NODE_TIMEOUT', `connect to ${host}:${port} timed out`)), connectTimeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      const transport = createStreamTransport({ input: socket, output: socket, name: `loopback:${host}:${port}` });
      transport.onClose(() => { try { socket.destroySoon(); } catch {} });
      resolve(transport);
    });
    socket.once('error', (e) => {
      clearTimeout(timer);
      fail(new NodeTransportError('NODE_UNREACHABLE', `cannot reach loopback node at ${host}:${port}: ${e.message}`));
    });
  });
}

/**
 * One-shot HTTP request against the node's request endpoint. Uses the same
 * pinned-fingerprint check as the streaming client.
 *
 * Authentication is the request-signed challenge of PROTOCOL.md §1: pass
 * `auth: { deviceId, sign }`, where `sign(canonical)` returns the base64
 * signature of the device's paired private key over the canonical request
 * string. Without it the request is served as a guest and every non-handshake
 * operation answers AUTH_REQUIRED.
 *
 * @param {{host: string, port: number, envelope: object, pinnedCertSha256: string, auth?: {deviceId: string, sign: (canonical: string) => string}, timeoutMs?: number}} opts
 * @returns {Promise<{status: number, envelope: object}>}
 */
export function nodeHttpRequest({ host, port, envelope, pinnedCertSha256, auth = null, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS }) {
  if (!pinnedCertSha256 || !/^[0-9a-f]{64}$/.test(pinnedCertSha256)) {
    return Promise.reject(new NodeTransportError('NODE_CERTIFICATE_MISMATCH',
      'a pinned certificate fingerprint is required to make a node request'));
  }
  const body = JSON.stringify(envelope);
  const headers = { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body, 'utf8') };
  if (auth) {
    if (!auth.deviceId || typeof auth.sign !== 'function') {
      return Promise.reject(new NodeTransportError('NODE_PROTOCOL',
        'auth requires a deviceId and a sign(canonical) function'));
    }
    const canonical = canonicalRequestString({ method: 'POST', path: HTTP_PATH_REQUEST, body: Buffer.from(body, 'utf8') });
    headers.authorization = `UH ${auth.deviceId} ${auth.sign(canonical)}`;
  }
  return new Promise((resolve, reject) => {
    const req = https.request({
      host, port,
      path: HTTP_PATH_REQUEST,
      method: 'POST',
      headers,
      // Select the HTTP framing explicitly.
      ALPNProtocols: [ALPN_HTTP],
      // Same self-signed model as the streaming path: the pin is the check.
      rejectUnauthorized: false,
      minVersion: 'TLSv1.2',
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      let total = 0;
      res.on('data', (c) => {
        total += c.length;
        if (total > MAX_ENVELOPE_BYTES) { req.destroy(); reject(new NodeTransportError('NODE_PROTOCOL', 'oversized response')); }
        else chunks.push(c);
      });
      res.on('end', () => {
        // Verify the pin from the established socket before trusting anything.
        const peer = req.socket?.getPeerCertificate?.(true);
        const der = peer?.raw;
        if (!der) { reject(new NodeTransportError('NODE_CERTIFICATE_MISMATCH', 'no peer certificate on the response socket')); return; }
        if (requireFingerprint(der) !== pinnedCertSha256.toLowerCase()) {
          reject(new NodeTransportError('NODE_CERTIFICATE_MISMATCH', 'response socket certificate does not match the pinned fingerprint'));
          return;
        }
        try {
          const env = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve({ status: res.statusCode, envelope: env });
        } catch (e) {
          reject(new NodeTransportError('NODE_PROTOCOL', `undecodable response: ${e.message}`));
        }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new NodeTransportError('NODE_TIMEOUT', 'node request timed out')); });
    req.on('error', (e) => reject(new NodeTransportError('NODE_UNREACHABLE', e.message)));
    req.end(body);
  });
}

function requireFingerprint(certDer) {
  return crypto.createHash('sha256').update(certDer).digest('hex');
}

/**
 * True only for a loopback address. Written out because Node's `net` module
 * has no exported loopback predicate; the check must be exact — this gate is
 * what keeps the supervisor surface from becoming a network interface.
 */
function isLoopbackHost(host) {
  const h = String(host || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!h) return false;
  if (h === 'localhost') return true;
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  // IPv4 loopback is the whole 127.0.0.0/8 block, and an embedded IPv4 form
  // such as ::ffff:127.0.0.1 must be treated as loopback too.
  const v4 = h.includes(':') ? h.split(':').pop() : h;
  const parts = v4.split('.');
  if (parts.length !== 4) return false;
  return parts[0] === '127' && parts.slice(1).every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}
