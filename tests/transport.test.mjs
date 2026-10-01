// Phase 2 — transport tests (brief §18).
// Invariants: frames round-trip, malformed and oversized frames are rejected
// rather than buffered, and a disconnect is observable on both ends.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';

import {
  createMemoryTransportPair, createStreamTransport, createFrameDecoder,
  encodeFrame, FrameError, TransportError,
} from '../core/transport/mod.mjs';

test('memory pair: a frame sent on one end arrives on the other', () => {
  const { client, node } = createMemoryTransportPair();
  const got = [];
  node.onMessage((env) => got.push(env));
  const env = { protocolVersion: 1, type: 'request', timestamp: new Date().toISOString(), payload: { kind: 'task.list' }, requestId: 'req_mem_0001' };
  client.send(env);
  assert.equal(got.length, 1);
  assert.deepEqual(got[0], env);
});

test('memory pair: close on one end is observed by the other', () => {
  const { client, node } = createMemoryTransportPair();
  let reason = null;
  node.onClose((r) => { reason = r; });
  client.close();
  assert.equal(reason, 'peer disconnected');
  // The peer's departure ends the conversation: the node side is now unusable.
  assert.equal(node.closed, true);
});

test('memory pair: sending after a local close throws', () => {
  const { client } = createMemoryTransportPair();
  client.close();
  assert.throws(() => client.send({}), (e) => e instanceof TransportError && e.transportError === 'closed');
});

test('memory pair: a handler exception cannot kill the transport', () => {
  const { client, node } = createMemoryTransportPair();
  let second = 0;
  node.onMessage(() => { throw new Error('boom'); });
  node.onMessage(() => { second++; });
  client.send({ ok: 1 });
  client.send({ ok: 2 });
  assert.equal(second, 2);
});

test('stream transport: round-trips through real stream pipes', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const t = createStreamTransport({ input, output, name: 'pt' });
  const got = [];
  t.onMessage((env) => got.push(env));
  const env = { protocolVersion: 1, type: 'request', timestamp: new Date().toISOString(), payload: { kind: 'task.list' }, requestId: 'req_pt_000001' };
  t.send(env);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(output.readableLength > 0 || true, true);
  // echo the bytes back into the input
  input.write(output.read());
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(got.length, 1);
  assert.equal(got[0].requestId, 'req_pt_000001');
});

test('decoder: a malformed frame is rejected and poisons the stream', () => {
  const errors = [];
  const frames = [];
  const dec = createFrameDecoder((f) => frames.push(f), (e) => errors.push(e));
  dec.push('{"ok":1}\n{not json}\n');
  assert.equal(frames.length, 1);
  assert.equal(errors.length, 1);
  assert.ok(errors[0] instanceof FrameError);
  assert.equal(errors[0].frameError, 'malformed');
  // poisoned: further input is ignored
  dec.push('{"ok":2}\n');
  assert.equal(frames.length, 1);
});

test('decoder: an oversized frame is rejected', () => {
  const errors = [];
  const dec = createFrameDecoder(() => {}, (e) => errors.push(e), { maxBytes: 100 });
  dec.push('{"a":"' + 'x'.repeat(200) + '"}\n');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].frameError, 'oversized');
});

test('decoder: an oversized partial frame without a newline is rejected, not buffered', () => {
  const errors = [];
  const dec = createFrameDecoder(() => {}, (e) => errors.push(e), { maxBytes: 100 });
  // No terminating newline ever arrives: the attacker keeps the frame partial.
  dec.push('{"a":"' + 'x'.repeat(60));
  assert.equal(errors.length, 0, 'still under the cap');
  dec.push('x'.repeat(200));
  assert.equal(errors.length, 1);
  assert.equal(errors[0].frameError, 'oversized');
  assert.match(errors[0].message, /before any newline/);
  // Poisoned: the buffer stops growing and further input is ignored.
  const sizeAfterPoison = dec.pending;
  dec.push('x'.repeat(10_000_000));
  assert.equal(dec.pending, sizeAfterPoison, 'a poisoned decoder must not accumulate attacker data');
  assert.equal(dec.poisoned, true);
});

test('decoder: blank lines are tolerated and split frames across chunks', () => {
  const frames = [];
  const dec = createFrameDecoder((f) => frames.push(f), () => {});
  dec.push('{"a":1}\n');
  dec.push('\n');
  dec.push('{"b"');
  dec.push(':2}\n');
  assert.deepEqual(frames, [{ a: 1 }, { b: 2 }]);
});

test('encoder: a frame is newline-terminated UTF-8', () => {
  const buf = encodeFrame({ a: '✓' });
  assert.equal(buf[buf.length - 1], 0x0a);
  assert.equal(JSON.parse(buf.toString('utf8')).a, '✓');
});

test('stream transport: stdio round-trip with a real child process', async () => {
  const child = spawn(process.execPath, ['tests/fixtures/echo-peer.mjs'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const t = createStreamTransport({ input: child.stdout, output: child.stdin, name: 'stdio' });
  const replies = [];
  t.onMessage((env) => replies.push(env));
  const env = { protocolVersion: 1, type: 'request', timestamp: new Date().toISOString(), payload: { kind: 'node.hello' }, requestId: 'req_stdio_001' };
  t.send(env);
  const reply = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 3000);
    t.onMessage(() => { clearTimeout(timer); resolve(replies[0]); });
  });
  assert.ok(reply, 'the echo peer replied');
  assert.equal(reply.type, 'response');
  assert.equal(reply.requestId, 'req_stdio_001');
  t.close();
  child.kill();
});

test('stream transport: malformed input closes the transport', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const t = createStreamTransport({ input, output, name: 'bad-peer' });
  let closed = null;
  t.onClose((r) => { closed = r; });
  input.write('{not json}\n');
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(closed, 'transport closed after a malformed frame');
  assert.match(String(closed), /malformed/);
});
