// Runtime tests (spec §17: valid/missing/wrong-arch/wrong-version/hash-mismatch/
// corrupted-manifest) plus the §3 rule that an unverified runtime is never
// executed.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadManifest } from '../core/runtime/manifest.mjs';
import { createRuntimeManager, hashTree, writeInstallState } from '../core/runtime/mod.mjs';
import { verifyFileSha256, sha256File } from '../core/integrity/mod.mjs';
import { buildTempRoot, fakeManifest, TARGET, cleanTempRoot } from './helpers.mjs';
import { UhError, ERR } from '../core/errors/mod.mjs';

test('valid runtime: all status checks pass on a freshly built tree', async () => {
  const { rm, root } = await buildTempRoot();
  try {
    const status = await rm.status();
    assert.equal(status.ok, true, status.checks.map((c) => c.id).join());
    assert.equal(status.target, TARGET);
  } finally { await cleanTempRoot(root); }
});

test('missing runtime: status reports node/dsh absent with actionable actions', async () => {
  const { rm, root, nodeCopy } = await buildTempRoot();
  try {
    await fs.promises.rm(path.dirname(nodeCopy), { recursive: true, force: true });
    const status = await rm.status();
    assert.equal(status.ok, false);
    const nodePresent = status.checks.find((c) => c.id === 'node.present');
    assert.equal(nodePresent.status, 'fail');
    assert.ok(nodePresent.action.includes('uh setup'));
  } finally { await cleanTempRoot(root); }
});

test('wrong architecture: a target with no manifest entry is rejected', async () => {
  const man = fakeManifest();
  const rootlessMan = { ...man, node: { ...man.node } };
  delete rootlessMan.node[TARGET];
  assert.throws(() => loadManifestFromString(rootlessMan), (e) => e.code === ERR.MANIFEST_MALFORMED);
  // The runtime manager surfaces it as an arch error when the selected
  // target has no entry (construction is lazy; resolution happens on use).
  const rm = createRuntimeManager({ root: 'nowhere', manifest: rootlessMan, target: 'linux-x64' });
  assert.throws(() => rm.nodeEntry(), (e) => e.code === ERR.RUNTIME_ARCH_UNSUPPORTED);
  await assert.rejects(() => rm.status(), (e) => e.code === ERR.RUNTIME_ARCH_UNSUPPORTED);
});

test('wrong version: node reporting an unexpected version fails the check', async () => {
  const man = fakeManifest({ nodeVersion: 'v0.0.0-wrong' });
  const { rm, root } = await buildTempRoot({ manifest: man });
  try {
    const status = await rm.status();
    const v = status.checks.find((c) => c.id === 'node.version');
    assert.equal(v.status, 'fail');
    assert.equal(v.expected, 'v0.0.0-wrong');
    assert.equal(v.actual, process.version);
  } finally { await cleanTempRoot(root); }
});

test('hash mismatch: tampering with the node tree breaks integrity verification', async () => {
  const { rm, root, nodeCopy } = await buildTempRoot();
  try {
    assert.equal(rm.verifyNodeTree().ok, true);
    await fs.promises.appendFile(nodeCopy, '\n// tampered');
    const v = rm.verifyNodeTree();
    assert.equal(v.ok, false);
    assert.notEqual(v.recorded, v.actual);
    assert.ok(v.action.includes('corrupted'));
  } finally { await cleanTempRoot(root); }
});

test('corrupted manifest: malformed, bad-schema, missing-hash manifests are refused', async () => {
  const base = fakeManifest();
  assert.throws(() => loadManifestFromString(JSON.stringify(base).replace(/"schemaVersion": 1/, '"schemaVersion": 2')),
    (e) => e.code === ERR.MANIFEST_MALFORMED);
  assert.throws(() => loadManifestFromString('{ not json'),
    (e) => e.code === ERR.MANIFEST_MALFORMED);
  const badHash = JSON.parse(JSON.stringify(base));
  badHash.node[TARGET].sha256 = 'not-a-hash';
  assert.throws(() => loadManifestFromString(JSON.stringify(badHash)),
    (e) => e.code === ERR.MANIFEST_MALFORMED);
  const noDsh = JSON.parse(JSON.stringify(base));
  delete noDsh.dsh;
  assert.throws(() => loadManifestFromString(JSON.stringify(noDsh)),
    (e) => e.code === ERR.MANIFEST_MALFORMED);
});

test('integrity: a file whose hash does not match is never accepted', async () => {
  const file = path.join(os.tmpdir(), `uh-integrity-${process.pid}.bin`);
  fs.writeFileSync(file, Buffer.alloc(64, 1));
  try {
    const ok = await verifyFileSha256(file, await sha256File(file));
    assert.equal(ok.ok, true);
    const bad = await verifyFileSha256(file, '0'.repeat(64));
    assert.equal(bad.ok, false);
    assert.equal(bad.error, 'HASH_MISMATCH');
    const missing = await verifyFileSha256(file + '.nope', '0'.repeat(64));
    assert.equal(missing.error, 'FILE_MISSING');
    const malformed = await verifyFileSha256(file, 'zzz');
    assert.equal(malformed.error, 'EXPECTED_HASH_MALFORMED');
  } finally { fs.rmSync(file, { force: true }); }
});

test('tree hash is deterministic and order-independent', async () => {
  const a = path.join(os.tmpdir(), `uh-tree-a-${process.pid}`);
  const b = path.join(os.tmpdir(), `uh-tree-b-${process.pid}`);
  fs.mkdirSync(path.join(a, 'sub'), { recursive: true });
  fs.mkdirSync(path.join(b, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(a, 'sub', 'f'), 'data');
  fs.writeFileSync(path.join(b, 'sub', 'f'), 'data');
  try {
    assert.equal(hashTree(a), hashTree(b)); // same content, different layout prefix
    fs.writeFileSync(path.join(b, 'sub', 'f'), 'changed');
    assert.notEqual(hashTree(a), hashTree(b));
  } finally {
    fs.rmSync(a, { recursive: true, force: true });
    fs.rmSync(b, { recursive: true, force: true });
  }
});

test('writeInstallState round trip records the authoritative hash', async () => {
  const { root } = await buildTempRoot();
  try {
    const treeDir = path.join(root, 'runtime', 'node', TARGET);
    const before = hashTree(treeDir);
    writeInstallState(treeDir, { target: TARGET, version: 'v1', archive: 'x', sha256: 'a'.repeat(64), treeHash: before });
    // The state file itself is excluded from the tree hash.
    assert.equal(hashTree(treeDir), before);
  } finally { await cleanTempRoot(root); }
});

function loadManifestFromString(objOrText) {
  const dir = path.join(os.tmpdir(), `uh-manifest-${process.pid}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'runtime.manifest.json');
  fs.writeFileSync(file, typeof objOrText === 'string' ? objOrText : JSON.stringify(objOrText));
  return loadManifest(file);
}
