// Phase 5 S2 — workspace export: a versioned, self-describing, checksummed
// *directory* bundle. These tests assert the manifest contract and, above all,
// the inclusion/exclusion rules: nothing device-local, secret, regenerable or
// node-owned may ever travel.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sha256Bytes } from '../core/integrity/mod.mjs';
import {
  exportWorkspace, buildBundleManifest, BUNDLE_KIND, BUNDLE_VERSION, BUNDLE_MANIFEST,
} from '../core/bundle/mod.mjs';

const log = () => ({ info() {}, warn() {}, error() {}, debug() {} });

function w(root, rel, data) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, data);
}

async function makeRoot() {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'uh-bundle-'));
  w(root, 'data/workspace/.workspace.json', JSON.stringify({ id: 'ws-1', label: 'drive', createdAt: 1 }));
  w(root, 'data/workspace/registry.json', JSON.stringify({ schemaVersion: 1, workspaceId: 'ws-1', recordedRoot: root, projects: [], updatedAt: 1 }));
  w(root, 'data/config/config.json', JSON.stringify({ theme: 'dark' }));
  w(root, 'data/sessions/index.json', JSON.stringify({ sessions: [] }));
  w(root, 'data/migration/abc.json', JSON.stringify({ from: 'x', to: 'y' }));
  w(root, 'data/projects/p1/.uh-project.json', JSON.stringify({ id: 'p1', name: 'P1' }));
  w(root, 'data/projects/p1/src/main.js', 'console.log(1)');
  // Must never travel:
  w(root, 'data/logs/app.log', 'noise');
  w(root, 'diagnostics/doctor.json', '{}');
  w(root, 'runtime/node/placeholder', 'binary');
  w(root, 'data/state/events/durable.ndjson', '{"e":1}');
  w(root, 'data/backups/b1/manifest.json', '{}');
  w(root, 'data/config/config.secure.json', '{"secret":"value"}');
  return root;
}

const rm = (dir) => fs.promises.rm(dir, { recursive: true, force: true });

test('export: writes a versioned, self-describing, checksummed bundle', async () => {
  const root = await makeRoot();
  const out = path.join(os.tmpdir(), `uh-bundle-out-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try {
    const { manifest } = await exportWorkspace({ root, outDir: out, log: log() });
    assert.equal(manifest.kind, BUNDLE_KIND);
    assert.equal(manifest.bundleVersion, BUNDLE_VERSION);
    assert.equal(manifest.source.recordedRoot, null, 'no absolute root travels in the manifest');
    assert.ok(Array.isArray(manifest.entries) && manifest.entries.length > 0);
    assert.equal(manifest.entriesChecksum, sha256Bytes(JSON.stringify(manifest.entries)));
    // The manifest is on disk and parses.
    const onDisk = JSON.parse(fs.readFileSync(path.join(out, BUNDLE_MANIFEST), 'utf8'));
    assert.equal(onDisk.entriesChecksum, manifest.entriesChecksum);
    // Every listed entry exists on disk with the declared size.
    for (const e of onDisk.entries) {
      const abs = path.join(out, e.path);
      assert.equal(fs.existsSync(abs), true, `missing ${e.path}`);
      assert.equal(fs.statSync(abs).size, e.bytes, `size mismatch ${e.path}`);
    }
  } finally { await rm(root); await rm(out); }
});

test('export: never carries device-local, secret, log, runtime, state or backup paths', async () => {
  const root = await makeRoot();
  const out = path.join(os.tmpdir(), `uh-bundle-out-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const forbidden = [
    'data/logs/', 'diagnostics/', 'runtime/', 'data/state/', 'data/backups/',
    'data/config/config.secure.json',
  ];
  try {
    const { manifest } = await exportWorkspace({ root, outDir: out, log: log() });
    for (const e of manifest.entries) {
      assert.equal(forbidden.some((f) => e.path.startsWith(f) || e.path === f), false,
        `forbidden path travelled: ${e.path}`);
    }
    // And nothing on disk under the bundle carries them either.
    const seen = [];
    (function walk(dir) {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(abs);
        else seen.push(path.relative(out, abs).split(path.sep).join('/'));
      }
    })(out);
    for (const rel of seen) {
      if (rel === BUNDLE_MANIFEST) continue;
      assert.equal(forbidden.some((f) => rel.startsWith(f) || rel === f), false, `forbidden file in bundle: ${rel}`);
    }
  } finally { await rm(root); await rm(out); }
});

test('export: the recorded root is neutralised (an absolute path never travels)', async () => {
  const root = await makeRoot();
  const out = path.join(os.tmpdir(), `uh-bundle-out-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try {
    await exportWorkspace({ root, outDir: out, log: log() });
    const reg = JSON.parse(fs.readFileSync(path.join(out, 'data', 'workspace', 'registry.json'), 'utf8'));
    assert.equal(reg.recordedRoot, null);
    assert.equal(fs.readFileSync(path.join(out, 'data', 'workspace', 'registry.json'), 'utf8').includes(root), false,
      'the source root must not appear anywhere in the exported registry');
  } finally { await rm(root); await rm(out); }
});

test('export: project source trees travel only with --include-projects', async () => {
  const root = await makeRoot();
  const a = path.join(os.tmpdir(), `uh-bundle-a-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const b = path.join(os.tmpdir(), `uh-bundle-b-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try {
    const meta = await exportWorkspace({ root, outDir: a, log: log() });
    assert.equal(meta.manifest.entries.some((e) => e.path.startsWith('data/projects/p1/src/')), false);
    assert.equal(meta.manifest.entries.some((e) => e.path === 'data/projects/p1/.uh-project.json'), true, 'the marker still travels');

    const full = await exportWorkspace({ root, outDir: b, includeProjects: true, log: log() });
    assert.equal(full.manifest.entries.some((e) => e.path === 'data/projects/p1/src/main.js'), true);
  } finally { await rm(root); await rm(a); await rm(b); }
});

test('export: refuses to overwrite an existing path without --force', async () => {
  const root = await makeRoot();
  const out = path.join(os.tmpdir(), `uh-bundle-out-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try {
    await exportWorkspace({ root, outDir: out, log: log() });
    await assert.rejects(
      () => exportWorkspace({ root, outDir: out, log: log() }),
      (e) => e.code === 'BUNDLE_INVALID',
    );
    // --force replaces it.
    const again = await exportWorkspace({ root, outDir: out, force: true, log: log() });
    assert.equal(again.manifest.bundleVersion, BUNDLE_VERSION);
  } finally { await rm(root); await rm(out); }
});

test('export: a symlink inside a project tree is refused, never silently followed', async () => {
  const root = await makeRoot();
  const out = path.join(os.tmpdir(), `uh-bundle-out-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const linkPath = path.join(root, 'data', 'projects', 'p1', 'link');
  let linked = false;
  try {
    try { fs.symlinkSync(path.join(root, 'data', 'config'), linkPath, process.platform === 'win32' ? 'junction' : 'dir'); linked = true; }
    catch { linked = false; }
    if (!linked) return; // no symlink privilege on this host — the rule is still exercised on POSIX
    await assert.rejects(
      () => exportWorkspace({ root, outDir: out, includeProjects: true, log: log() }),
      (e) => e.code === 'BUNDLE_INVALID',
    );
  } finally { await rm(root); await rm(out); }
});

test('export: buildBundleManifest is read-only and stable', async () => {
  const root = await makeRoot();
  try {
    const before = JSON.stringify(fs.readdirSync(path.join(root, 'data')));
    const { manifest, bytesByPath } = await buildBundleManifest({ root });
    const after = JSON.stringify(fs.readdirSync(path.join(root, 'data')));
    assert.equal(before, after, 'building a manifest must not mutate the workspace');
    assert.equal(bytesByPath.size, manifest.entries.length);
    const second = await buildBundleManifest({ root });
    assert.deepEqual(second.manifest.entries, manifest.entries, 'entries are deterministic');
  } finally { await rm(root); }
});
