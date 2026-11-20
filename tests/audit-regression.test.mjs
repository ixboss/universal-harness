// Regression tests for the 2026-11-19 audit round. Each test fails on the
// pre-fix code: corrupt state files silently wiping data, compaction dropping
// a task entirely, and backup restore writing outside the workspace root.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { createAuthStore } from '../core/auth/mod.mjs';
import { portablePaths } from '../core/paths/mod.mjs';
import { loadOrCreateNodeIdentity } from '../core/identity/mod.mjs';
import { createBackup, verifyBackup, restoreBackup } from '../core/backup/mod.mjs';
import { sha256Bytes } from '../core/integrity/mod.mjs';
import { newDeviceKey } from './fixtures/stack.mjs';

const logShim = () => ({ info() {}, warn() {}, debug() {}, error() {} });

test('auth: a corrupt devices file fails loudly instead of silently resetting', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uh-auth-corrupt-'));
  try {
    const p = { ...portablePaths(root), device: path.join(root, 'device-local') };
    const identity = await loadOrCreateNodeIdentity({ p });
    const auth = createAuthStore({ p, identity });
    const devicesPath = path.join(p.device, 'devices.json');
    fs.writeFileSync(devicesPath, '{ "devices": [ broken');

    assert.throws(() => auth.listDevices(), (e) => /corrupt/.test(e.message),
      'reading a corrupt devices file throws a clear error');

    // And pairing on top of a corrupt file must not persist a fresh list that
    // silently wipes every other record.
    const pairing = auth.mintPairingPayload({ endpoint: 'memory://test' });
    const key = newDeviceKey();
    const challenge = auth.newChallenge();
    assert.throws(() => auth.pair({
      deviceName: 'phone', platform: 'android', devicePublicKeyPem: key.publicKeyPem,
      token: pairing.token, expectedNodeIdentitySha256: pairing.nodeIdentitySha256,
      sigB64: key.sign(challenge), challenge, requestedScopes: ['read-only'],
    }), (e) => /corrupt/.test(e.message));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('events: compaction anchors a task whose newest record fell out of the tail', async () => {
  const { createEventStore } = await import('../core/events/mod.mjs');
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'uh-compact-'));
  try {
    const p = portablePaths(root);
    const events = createEventStore({ p, log: logShim() });
    const sessionId = `sess_${'a'.repeat(32)}`;
    const taskA = `task_${'0'.repeat(32)}`;
    const appendTask = (taskId, state) => events.append({
      event: { kind: state === 'completed' ? 'task.completed' : 'task.queued', taskId, sessionId, state },
      task: { taskId, projectId: null, sessionId, state, createdAt: 'now', updatedAt: 'now', lastEventId: 0, prompt: 'p', priority: 'normal' },
    });
    appendTask(taskA, 'completed');
    for (let i = 1; i <= 40; i++) appendTask(`task_${String(i).padStart(32, '0')}`, 'queued');

    // Reopening with a small retention window triggers startup compaction:
    // 41 records > maxEvents 20, keepEvents 10 — task A's newest record falls
    // far outside the tail.
    const reopened = createEventStore({ p, maxEvents: 20, log: logShim() });
    const rec = reopened.taskRecord(taskA);
    assert.ok(rec, 'task A survives compaction');
    assert.equal(rec.state, 'completed', 'and with its terminal state');
  } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
});

test('backup: restore refuses a tampered manifest path that escapes the root', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'uh-restore-'));
  try {
    fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(root, 'bin', 'uh.mjs'), '// marker\n');
    const p = {
      data: path.join(root, 'data'),
      projects: path.join(root, 'data', 'projects'),
      workspace: path.join(root, 'data', 'workspace'),
      config: path.join(root, 'data', 'config'),
      backups: path.join(root, 'data', 'backups'),
      sessions: path.join(root, 'data', 'sessions'),
    };
    fs.mkdirSync(p.workspace, { recursive: true });
    fs.writeFileSync(path.join(p.workspace, 'registry.json'), JSON.stringify({ schemaVersion: 1, workspaceId: 'w', projects: [] }));

    const created = await createBackup({ root, p, label: 'escape', log: logShim() });
    const manifestPath = path.join(p.backups, created.ref, 'manifest.json');
    const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    m.entries = m.entries.map((e) => (e.from === 'data/workspace/registry.json'
      ? { ...e, from: '../uh-escape/registry.json' } : e));
    // Recompute the checksum so ONLY the path check stands between the tampered
    // manifest and the filesystem.
    m.checksum = sha256Bytes(JSON.stringify(m.entries));
    fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2));

    await assert.rejects(() => restoreBackup({ root, p, ref: created.ref, log: logShim() }),
      (e) => e.code === 'PATH_UNSAFE');
    assert.ok(!fs.existsSync(path.resolve(root, '..', 'uh-escape')),
      'nothing was written outside the workspace root');
  } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
});
