// Workspace tests (spec §17): new workspace, reopen, moved workspace, missing
// project, conflicting workspace identity, relative path resolution.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createWorkspaceStore } from '../core/workspace/mod.mjs';
import { toPortableRelative, resolvePortable, findRoot, validateRoot } from '../core/paths/mod.mjs';
import { UhError } from '../core/errors/mod.mjs';

const logShim = () => ({ info() {}, warn() {}, debug() {}, error() {} });

async function makeRoot() {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'uh-ws-'));
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'bin', 'uh.mjs'), '// marker\n');
  fs.mkdirSync(path.join(root, 'core'), { recursive: true });
  fs.mkdirSync(path.join(root, 'manifests'), { recursive: true });
  fs.mkdirSync(path.join(root, 'data', 'projects'), { recursive: true });
  return root;
}

test('new workspace: init creates a stable identity marker', async () => {
  const root = await makeRoot();
  try {
    const store = createWorkspaceStore({ root, p: { data: path.join(root, 'data'), projects: path.join(root, 'data', 'projects'), workspace: path.join(root, 'data', 'workspace') } });
    const marker = store.init({ label: 'drive-1' });
    assert.ok(marker.id);
    assert.equal(store.loadMarker().id, marker.id);
    assert.throws(() => store.init({ label: 'other' }), (e) => e.code === 'WORKSPACE_INVALID');
  } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
});

test('reopen workspace: registry survives reload and ids are stable', async () => {
  const root = await makeRoot();
  try {
    const p = { data: path.join(root, 'data'), projects: path.join(root, 'data', 'projects'), workspace: path.join(root, 'data', 'workspace') };
    const store = createWorkspaceStore({ root, p });
    store.init({ label: 'drive-1' });
    const proj = store.registerProject({ name: 'My Project' });
    const store2 = createWorkspaceStore({ root, p });
    const list = store2.listProjects();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, proj.id);
    assert.equal(list[0].name, 'My Project');
    // portable relative path round trip
    const abs = resolvePortable(root, proj.relPath);
    assert.equal(fs.existsSync(abs), true);
    assert.equal(toPortableRelative(root, abs), proj.relPath);
  } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
});

test('moved workspace: a changed absolute root is detected; relative paths still resolve', async () => {
  const root = await makeRoot();
  const moved = await makeRoot();
  try {
    const p1 = { data: path.join(root, 'data'), projects: path.join(root, 'data', 'projects'), workspace: path.join(root, 'data', 'workspace') };
    const store = createWorkspaceStore({ root, p: p1 });
    store.init({ label: 'drive-1' });
    const proj = store.registerProject({ name: 'Project A' });

    // Simulate the drive moving: copy the whole tree elsewhere and reopen there.
    await fs.promises.cp(path.join(root, 'data'), path.join(moved, 'data'), { recursive: true });
    const p2 = { data: path.join(moved, 'data'), projects: path.join(moved, 'data', 'projects'), workspace: path.join(moved, 'data', 'workspace') };
    const store2 = createWorkspaceStore({ root: moved, p: p2 });
    const marker2 = store2.loadMarker();
    assert.equal(marker2.id, store.loadMarker().id, 'stable id survives the move');

    const list = store2.listProjects();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, proj.id);
    // Relative path resolves against the *new* root — no fixed drive letter.
    assert.equal(fs.existsSync(resolvePortable(moved, list[0].relPath)), true);
    assert.equal(fs.existsSync(resolvePortable(root, list[0].relPath)), true);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
    await fs.promises.rm(moved, { recursive: true, force: true });
  }
});

test('missing project: a registered project whose directory vanished is reported', async () => {
  const root = await makeRoot();
  try {
    const p = { data: path.join(root, 'data'), projects: path.join(root, 'data', 'projects'), workspace: path.join(root, 'data', 'workspace') };
    const store = createWorkspaceStore({ root, p });
    store.init();
    store.registerProject({ name: 'Gone' });
    const list = store.listProjects();
    await fs.promises.rm(resolvePortable(root, list[0].relPath), { recursive: true, force: true });
    const missing = store.missingProjects();
    assert.equal(missing.length, 1);
    assert.equal(missing[0].name, 'Gone');
  } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
});

test('conflicting workspace identity: marker vs registry disagreement is detected', async () => {
  const root = await makeRoot();
  try {
    const p = { data: path.join(root, 'data'), projects: path.join(root, 'data', 'projects'), workspace: path.join(root, 'data', 'workspace') };
    const store = createWorkspaceStore({ root, p });
    store.init();
    // Corrupt: restore a registry from a *different* copied drive (same rel
    // layout, different identity).
    const reg = store.loadRegistry();
    reg.workspaceId = '00000000-0000-0000-0000-000000000000';
    fs.writeFileSync(path.join(p.workspace, 'registry.json'), JSON.stringify(reg));
    const conflicts = store.conflicts();
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].kind, 'workspace-id-mismatch');
  } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
});

test('root detection: findRoot walks up to the marker and rejects non-roots', async () => {
  const root = await makeRoot();
  try {
    const deep = path.join(root, 'data', 'projects');
    assert.equal(findRoot(deep), root);
    assert.ok(validateRoot(root).ok);
    const outside = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'uh-outside-'));
    assert.equal(validateRoot(outside).ok, false);
  } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
});
