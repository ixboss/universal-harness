// `uh setup` — installs the manifest-pinned runtime into runtime/.
//
// Flow (spec §3/§4):
//   1. resolve the manifest entry for the current target;
//   2. download the archive (or reuse a verified local copy);
//   3. verify SHA-256 against the manifest — a mismatch fails safely and the
//      archive is never unpacked or executed;
//   4. extract into runtime/node/<target>/ and record a tree hash so later
//      corruption is detectable;
//   5. install the exact pinned dsh with the bundled Node's own npm;
//   6. re-run the RuntimeManager status check as the acceptance test.
//
// Extraction relies on the OS tar (Windows 10 1803+ ships bsdtar, which reads
// both zip and tar.xz; Linux/macOS ship GNU/BSD tar). This keeps Universal
// Harness free of native extraction dependencies.

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { loadManifest, nodeEntry, dshEntry } from './manifest.mjs';
import { sha256File, verifyFileSha256 } from '../integrity/mod.mjs';
import { createRuntimeManager, writeInstallState, hashTree } from './mod.mjs';
import { RUNTIME_TARGET, nodeExeName, npmCliRelPath } from '../platform/mod.mjs';
import { portablePaths, ensureDir } from '../paths/mod.mjs';
import { UhError, ERR } from '../errors/mod.mjs';

/**
 * Download `url` to `dest` if the destination is absent (or `force`).
 * Streams to a temp file and renames only after the SHA-256 passes, so a
 * partial download can never be mistaken for a verified runtime.
 *
 * @returns {Promise<string>} path to the downloaded archive
 */
async function download(url, dest, sha256, { force, log }) {
  if (fs.existsSync(dest) && !force) {
    const v = await verifyFileSha256(dest, sha256);
    if (v.ok) { log.debug('reusing verified archive', { file: path.basename(dest) }); return dest; }
    log.warn('local archive failed verification; re-downloading', { file: path.basename(dest) });
  }
  const tmp = `${dest}.part`;
  log.info('downloading', { url, to: path.basename(dest) });
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new UhError(ERR.RUNTIME_MISSING,
    `download failed with HTTP ${res.status}`, { url },
    'Check the network connection; the manifest pins the exact source URL.');
  let bytes = 0;
  const counter = new Transform({
    transform(chunk, _enc, cb) { bytes += chunk.length; cb(null, chunk); },
  });
  await pipeline(res.body, counter, createWriteStream(tmp));
  const v = await verifyFileSha256(tmp, sha256);
  if (!v.ok) {
    fs.rmSync(tmp, { force: true });
    throw new UhError(ERR.RUNTIME_HASH_MISMATCH,
      `downloaded archive failed SHA-256 verification (expected ${v.expected}, got ${v.actual})`,
      { url, bytes },
      'The archive was corrupted in transit or the manifest pin is wrong; re-run `uh setup`, and if it persists re-derive the hash from the official checksum source.');
  }
  fs.renameSync(tmp, dest);
  log.info('archive verified', { file: path.basename(dest), sha256: v.expected, bytes });
  return dest;
}

/** Extract an archive with the OS tar into `into`, returning the extracted root name. */
// GNU tar cannot read .zip archives, but Windows ships bsdtar in System32;
// prefer it explicitly so a GNU tar earlier on PATH cannot break extraction.
function resolveTarCommand() {
  if (process.platform === 'win32') {
    const sysRoot = process.env.SystemRoot || 'C:\Windows';
    const sysTar = path.join(sysRoot, 'System32', 'tar.exe');
    if (fs.existsSync(sysTar)) return sysTar;
  }
  return 'tar';
}

function extractArchive(archive, format, into, log) {
  ensureDir(into);
  // Run tar from the archive's parent with relative arguments: on Windows,
  // bsdtar parses "C:\path" (or "C:/path") as host:path scp syntax and fails
  // with "Cannot connect to C:". Relative args keep drive letters out of argv.
  const base = path.dirname(archive);
  const relArchive = path.basename(archive);
  const relInto = (path.relative(base, into) || '.').split(path.sep).join('/');
  const args = ['-xf', relArchive, '-C', relInto];
  log.info('extracting', { archive: relArchive, into: relInto });
  const r = spawnSyncLogged(resolveTarCommand(), args, log, base);
  if (r.status !== 0) {
    throw new UhError(ERR.RUNTIME_MISSING,
      `extraction of ${path.basename(archive)} failed (tar exited ${r.status})`,
      { stderr: String(r.stderr || '').slice(0, 400) },
      'Ensure the OS `tar` is available (Windows 10 1803+ includes bsdtar).');
  }
}

function spawnSyncLogged(cmd, args, log, cwd) {
  const r = spawnSync(cmd, args, { windowsHide: true, encoding: 'utf8', maxBuffer: 1 << 22, cwd });
  if (r.error || (r.stderr && String(r.stderr).trim().length && process.env.UH_DEBUG)) {
    log.debug('child stderr', { cmd, args: args.join(' '), stderr: String(r.stderr || '').slice(0, 300) });
  }
  return r;
}

/**
 * Install the pinned dsh distribution using the bundled node's own npm.
 *
 * The dependency is written as an exact version (no caret) so npm can never
 * resolve a floating tag, and the resolved tarball integrity is recorded by
 * npm in the lockfile, which RuntimeManager verifies afterwards.
 */
async function installDsh(rm, log, { force }) {
  const man = rm.manifest;
  const p = rm.paths;
  const bin = rm.nodeBinary();
  const npm = rm.npmCli();
  if (!bin || !npm) throw new UhError(ERR.DSH_MISSING,
    'bundled Node/npm is unavailable; cannot install dsh', {},
    'Run `uh setup` fully — the Node bundle is installed before dsh.');

  ensureDir(p.runtimeDsh);
  const pkgPath = path.join(p.runtimeDsh, 'package.json');
  const lockPath = path.join(p.runtimeDsh, 'package-lock.json');
  if (force || !fs.existsSync(pkgPath) || !fs.existsSync(lockPath)) {
    const pkg = {
      name: 'universal-harness-dsh',
      version: '1.0.0',
      private: true,
      comment: 'Pinned dsh distribution for Universal Harness. Do not edit; `uh setup` owns this file.',
      dependencies: { [man.dsh.package]: man.dsh.version },
    };
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
  }
  log.info('installing pinned dsh via bundled npm', { package: man.dsh.package, version: man.dsh.version });
  const r = await runNpm(bin, npm, ['install', '--omit=dev', '--no-audit', '--no-fund', '--exact'], p.runtimeDsh, log);
  if (r.code !== 0) {
    throw new UhError(ERR.DSH_MISSING,
      `npm install of ${man.dsh.package}@${man.dsh.version} exited ${r.code}`,
      { stdout: r.stdout.slice(-400) },
      'Check network access to the npm registry; the manifest pins the exact package and version.');
  }
  log.info('dsh install complete', { package: man.dsh.package, version: man.dsh.version });
}

/** Run the bundled npm CLI with the bundled node. */
function runNpm(nodeBin, npmCli, args, cwd, log) {
  return new Promise((resolve) => {
    const child = spawn(nodeBin, [npmCli, ...args, '--no-audit', '--no-fund'], {
      cwd, windowsHide: true, shell: false,
      env: { ...process.env, npm_config_audit: 'false', npm_config_fund: 'false' },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', (e) => resolve({ code: -1, stdout, stderr: String(e) }));
    child.on('exit', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

/**
 * Execute the full setup for the current target.
 *
 * @param {Object} opts
 * @param {string} [opts.root]
 * @param {boolean} [opts.force]
 * @param {Object} [opts.log] logger
 * @param {string} [opts.target] override (tests)
 */
export async function setupRuntime({ root, force = false, log, target } = {}) {
  const logger = log || { info() {}, warn() {}, debug() {}, error() {} };
  const p = portablePaths(root);
  const man = loadManifest(path.join(p.manifests, 'runtime.manifest.json'));
  const selectedTarget = target || RUNTIME_TARGET;
  const e = nodeEntry(man, selectedTarget);

  ensureDir(p.runtime);
  ensureDir(p.runtimeNode);
  ensureDir(path.join(p.runtime, 'downloads'));

  const archivePath = path.join(p.runtime, 'downloads', path.basename(e.url));

  // 1+2+3. verified download (fails safely on hash mismatch).
  await download(e.url, archivePath, e.sha256, { force, log: logger });

  // 4. extract + record tree hash.
  const targetDir = path.join(p.runtimeNode, selectedTarget);
  const extractRoot = path.join(targetDir, e.extractedRoot);
  if (force || !fs.existsSync(extractRoot) || !fs.existsSync(path.join(extractRoot, e.nodeRelPath))) {
    if (fs.existsSync(targetDir)) fs.rmSync(targetDir, { recursive: true, force: true });
    extractArchive(archivePath, e.format, targetDir, logger);
    writeInstallState(targetDir, {
      target: selectedTarget,
      version: e.version,
      archive: path.basename(e.url),
      sha256: e.sha256,
      checksumSource: e.checksumSource,
      treeHash: hashTree(targetDir),
    });
    logger.info('node tree recorded', { target: selectedTarget, treeHash: hashTree(targetDir).slice(0, 16) });
  }

  // 5. pinned dsh install.
  const rm = createRuntimeManager({ root, manifest: man, target: selectedTarget });
  await installDsh(rm, logger, { force });

  // 6. acceptance check — setup is only "done" when status is green.
  const status = await rm.status();
  return { target: selectedTarget, status };
}

export { runNpm, installDsh };
