// Test helpers: build a self-contained fake Universal Harness root whose
// runtime tree points at a copied node binary and the fake dsh stub, so
// process-lifecycle tests run deterministically without network access.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntimeManager } from '../core/runtime/mod.mjs';
import { platform } from 'node:process';

export const TARGET = process.platform === 'win32' ? 'win-x64' : 'linux-x64';

/**
 * Create a temp Universal Harness root with the runnable skeleton:
 *
 *   bin/uh.mjs                 (marker file, finds the root)
 *   manifests/runtime.manifest.json (fake-but-valid manifest)
 *   runtime/node/<target>/node-dist/node.exe   (copy of this node)
 *   runtime/dsh/node_modules/@deepseek-ai/dsh/{package.json,lib/bin.js}
 *
 * @param {Object} [opts] { manifest: override manifest object }
 */
export async function buildTempRoot({ manifest } = {}) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'uh-test-'));
  const dirs = {
    bin: path.join(root, 'bin'),
    manifests: path.join(root, 'manifests'),
    data: path.join(root, 'data'),
    workspace: path.join(root, 'data', 'workspace'),
    projects: path.join(root, 'data', 'projects'),
    nodeDir: path.join(root, 'runtime', 'node', TARGET, 'node-dist'),
    dshDir: path.join(root, 'runtime', 'dsh', 'node_modules', '@deepseek-ai', 'dsh'),
  };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(dirs.bin, 'uh.mjs'), '// test marker\n');

  // A real node binary so spawn paths are genuine.
  const nodeCopy = path.join(dirs.nodeDir, process.platform === 'win32' ? 'node.exe' : 'node');
  await fs.promises.copyFile(process.execPath, nodeCopy);

  // The fake dsh package, wired like the real one.
  fs.writeFileSync(path.join(dirs.dshDir, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh',
    version: '0.2.0-rc.2',
    bin: { dsh: 'lib/bin.js' },
  }, null, 2));
  fs.mkdirSync(path.join(dirs.dshDir, 'lib'), { recursive: true });
  const fixture = fileURLToPath(new URL('fixtures/fake-dsh.mjs', import.meta.url));
  fs.copyFileSync(fixture, path.join(dirs.dshDir, 'lib', 'bin.js'));

  const man = manifest || fakeManifest();

  // npm records the resolved tarball integrity in the lockfile at install
  // time; the runtime manager checks it, so the fake tree carries one too.
  fs.writeFileSync(path.join(root, 'runtime', 'dsh', 'package-lock.json'), JSON.stringify({
    name: 'universal-harness-dsh',
    lockfileVersion: 3,
    packages: { 'node_modules/@deepseek-ai/dsh': { version: man.dsh.version, integrity: man.dsh.integrity } },
  }, null, 2));
  fs.writeFileSync(path.join(dirs.manifests, 'runtime.manifest.json'), JSON.stringify(man, null, 2));

  // Install record so the integrity check passes: record the tree hash of a
  // "clean" tree right after fixture setup.
  const { hashTree, writeInstallState } = await import('../core/runtime/mod.mjs');
  const treeDir = path.join(root, 'runtime', 'node', TARGET);
  writeInstallState(treeDir, {
    target: TARGET,
    version: man.node[TARGET].version,
    archive: 'node-fake.zip',
    sha256: man.node[TARGET].sha256,
    checksumSource: 'https://example.invalid/SHASUMS256.txt',
    treeHash: hashTree(treeDir),
  });

  return { root, dirs, nodeCopy, manifest: man, rm: createRuntimeManager({ root, manifest: man }) };
}

export function fakeManifest({ nodeVersion = process.version, dshVersion = '0.2.0-rc.2' } = {}) {
  return {
    schemaVersion: 1,
    node: {
      [TARGET]: {
        version: nodeVersion,
        format: 'zip',
        url: 'https://example.invalid/node.zip',
        sha256: 'a'.repeat(64),
        checksumSource: 'https://example.invalid/SHASUMS256.txt',
        extractedRoot: 'node-dist',
        nodeRelPath: process.platform === 'win32' ? 'node.exe' : 'node',
      },
    },
    dsh: {
      package: '@deepseek-ai/dsh',
      version: dshVersion,
      registry: 'https://registry.npmjs.org',
      tarball: 'https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.2.0-rc.2.tgz',
      integrity: 'sha512-EAJ3gPNcVt/uv8X19PMm9NkVhWgT7xXNMk0UKCVm+IQ5rpSQOcsMUa0HWlnYYVybKMsccjcRB21vVVsaXQ6IdA==',
      shasum: 'dfc8f7e09cfa96b854d6f0cf3a973ce7f2948925',
    },
  };
}

/** Remove a temp root, tolerating Windows lock quirks. */
export async function cleanTempRoot(root) {
  try { await fs.promises.rm(root, { recursive: true, force: true }); }
  catch { /* best effort: tests die with the tmpdir anyway */ }
}

/** Whether a pid is still alive. */
export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
