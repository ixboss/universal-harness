// Migration + backup/restore tests (spec §17): Windows path change, Linux path
// change, portable-drive move, conflict detection, rollback/recovery.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createWorkspaceStore } from '../core/workspace/mod.mjs';
import { checkMove, applyMigration, validateMigration, migrationHistory } from '../core/migration/mod.mjs';
import { createBackup, verifyBackup, restoreBackup, listBackups } from '../core/backup/mod.mjs';
import { UhError, ERR } from '../core/errors/mod.mjs';

const logShim = () => ({ info() {}, warn() {}, debug() {}, error() {} });

async function makeRoot({ withRegistry = true } = {}) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'uh-mig-'));
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'bin', 'uh.mjs'), '// marker\n');
  fs.mkdirSync(path.join(root, 'core'), { recursive: true });
  fs.mkdirSync(path.join(root, 'manifests'), { recursive: true });
  const p = {
    data: path.join(root, 'data'),
    projects: path.join(root, 'data', 'projects'),
    workspace: path.join(root, 'data', 'workspace'),
    config: path.join(root, 'data', 'config'),
    backups: path.join(root, 'data', 'backups'),
    sessions: path.join(root, 'data', 'sessions'),
  };
  fs.mkdirSync(p.projects, { recursive: true });
  fs.mkdirSync(p.config, { recursive: true });
  const store = createWorkspaceStore({ root, p });
  if (withRegistry) {
    store.init({ label: 'drive-1' });
    // Materialize the registry file (it is written lazily on first save).
    fs.writeFileSync(path.join(p.config, 'config.json'), JSON.stringify({ workspace: { defaultLabel: 'mine' } }));
    store.save(store.loadRegistry());
  }
  return { root, p, store };
}

async function moveTo(root, destBase) {
  const dest = await fs.promises.mkdtemp(path.join(destBase, 'uh-moved-'));
  await fs.promises.rm(dest, { recursive: true, force: true });
  await fs.promises.cp(root, dest, { recursive: true });
  return dest;
}

test('path change detection: a Windows-style and a POSIX-style move are both detected', async () => {
  const { root, p, store } = await makeRoot();
  try {
    assert.equal(checkMove(store).moved, false); // registry records the current root

    // Simulate D:\ -> E:\ style move by rewriting recordedRoot like a copy to
    // another drive would, then reopening the copied tree there.
    const movedRoot = await moveTo(root, os.tmpdir());
    const movedP = { ...p, data: path.join(movedRoot, 'data'), workspace: path.join(movedRoot, 'data', 'workspace') };
    const movedStore = createWorkspaceStore({ root: movedRoot, p: movedP });
    const reg = movedStore.loadRegistry();
    reg.recordedRoot = process.platform === 'win32' ? 'D:\\UniversalHarness' : '/srv/UniversalHarness';
    fs.writeFileSync(path.join(movedP.workspace, 'registry.json'), JSON.stringify(reg));

    const check = checkMove(movedStore, { root: movedRoot });
    assert.equal(check.moved, true);
    assert.equal(check.from, process.platform === 'win32' ? 'D:\\UniversalHarness' : '/srv/UniversalHarness');
    await fs.promises.rm(movedRoot, { recursive: true, force: true });
  } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
});

test('applyMigration: backs up metadata first, preserves stable ids, writes history', async () => {
  const { root, p, store } = await makeRoot();
  try {
    const before = store.loadMarker().id;
    // Force a "moved" state.
    const reg = store.loadRegistry();
    reg.recordedRoot = process.platform === 'win32' ? 'D:\\OldRoot' : '/srv/old-root';
    fs.writeFileSync(path.join(p.workspace, 'registry.json'), JSON.stringify(reg));

    const result = await applyMigration({ store, root, p, log: logShim() });
    assert.equal(result.moved, true);
    assert.equal(store.loadMarker().id, before, 'stable identity preserved');
    assert.equal(store.loadRegistry().recordedRoot, path.resolve(root));

    const hist = migrationHistory({ p });
    assert.equal(hist.length, 1);
    assert.equal(hist[0].backupRef, result.backupRef);

    const backups = listBackups({ root, p });
    assert.equal(backups.length, 1);
  } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
});

test('conflict detection: an identity conflict blocks migration', async () => {
  const { root, p, store } = await makeRoot();
  try {
    const reg = store.loadRegistry();
    reg.workspaceId = '00000000-0000-0000-0000-000000000000'; // mismatch the marker
    fs.writeFileSync(path.join(p.workspace, 'registry.json'), JSON.stringify(reg));
    reg.recordedRoot = process.platform === 'win32' ? 'D:\\OldRoot' : '/srv/old-root';
    fs.writeFileSync(path.join(p.workspace, 'registry.json'), JSON.stringify(reg));

    const validation = validateMigration(store, { to: root });
    assert.equal(validation.ok, false);
    assert.ok(validation.problems.some((x) => x.includes('identity conflict')));
    await assert.rejects(() => applyMigration({ store, root, p, log: logShim() }), (e) => e.code === ERR.MIGRATION_REFUSED);
  } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
});

test('rollback/recovery: a backup restores registry and config with verified hashes', async () => {
  const { root, p } = await makeRoot();
  try {
    const created = await createBackup({ root, p, label: 'base', log: logShim() });
    assert.ok(created.files.includes('workspace/registry.json'));

    const v = await verifyBackup({ root, p, ref: created.ref });
    assert.equal(v.ok, true);

    // Simulate damage: delete the registry, then restore.
    fs.rmSync(path.join(p.workspace, 'registry.json'));
    const restored = await restoreBackup({ root, p, ref: created.ref, log: logShim() });
    assert.ok(restored.restored.includes('data/workspace/registry.json'));
    assert.ok(fs.existsSync(path.join(p.workspace, 'registry.json')));

    // Corrupt the backup: verification must fail and restore must refuse.
    const backupDir = listBackups({ root, p })[0].ref;
    const regInBackup = path.join(p.backups, backupDir, 'workspace', 'registry.json');
    fs.appendFileSync(regInBackup, 'corrupted');
    const corrupted = await verifyBackup({ root, p, ref: backupDir });
    assert.equal(corrupted.ok, false);
    await assert.rejects(() => restoreBackup({ root, p, ref: backupDir, log: logShim() }), (e) => e.code === ERR.BACKUP_INVALID);
  } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
});

test('restore refuses to overwrite newer state, unless forced', async () => {
  const { root, p } = await makeRoot();
  try {
    const created = await createBackup({ root, p, label: 'old', log: logShim() });
    // Live metadata is newer than the backup.
    await new Promise((r) => setTimeout(r, 20));
    fs.utimesSync(path.join(p.workspace, 'registry.json'), Date.now() / 1000, Date.now() / 1000 + 60);
    await assert.rejects(() => restoreBackup({ root, p, ref: created.ref, log: logShim() }), (e) => e.code === ERR.BACKUP_CONFLICT);
    const forced = await restoreBackup({ root, p, ref: created.ref, force: true, log: logShim() });
    assert.ok(forced.restored.length > 0);
  } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
});
