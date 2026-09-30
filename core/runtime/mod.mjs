// RuntimeManager (spec §10).
//
// Responsibilities: locate the bundled runtime, select platform/architecture,
// validate the manifest, verify integrity hashes, check availability, report
// exact runtime versions, locate dsh, check dsh compatibility, and produce
// actionable diagnostics. It never auto-updates — a future update system will
// swap the manifest + archives, not bypass this object.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { loadManifest, nodeEntry, dshEntry } from './manifest.mjs';
import { sha256File, verifyFileSha256 } from '../integrity/mod.mjs';
import { UhError, ERR } from '../errors/mod.mjs';
import { RUNTIME_TARGET, npmCliRelPath, SUPPORTED_TARGETS } from '../platform/mod.mjs';
import { portablePaths } from '../paths/mod.mjs';

const INSTALLED_STATE = '.uh-installed.json';

/**
 * @param {Object} opts
 * @param {string} [opts.root] Universal Harness root (auto-detected otherwise)
 * @param {Object} [opts.manifest] pre-loaded manifest (tests)
 * @param {string} [opts.target] override runtime target (tests)
 */
export function createRuntimeManager({ root, manifest, target } = {}) {
  const p = portablePaths(root);
  const man = manifest || loadManifest(path.join(p.manifests, 'runtime.manifest.json'));
  const selectedTarget = target || RUNTIME_TARGET;

  /** Absolute directory holding the extracted node distribution. */
  function nodeDir(t = selectedTarget) {
    return path.join(p.runtimeNode, t);
  }

  /** Absolute path to the bundled node binary, or null. */
  function nodeBinary(t = selectedTarget) {
    const e = nodeEntry(man, t);
    const exe = path.join(p.runtimeNode, t, e.extractedRoot, e.nodeRelPath);
    return fs.existsSync(exe) ? exe : null;
  }

  /** Absolute path to npm's CLI shipped inside the bundled node distribution. */
  function npmCli(t = selectedTarget) {
    const bin = nodeBinary(t);
    return bin ? path.join(path.dirname(bin), npmCliRelPath.split('/').join(path.sep)) : null;
  }

  /** Absolute path to the installed dsh package root, or null. */
  function dshPackageDir() {
    const dir = path.join(p.runtimeDsh, 'node_modules', '@deepseek-ai', 'dsh');
    return fs.existsSync(path.join(dir, 'package.json')) ? dir : null;
  }

  /** dsh executable entry (JS file) as declared by its package.json bin field. */
  function dshEntryPath() {
    const dir = dshPackageDir();
    if (!dir) return null;
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const bin = pkg.bin && (pkg.bin.dsh || (typeof pkg.bin === 'string' ? pkg.bin : undefined));
    if (!bin) return null;
    return path.resolve(dir, bin);
  }

  /**
   * Read the installed dsh version (its package.json) without spawning it.
   *
   * @returns {Object|null} {version, entry, integrity} or null when absent
   */
  function dshInstalled() {
    const dir = dshPackageDir();
    if (!dir) return null;
    const pkgPath = path.join(dir, 'package.json');
    const version = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;
    // The lockfile records the tarball integrity npm verified at install time.
    let lockIntegrity = null;
    for (const lockName of ['package-lock.json']) {
      const lockPath = path.join(p.runtimeDsh, lockName);
      if (fs.existsSync(lockPath)) {
        try {
          const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
          const nodekey = `node_modules/@deepseek-ai/dsh`;
          lockIntegrity = lock?.packages?.[nodekey]?.integrity || null;
        } catch { /* malformed lock reported by dshIntegrity check */ }
      }
    }
    return { version, entry: dshEntryPath(), integrity: lockIntegrity, dir };
  }

  /**
   * Spawn the bundled node to capture its exact version string.
   * Times out so a hung binary cannot wedge diagnostics.
   */
  async function getNodeVersion(t = selectedTarget) {
    const bin = nodeBinary(t);
    if (!bin) return null;
    return new Promise((resolve) => {
      const child = spawn(bin, ['-v'], { windowsHide: true });
      let out = '';
      const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} resolve(null); }, 15_000);
      child.stdout.on('data', (c) => { out += c; });
      child.on('error', () => { clearTimeout(timer); resolve(null); });
      child.on('exit', () => { clearTimeout(timer); resolve(out.trim() || null); });
    });
  }

  return {
    paths: p,
    manifest: man,
    target: selectedTarget,

    nodeDir,
    nodeBinary,
    npmCli,
    dshPackageDir,
    dshEntryPath,
    dshInstalled,
    getNodeVersion,
    nodeEntry: (t) => nodeEntry(man, t || selectedTarget),
    dshEntry: () => dshEntry(man),
    supportedTargets: () => [...SUPPORTED_TARGETS],

    /**
     * Full availability + integrity status. Every failure is already phrased
     * in the actionable doctor format (spec §11).
     *
     * @returns {Promise<{checks: Array, ok: boolean}>}
     */
    async status() {
      const checks = [];
      const add = (id, label, ok, expected, actual, action) =>
        checks.push({ id, label, status: ok ? 'ok' : 'fail', expected, actual: actual ?? null, action: ok ? null : action });

      const e = nodeEntry(man, selectedTarget);

      // --- bundled Node ----------------------------------------------------
      const bin = nodeBinary();
      add('node.present', `bundled node present (${selectedTarget})`, !!bin,
        path.join('runtime/node', selectedTarget, e.extractedRoot, e.nodeRelPath),
        bin,
        'Run `uh setup` to download and verify the pinned Node bundle.');

      if (bin) {
        const version = await this.getNodeVersion();
        add('node.version', 'bundled node version matches manifest pin', version === e.version,
          e.version, version,
          `An unexpected Node is installed; run \`uh setup\` to restore ${e.version}.`);

        const tree = this.verifyNodeTree();
        add('node.integrity', 'bundled node tree hash matches install record',
          tree.ok, tree.recorded, tree.actual || 'no files',
          tree.action);
      }

      // --- dsh -------------------------------------------------------------
      const inst = dshInstalled();
      add('dsh.present', 'pinned @deepseek-ai/dsh installed', !!inst,
        man.dsh.package, inst?.version,
        'Run `uh setup` to install the pinned dsh distribution.');

      if (inst) {
        add('dsh.version', 'installed dsh version matches manifest pin',
          inst.version === man.dsh.version, man.dsh.version, inst.version,
          `Run \`uh setup\` to restore ${man.dsh.package}@${man.dsh.version}.`);

        const lockOk = !!inst.integrity;
        add('dsh.integrity', 'installed dsh tarball integrity recorded (npm lockfile)',
          lockOk, man.dsh.integrity.slice(0, 20) + '...', inst.integrity ? inst.integrity.slice(0, 20) + '...' : 'missing lockfile entry',
          'Delete runtime/dsh and re-run `uh setup`; npm records the tarball sha512 at install time.');
        if (lockOk && inst.integrity !== man.dsh.integrity) {
          checks[checks.length - 1].status = 'fail';
          checks[checks.length - 1].action = 'Installed dsh was resolved from a different tarball than the manifest pin; delete runtime/dsh and re-run `uh setup`.';
        }

        add('dsh.entry', 'dsh CLI entry resolves from its package bin field',
          !!inst.entry, 'bin/dsh', inst.entry,
          'The installed dsh package has no usable bin entry; delete runtime/dsh and re-run `uh setup`.');
      }

      const ok = checks.every((c) => c.status === 'ok');
      return { checks, ok, target: selectedTarget };
    },

    /**
     * Verify the extracted node tree against the install record (spec §3:
     * fail safely if the runtime no longer matches what was installed).
     *
     * Computes a deterministic tree hash: sha256 over "<relpath>\\0<sha256>" of
     * every file, sorted, so any changed, added, or removed file is detected.
     *
     * @param {string} [t] target override
     * @returns {{ok:boolean, recorded:string|null, actual:string|null, action:string}}
     */
    verifyNodeTree(t = selectedTarget) {
      const dir = nodeDir(t);
      const statePath = path.join(dir, INSTALLED_STATE);
      let recorded = null;
      try { recorded = JSON.parse(fs.readFileSync(statePath, 'utf8')).treeHash || null; }
      catch { /* absent or malformed treat as mismatch */ }
      const actual = hashTree(dir);
      return {
        ok: !!recorded && recorded === actual,
        recorded, actual,
        action: 'The bundled Node runtime tree no longer matches its install record — it may be corrupted or tampered with. Delete runtime/node and re-run `uh setup`.',
      };
    },

    /** Expose tree hashing for the setup flow. */
    hashTree,
  };
}

/** Deterministic hash of a directory tree (sorted file list + per-file sha256). */
export function hashTree(dir) {
  if (!fs.existsSync(dir)) return null;
  const entries = [];
  const walk = (d, rel) => {
    for (const name of fs.readdirSync(d).sort()) {
      if (name === INSTALLED_STATE) continue;
      const abs = path.join(d, name);
      const r = rel ? `${rel}/${name}` : name;
      if (fs.statSync(abs).isDirectory()) walk(abs, r);
      else entries.push([r, createHash('sha256').update(fs.readFileSync(abs)).digest('hex')]);
    }
  };
  walk(dir, '');
  const concat = entries.map(([r, h]) => `${r}\0${h}`).join('\n');
  return createHash('sha256').update(concat).digest('hex');
}

/** Mark a freshly installed node tree with its inventory. */
export function writeInstallState(dir, meta) {
  fs.writeFileSync(path.join(dir, INSTALLED_STATE), JSON.stringify({ ...meta, writtenAt: new Date().toISOString() }, null, 2));
}

/** Throw when the runtime is unusable, carrying the first failed check. */
export async function requireRuntime(rm) {
  const { checks, ok } = await rm.status();
  if (!ok) {
    const first = checks.find((c) => c.status === 'fail');
    const code = first.id.startsWith('dsh.') ? ERR.DSH_MISSING : ERR.RUNTIME_MISSING;
    throw new UhError(code, `${first.label}: expected ${first.expected}, actual ${first.actual}`,
      { check: first.id }, first.action);
  }
}
