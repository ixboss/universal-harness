// Universal Protocol v1 — protocol core.
//
// The machine-readable contract is shared/protocol/v1/*.schema.json (Phase 0.1).
// This module is its runtime implementation: envelope construction/validation,
// deterministic serialization, version negotiation, capability advertisement,
// and protocol errors. It does not invent a second protocol — every message it
// produces is schema-conformant, and every incoming message is validated.

import { randomBytes, createHash } from 'node:crypto';
import { Validator, bundledSchemas } from './validate.mjs';
import { redact } from '../errors/mod.mjs';

export const PROTOCOL_VERSION = 1;
export const SUPPORTED_VERSION_RANGE = [1, 1]; // [min, max] inclusive

export const ENVELOPE_TYPES = ['request', 'response', 'event', 'error', 'notification'];

// Wire-level message kinds (payload.kind). The catalog in
// capabilities.schema.json OperationKind is the advertisement subset.
export const KINDS = {
  AUTH_CONNECT: 'auth.connect',
  NODE_HELLO: 'node.hello',
  DEVICE_PAIR: 'device.pair',
  DEVICE_LIST: 'device.list',
  DEVICE_REVOKE: 'device.revoke',
  SESSION_LIST: 'session.list',
  SESSION_CREATE: 'session.create',
  SESSION_READ: 'session.read',
  SESSION_REPLAY: 'session.replay',
  SESSION_RESUME: 'session.resume',
  PROJECT_LIST: 'project.list',
  PROJECT_CREATE: 'project.create',
  PROJECT_OPEN: 'project.open',
  TASK_START: 'task.start',
  TASK_LIST: 'task.list',
  TASK_CANCEL: 'task.cancel',
  TASK_APPROVE: 'task.approve',
  TASK_HISTORY: 'task.history',
  FILE_BROWSE: 'file.browse',
  FILE_READ: 'file.read',
  FILE_WRITE: 'file.write',
  TERMINAL_EXEC: 'terminal.exec',
  TERMINAL_CANCEL: 'terminal.cancel',
  DIAGNOSTICS_RUN: 'diagnostics.run',
};

// Protocol error codes (errors.schema.json ErrorCode). New in Phase 2:
// INVALID_MESSAGE for malformed/oversized/undecodable envelopes.
export const PERR = {
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  AUTH_FAILED: 'AUTH_FAILED',
  CHALLENGE_FAILED: 'CHALLENGE_FAILED',
  SCOPE_DENIED: 'SCOPE_DENIED',
  DEVICE_REVOKED: 'DEVICE_REVOKED',
  PAIRING_EXPIRED: 'PAIRING_EXPIRED',
  PAIRING_CONSUMED: 'PAIRING_CONSUMED',
  PROTOCOL_VERSION_MISMATCH: 'PROTOCOL_VERSION_MISMATCH',
  CAPABILITY_UNSUPPORTED: 'CAPABILITY_UNSUPPORTED',
  NOT_FOUND: 'NOT_FOUND',
  WORKSPACE_LOCKED: 'WORKSPACE_LOCKED',
  WORKSPACE_UNAVAILABLE: 'WORKSPACE_UNAVAILABLE',
  SESSION_SCHEMA_UNSUPPORTED: 'SESSION_SCHEMA_UNSUPPORTED',
  TASK_NOT_FOUND: 'TASK_NOT_FOUND',
  TASK_ALREADY_DONE: 'TASK_ALREADY_DONE',
  CONFLICT: 'CONFLICT',
  STORAGE_INSUFFICIENT: 'STORAGE_INSUFFICIENT',
  STORAGE_READ_ONLY: 'STORAGE_READ_ONLY',
  MIGRATION_REQUIRED: 'MIGRATION_REQUIRED',
  MIGRATION_FAILED: 'MIGRATION_FAILED',
  UPDATE_FAILED: 'UPDATE_FAILED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  UNAVAILABLE: 'UNAVAILABLE',
  INVALID_MESSAGE: 'INVALID_MESSAGE', // Phase 2: malformed/oversized envelope
};

// Pairing failure codes (pairing.schema.json PairingFailureCode).
export const PAIR_FAIL = {
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  TOKEN_CONSUMED: 'TOKEN_CONSUMED',
  NODE_IDENTITY_MISMATCH: 'NODE_IDENTITY_MISMATCH',
  NODE_CERTIFICATE_MISMATCH: 'NODE_CERTIFICATE_MISMATCH',
  CHALLENGE_FAILED: 'CHALLENGE_FAILED',
  PAIRED_AS_DIFFERENT_NODE: 'PAIRED_AS_DIFFERENT_NODE',
};

// Default bound. Oversized envelopes are rejected rather than buffered.
export const MAX_ENVELOPE_BYTES = 1024 * 1024;

let _schemas = null;
/** Lazily load the bundled schema set (one parse pass per process). */
export function schemas() {
  if (!_schemas) _schemas = bundledSchemas();
  return _schemas;
}

/** Canonical (deterministic) JSON: sorted keys, no whitespace. For hashes and signatures. */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
}

export function sha256Hex(data) {
  return createHash('sha256').update(typeof data === 'string' ? data : canonicalJson(data), 'utf8').digest('hex');
}

/** RFC 3339 UTC timestamp with millisecond precision. */
export function now() {
  return new Date().toISOString();
}

/** A fresh request id, client-side shape: ^[A-Za-z0-9_-]{8,64}$. */
export function newRequestId(prefix = 'req') {
  return `${prefix}_${randomBytes(9).toString('base64url').slice(0, 21)}`;
}

/**
 * Build an envelope. `eventId` is only ever set by the durable event store,
 * exactly when the event is appended (never optimistically).
 */
export function envelope({ type, kind, payload, requestId = null, eventId = null, timestamp = now(), trace = null }) {
  const env = { protocolVersion: PROTOCOL_VERSION, type, timestamp, payload: { kind, ...payload } };
  if (requestId) env.requestId = requestId;
  if (eventId !== null && eventId !== undefined) env.eventId = eventId;
  if (trace) env.trace = trace;
  return env;
}

export function requestEnvelope(kind, payload, requestId = newRequestId()) {
  return envelope({ type: 'request', kind, payload, requestId });
}
export function responseEnvelope(requestId, kind, payload) {
  return envelope({ type: 'response', kind, payload, requestId });
}
export function eventEnvelope(kind, payload, eventId) {
  return envelope({ type: 'event', kind, payload, eventId });
}
export function notificationEnvelope(kind, payload) {
  return envelope({ type: 'notification', kind, payload });
}

/**
 * Structured protocol error. `safeContext` is redacted before it reaches the
 * wire — secrets never appear in an error payload.
 */
export function errorEnvelope(requestId, code, message, { detail = null, diagnosticId = null, retryable = false, data = null } = {}) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: 'error',
    timestamp: now(),
    requestId: requestId || undefined,
    payload: {
      code,
      message,
      ...(detail ? { detail: redact(String(detail)).slice(0, 500) } : {}),
      ...(diagnosticId ? { diagnosticId } : {}),
      retryable,
      ...(data ? { data: redactObjectShallow(data) } : {}),
    },
  };
}

function redactObjectShallow(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = typeof v === 'string' ? redact(v) : v;
  return out;
}

/**
 * Validate a decoded envelope against the bundled contract.
 * Returns { ok, error }. Version handling is strict: v1 only; anything else is
 * PROTOCOL_VERSION_MISMATCH with the range this node supports — never silently
 * accepted, and never echoed with internal details.
 */
export function validateEnvelope(env) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) return invalid('envelope must be a JSON object');
  if (!Number.isInteger(env.protocolVersion)) return invalid('protocolVersion is required (integer)');
  if (env.protocolVersion !== PROTOCOL_VERSION) {
    return { ok: false, error: 'unsupported protocolVersion', code: PERR.PROTOCOL_VERSION_MISMATCH,
      detail: { supportedRange: SUPPORTED_VERSION_RANGE, received: env.protocolVersion } };
  }
  const envCheck = schemas().validateDocument('envelope.schema.json', env);
  if (!envCheck.ok) return invalid(envelopeFormatMessage(envCheck.error));
  const payload = env.payload;
  if (!payload || typeof payload !== 'object') return invalid('payload is required and must be an object');
  if (typeof payload.kind !== 'string' || !payload.kind) return invalid('payload.kind is required');
  return { ok: true };
}

/**
 * Message-level validation of a request/response payload against its schema.
 * `payload.kind` is the discriminator that selected this schema, not a field of
 * it — the operation $defs close with additionalProperties: false, so it is
 * removed before validation (envelope validation already checked it).
 */
export function validatePayload(kind, type, payload) {
  const def = PAYLOAD_SCHEMA_DEF[kind];
  if (!def) return { ok: false, error: `no schema mapping for kind "${kind}"` };
  const [doc, defName] = def;
  const body = { ...payload };
  delete body.kind;
  const r = schemas().validateDef(doc, defName, body);
  if (!r.ok) return { ok: false, error: envelopeFormatMessage(r.error) };
  return { ok: true };
}

// Map of payload.kind -> [schemaDocument, $defs entry]. Kept complete: every
// implemented message type has a schema (brief §17).
const PAYLOAD_SCHEMA_DEF = {
  [KINDS.NODE_HELLO]: ['operations.schema.json', 'NodeHello'],
  [KINDS.AUTH_CONNECT]: ['operations.schema.json', 'AuthConnect'],
  [KINDS.DEVICE_PAIR]: ['pairing.schema.json', 'PairRequest'],
  [KINDS.SESSION_REPLAY]: ['operations.schema.json', 'ReconnectHandshake'],
  [KINDS.TASK_START]: ['operations.schema.json', 'TaskStartRequest'],
  [KINDS.TASK_APPROVE]: ['operations.schema.json', 'TaskApproval'],
  [KINDS.FILE_WRITE]: ['operations.schema.json', 'FileWriteRequest'],
  [KINDS.FILE_READ]: ['operations.schema.json', 'FileReadRequest'],
  [KINDS.FILE_BROWSE]: ['operations.schema.json', 'FileBrowseRequest'],
  [KINDS.PROJECT_CREATE]: ['operations.schema.json', 'ProjectCreateRequest'],
  [KINDS.PROJECT_OPEN]: ['operations.schema.json', 'ProjectOpenRequest'],
  [KINDS.TASK_CANCEL]: ['operations.schema.json', 'TaskCancelRequest'],
  [KINDS.DEVICE_REVOKE]: ['operations.schema.json', 'DeviceRevokeRequest'],
  [KINDS.TERMINAL_EXEC]: ['operations.schema.json', 'TerminalRequest'],
  [KINDS.DIAGNOSTICS_RUN]: ['operations.schema.json', 'DiagnosticsRunRequest'],
  // Response payloads are validated by their request-side response schemas where
  // the contract defines them (FileReadResponse, ReplayResponse, ...); the rest
  // are validated structurally by the dispatch layer.
  [KINDS.DEVICE_LIST]: ['operations.schema.json', 'DeviceListRequest'],
  [KINDS.SESSION_LIST]: ['operations.schema.json', 'SessionListRequest'],
  [KINDS.SESSION_CREATE]: ['operations.schema.json', 'SessionCreateRequest'],
  [KINDS.SESSION_READ]: ['operations.schema.json', 'SessionReadRequest'],
  [KINDS.SESSION_RESUME]: ['operations.schema.json', 'SessionResumeRequest'],
  [KINDS.PROJECT_LIST]: ['operations.schema.json', 'ProjectListRequest'],
  [KINDS.TASK_LIST]: ['operations.schema.json', 'TaskListRequest'],
  [KINDS.TASK_HISTORY]: ['operations.schema.json', 'TaskHistoryRequest'],
  [KINDS.TERMINAL_CANCEL]: ['operations.schema.json', 'TerminalCancelRequest'],
};

function envelopeFormatMessage(msg) {
  return `envelope rejected by schema: ${msg}`;
}
function invalid(message, code = PERR.INVALID_MESSAGE) {
  return { ok: false, error: message, code };
}

/**
 * Negotiation happens on the wire, not in a handshake subroutine: the node
 * advertises its supported version range and operation set in node.hello (see
 * buildCapabilities / the server greeting), and every inbound envelope is
 * strictly version-validated per message by validateEnvelope. There is no
 * second negotiation path — a client outside the advertised range cannot send
 * a valid envelope at all, and gets PROTOCOL_VERSION_MISMATCH (with the node's
 * supportedRange) on its first attempt.
 */

/**
 * The node's capability object, built from live state. `dshVersion` and storage
 * figures come from the runtime manager so the object can never drift from
 * reality.
 */
export function buildCapabilities({ nodeId, platform, architecture, uhVersion, dshVersion, operations, taskControls = { cancel: true, approveTool: false, pauseResume: false }, storage = null, pairingOpen = false, diagnosticsEnabled = true }) {
  const caps = {
    nodeId,
    platform,
    architecture,
    nodeKind: 'desktop',
    uhVersion,
    dshVersion,
    protocolVersionRange: SUPPORTED_VERSION_RANGE,
    operations,
    pairingIdentityBinding: true, // v1 nodes MUST bind pairing tokens to node identity
    taskControls,
    node: { pairing: pairingOpen, lanOnly: true, updateable: false },
    diagnostics: diagnosticsEnabled,
  };
  if (storage) caps.storage = storage;
  return caps;
}

/** Operations this node actually serves (the advertisement subset). */
export const ADVERTISED_OPERATIONS = [
  KINDS.AUTH_CONNECT,
  KINDS.DEVICE_PAIR,
  KINDS.DEVICE_LIST,
  KINDS.DEVICE_REVOKE,
  KINDS.SESSION_REPLAY,
  KINDS.PROJECT_LIST,
  KINDS.PROJECT_CREATE,
  KINDS.PROJECT_OPEN,
  KINDS.TASK_START,
  KINDS.TASK_LIST,
  KINDS.TASK_CANCEL,
  KINDS.TASK_HISTORY,
  KINDS.FILE_BROWSE,
  KINDS.FILE_READ,
  KINDS.FILE_WRITE,
  KINDS.DIAGNOSTICS_RUN,
];

/** Event kinds this node may emit (events.schema.json EventKind). */
export const EMITTED_EVENT_KINDS = [
  'task.queued', 'task.started', 'task.waiting', 'task.completed', 'task.failed', 'task.cancelled',
  'task.output', 'task.reasoning', 'task.tool_started', 'task.tool_finished',
  'session.created', 'session.updated',
  'device.status_changed', 'node.state_changed', 'diagnostics.issue', 'file.changed',
];

/**
 * Durability contract (events.schema.json EventDurability), enforced in code:
 * durable kinds are appended to the node event store and receive an eventId on
 * append; live-only kinds are streamed and never persisted.
 */
export const DURABILITY = {
  'task.queued': 'durable',
  'task.started': 'durable',
  'task.waiting': 'durable',
  'task.completed': 'durable',
  'task.failed': 'durable',
  'task.cancelled': 'durable',
  'task.output': 'live-only',
  'task.reasoning': 'live-only',
  'task.tool_started': 'live-only',
  'task.tool_finished': 'live-only',
  'session.created': 'durable',
  'session.updated': 'durable',
  'device.status_changed': 'live-only',
  'node.state_changed': 'live-only',
  'diagnostics.issue': 'durable',
  'file.changed': 'durable',
  'update.available': 'live-only',
  'update.applied': 'durable',
  'sync.conflict': 'durable',
  'terminal.output': 'live-only',
  'terminal.exited': 'durable',
};

export function isDurable(kind) {
  return DURABILITY[kind] === 'durable';
}

/** Decode a raw buffer/string into a JSON envelope, with size bounds. */
export function decodeEnvelope(raw) {
  const bytes = typeof raw === 'string' ? Buffer.byteLength(raw, 'utf8') : raw.length;
  if (bytes > MAX_ENVELOPE_BYTES) {
    return { ok: false, code: PERR.INVALID_MESSAGE,
      error: `envelope exceeds the ${MAX_ENVELOPE_BYTES}-byte limit` };
  }
  let parsed;
  try { parsed = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8')); }
  catch (e) { return { ok: false, code: PERR.INVALID_MESSAGE, error: 'payload is not valid JSON' }; }
  const v = validateEnvelope(parsed);
  if (!v.ok) return { ok: false, code: v.code || PERR.INVALID_MESSAGE, error: v.error, detail: v.detail };
  return { ok: true, envelope: parsed };
}
