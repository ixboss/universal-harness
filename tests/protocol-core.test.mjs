// Phase 2 — Protocol core tests (brief §18 "Protocol").
// Invariants: envelope validation, strict version handling, request/response
// correlation, deterministic serialization, malformed input rejection, and
// capability negotiation that never advertises what is not implemented.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  PROTOCOL_VERSION, SUPPORTED_VERSION_RANGE, KINDS, PERR,
  requestEnvelope, responseEnvelope, eventEnvelope, errorEnvelope,
  validateEnvelope, validatePayload, decodeEnvelope,
  buildCapabilities, ADVERTISED_OPERATIONS,
  canonicalJson, sha256Hex, newRequestId, isDurable, DURABILITY,
  EMITTED_EVENT_KINDS, schemas,
} from '../core/protocol/mod.mjs';

test('envelope: a well-formed request validates', () => {
  const env = requestEnvelope('task.start', { projectId: 'proj_' + 'a'.repeat(32), prompt: 'hi' });
  assert.equal(validateEnvelope(env).ok, true);
});

test('envelope: protocolVersion is required and must be exactly v1', () => {
  const noVersion = { type: 'request', timestamp: new Date().toISOString(), payload: { kind: 'task.start' } };
  assert.equal(validateEnvelope(noVersion).code, PERR.INVALID_MESSAGE);

  const future = requestEnvelope('task.start', {});
  future.protocolVersion = 2;
  const r = validateEnvelope(future);
  assert.equal(r.ok, false);
  assert.equal(r.code, PERR.PROTOCOL_VERSION_MISMATCH);
  // The failure carries the supported range and nothing internal.
  assert.deepEqual(r.detail.supportedRange, SUPPORTED_VERSION_RANGE);
});

test('envelope: a non-object payload is rejected', () => {
  const env = requestEnvelope('task.start', {});
  env.payload = 'nope';
  assert.equal(validateEnvelope(env).ok, false);
});

test('envelope: missing payload.kind is rejected', () => {
  const env = requestEnvelope('task.start', {});
  env.payload = {};
  assert.equal(validateEnvelope(env).ok, false);
});

test('envelope: requestId correlates a response back to its request', () => {
  const req = requestEnvelope('task.list', {}, 'req_correlate_01');
  const res = responseEnvelope(req.requestId, 'task.list', { tasks: [] });
  assert.equal(res.requestId, req.requestId);
  assert.equal(validateEnvelope(res).ok, true);
});

test('envelope: request ids are unique and match the schema pattern', () => {
  const ids = new Set();
  for (let i = 0; i < 200; i++) {
    const id = newRequestId();
    assert.match(id, /^[A-Za-z0-9_-]{8,64}$/);
    ids.add(id);
  }
  assert.equal(ids.size, 200, 'generated request ids must not collide');
});

test('envelope: eventId is absent on requests and present only when supplied', () => {
  const req = requestEnvelope('task.list', {});
  assert.equal('eventId' in req, false, 'a request never carries an eventId');
  const ev = eventEnvelope('task.completed', { taskId: 'task_' + '0'.repeat(32) }, 42);
  assert.equal(ev.eventId, 42);
});

test('payload validation: a bad identifier is rejected by its schema pattern', () => {
  const bad = requestEnvelope('task.start', { projectId: 'not-an-id', prompt: 'x' });
  const r = validatePayload('task.start', 'request', bad.payload);
  assert.equal(r.ok, false);
  assert.match(r.error, /proj_/);
});

test('payload validation: a well-formed task.start payload passes', () => {
  const env = requestEnvelope('task.start', { projectId: 'proj_' + 'a'.repeat(32), prompt: 'x' });
  assert.equal(validatePayload('task.start', 'request', env.payload).ok, true);
});

test('payload validation: additional properties are rejected', () => {
  const env = requestEnvelope('task.cancel', { taskId: 'task_' + '0'.repeat(32) });
  env.payload.extra = 'nope';
  const r = validatePayload('task.cancel', 'request', env.payload);
  assert.equal(r.ok, false);
});

test('decode: oversized envelopes are rejected instead of buffered', () => {
  const huge = { protocolVersion: 1, type: 'request', timestamp: new Date().toISOString(), payload: { kind: 'task.list' }, requestId: 'req_big_000000' };
  huge.payload.padding = 'x'.repeat(2 * 1024 * 1024);
  const r = decodeEnvelope(JSON.stringify(huge));
  assert.equal(r.ok, false);
  assert.equal(r.code, PERR.INVALID_MESSAGE);
  assert.match(r.error, /exceeds/);
});

test('decode: malformed JSON is rejected as INVALID_MESSAGE', () => {
  const r = decodeEnvelope('{this is not json');
  assert.equal(r.ok, false);
  assert.equal(r.code, PERR.INVALID_MESSAGE);
});

test('decode: a valid envelope round-trips', () => {
  const env = requestEnvelope('task.list', {}, 'req_rt_000001');
  const r = decodeEnvelope(JSON.stringify(env));
  assert.equal(r.ok, true);
  assert.equal(r.envelope.requestId, 'req_rt_000001');
});

test('advertisement: only implemented operations are advertised', () => {
  // The exact serving set of the Phase 2 node. Anything absent — including
  // planned-but-unimplemented ops like session.* and task.approve — must NOT
  // be advertised (brief §7: never advertise unimplemented functionality).
  assert.deepEqual([...ADVERTISED_OPERATIONS].sort(), [
    'auth.connect', 'device.list', 'device.pair', 'device.revoke',
    'diagnostics.run', 'file.browse', 'file.read', 'file.write',
    'project.create', 'project.list', 'project.open',
    'session.replay', 'task.cancel', 'task.history', 'task.list', 'task.start',
  ]);
  for (const absent of ['session.list', 'session.create', 'session.read', 'session.resume', 'task.approve']) {
    assert.ok(!ADVERTISED_OPERATIONS.includes(absent), `"${absent}" is not implemented and must not be advertised`);
  }
});

test('payload validation: task.start without its required projectId is rejected', () => {
  const env = requestEnvelope('task.start', { prompt: 'no project' });
  const r = validatePayload('task.start', 'request', env.payload);
  assert.equal(r.ok, false);
  assert.match(r.error, /projectId/);
});

test('payload validation: file.write with a non-string content is rejected', () => {
  const env = requestEnvelope('file.write', { projectId: 'proj_' + 'a'.repeat(32), path: 'a.txt', content: 42 });
  const r = validatePayload('file.write', 'request', env.payload);
  assert.equal(r.ok, false);
});

test('payload validation: auth.connect without a signature is rejected', () => {
  const env = requestEnvelope('auth.connect', { deviceId: 'device_' + 'a'.repeat(32) });
  const r = validatePayload('auth.connect', 'request', env.payload);
  assert.equal(r.ok, false);
  assert.match(r.error, /sigB64/);
});

test('capabilities: the built object validates against capabilities.schema.json', () => {
  const caps = buildCapabilities({
    nodeId: 'node_' + '0'.repeat(32),
    platform: 'windows', architecture: 'x64',
    uhVersion: '0.3.0', dshVersion: '0.2.0-rc.2',
    operations: ADVERTISED_OPERATIONS,
  });
  const r = schemas().validateDocument('capabilities.schema.json', caps);
  assert.equal(r.ok, true, r.error);
  // pairingIdentityBinding is mandatory and constant in v1.
  assert.equal(caps.pairingIdentityBinding, true);
});

test('capabilities: every advertised operation is a declared OperationKind', () => {
  const doc = JSON.parse(readFileSync('shared/protocol/v1/capabilities.schema.json', 'utf8'));
  const allowed = new Set(doc.$defs.OperationKind.enum);
  for (const op of ADVERTISED_OPERATIONS) {
    assert.ok(allowed.has(op), `advertised operation "${op}" is not a declared OperationKind`);
  }
});

test('durability: every emitted event kind has a durability class', () => {
  for (const kind of EMITTED_EVENT_KINDS) {
    assert.ok(kind in DURABILITY, `event kind "${kind}" has no durability mapping`);
  }
});

test('durability: lifecycle kinds are durable, streaming kinds are live-only', () => {
  assert.equal(isDurable('task.completed'), true);
  assert.equal(isDurable('task.failed'), true);
  assert.equal(isDurable('task.cancelled'), true);
  assert.equal(isDurable('task.queued'), true);
  assert.equal(isDurable('task.output'), false);
  assert.equal(isDurable('task.reasoning'), false);
  assert.equal(isDurable('task.tool_started'), false);
});

test('serialization: canonical JSON is key-sorted and whitespace-free', () => {
  assert.equal(canonicalJson({ b: 1, a: { z: 2, y: 3 } }), '{"a":{"y":3,"z":2},"b":1}');
  assert.equal(canonicalJson([3, 1, 2]), '[3,1,2]');
  assert.equal(canonicalJson(null), 'null');
});

test('serialization: canonical form is stable across key orderings', () => {
  assert.equal(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }));
});

test('serialization: sha256Hex of an object uses the canonical form', () => {
  assert.equal(sha256Hex({ a: 1, b: 2 }), sha256Hex({ b: 2, a: 1 }));
  assert.match(sha256Hex('hello'), /^[0-9a-f]{64}$/);
});

test('errors: an error envelope never carries a raw secret in detail', () => {
  const env = errorEnvelope('req_x', PERR.INTERNAL_ERROR, 'boom', {
    detail: 'token=sk-' + 'a'.repeat(40),
  });
  assert.equal(env.payload.detail, '[REDACTED]');
  assert.equal(env.payload.retryable, false);
  assert.equal(env.type, 'error');
});

test('errors: the error payload shape matches errors.schema.json', () => {
  const env = errorEnvelope('req_y', PERR.NOT_FOUND, 'missing', { detail: 'safe text' });
  const r = schemas().validateDef('errors.schema.json', 'ErrorPayload', env.payload);
  assert.equal(r.ok, true, r.error);
});

test('kinds: the wire kind set is non-empty and stable', () => {
  assert.ok(Object.keys(KINDS).length >= 20);
  assert.equal(KINDS.TASK_START, 'task.start');
  assert.equal(KINDS.AUTH_CONNECT, 'auth.connect');
});
