// Session tests (spec §17): discover, reopen/replay, incomplete-session
// detection — exercised against synthetic dsh session logs in both storage
// formats the real runtime uses (plain JSONL and concatenated zstd frames).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createSessionStore, createSessionIndex } from '../core/sessions/mod.mjs';

const CWD = process.platform === 'win32' ? 'C:\\proj\\demo' : '/home/user/proj/demo';

function makeEvents({ complete = true, count = 8 } = {}) {
  const events = [
    { type: 'session', version: 4, id: 'demo-session', createdAt: 1790000000000, cwd: CWD, isSeeded: false },
    { type: 'permission/preset', seq: 0, data: { preset: 'workspace-write' } },
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'user/message', seq: 2, data: {} },
    { type: 'assistant/attempt', seq: 3, data: {} },
    { type: 'step/end', seq: 4, data: {} },
  ];
  if (complete) events.push({ type: 'turn/end', seq: 5, data: { turn: 1, reason: { kind: 'completed' } } });
  if (count > events.length) events.push(...Array.from({ length: count - events.length }, (_, i) => ({ type: 'noop', seq: 6 + i, data: {} })));
  return events;
}

async function buildStore({ complete = true, compressed = true } = {}) {
  const dshHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'uh-dsh-'));
  const wsMangled = '--mangled-demo-workspace--';
  const sessionDir = path.join(dshHome, 'sessions', wsMangled, 'demo-session');
  fs.mkdirSync(sessionDir, { recursive: true });
  const events = makeEvents({ complete });
  const jsonl = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  const file = path.join(sessionDir, compressed ? 'session.v4.jsonl.zstd' : 'session.v4.jsonl');
  if (compressed) {
    // Two concatenated frames, like the real runtime: header alone, then body.
    const { zstdCompressSync } = await import('node:zlib');
    const header = JSON.stringify(events[0]) + '\n';
    const body = events.slice(1).map((e) => JSON.stringify(e)).join('\n') + '\n';
    fs.writeFileSync(file, Buffer.concat([zstdCompressSync(Buffer.from(header)), zstdCompressSync(Buffer.from(body))]));
  } else {
    fs.writeFileSync(file, jsonl);
  }
  return { dshHome, store: createSessionStore({ dshHome }), file };
}

test('discover: sessions are indexed by their authoritative header cwd', async () => {
  const { store } = await buildStore();
  const all = store.list();
  assert.equal(all.length, 1);
  assert.equal(all[0].id, 'demo-session');
  assert.equal(all[0].cwd, CWD);
  assert.equal(all[0].formatVersion, 4);
  const scoped = store.list({ cwd: CWD });
  assert.equal(scoped.length, 1);
  assert.equal(store.list({ cwd: '/somewhere/else' }).length, 0);
});

test('discover: works for uncompressed JSONL too', async () => {
  const { store } = await buildStore({ compressed: false });
  assert.equal(store.list().length, 1);
});

test('replay: events return in seq order with the header excluded', async () => {
  const { store } = await buildStore();
  const events = store.replay('demo-session');
  assert.ok(events.every((e) => e.type !== 'session'));
  const seqs = events.map((e) => e.seq);
  assert.deepEqual([...seqs].sort((a, b) => a - b), seqs);
  assert.ok(events.some((e) => e.type === 'turn/end'));
});

test('incomplete detection: a turn that never ended is flagged', async () => {
  const complete = await buildStore({ complete: true });
  const broken = await buildStore({ complete: false });
  assert.equal(complete.store.list()[0].incomplete, false);
  assert.equal(broken.store.list()[0].incomplete, true);
});

test('forWorkspace: sessions under a workspace root are matched', async () => {
  const { store } = await buildStore();
  const parent = process.platform === 'win32' ? 'C:\\proj' : '/home/user/proj';
  assert.equal(store.forWorkspace(parent).length, 1);
  assert.equal(store.forWorkspace(process.platform === 'win32' ? 'C:\\other' : '/other').length, 0);
});

test('UH session index: lineage records survive reload', async () => {
  const data = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'uh-idx-'));
  try {
    const index = createSessionIndex({ p: { data } });
    index.record({ id: 's1', label: 'first', status: 'open' });
    index.record({ id: 's2', priorSessionId: 's1', status: 'open' });
    const reloaded = createSessionIndex({ p: { data } });
    assert.equal(reloaded.list().length, 2);
    assert.equal(reloaded.get('s2').priorSessionId, 's1');
    assert.equal(reloaded.get('s1').label, 'first');
  } finally { await fs.promises.rm(data, { recursive: true, force: true }); }
});
