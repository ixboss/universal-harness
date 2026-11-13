// scripts/build-desktop.mjs — assemble the portable USB/Desktop distribution.
//
// For each target (win-x64, linux-x64, macos-arm64) this stages a complete
// Universal Harness portable root:
//
//   bin/ core/ shared/ manifests/   the JS node (copied verbatim from the repo)
//   runtime/node/<target>/...       the hash-pinned Node v24.x runtime
//                                   (downloaded + SHA-256 verified against
//                                   manifests/runtime.manifest.json)
//   data/ logs/                     empty default folders so a fresh bundle
//                                   never hits UH_ROOT_NOT_FOUND (exit 12) or a
//                                   missing data/ path
//   desktop/… launchers             the double-clickable start wrappers
//
// and archives the result as:
//   UniversalHarness-<version>-usb-<target>.zip (win-x64)
//   UniversalHarness-<version>-usb-<target>.tar.gz (linux-x64 / macos-arm64)
//   UniversalHarness-<version>-usb-universal.zip (all targets, launcher-per-OS)
//
// Runs on the bundled portable Node (zero dependencies). Never writes outside
// the explicitly provided --out directory.

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;
const MANIFEST = JSON.parse(fs.readFileSync(path.join(REPO, 'manifests', 'runtime.manifest.json'), 'utf8'));

const STAGE_TOP = ['bin', 'core', 'shared', 'manifests'];
const LAUNCHERS = ['desktop/windows/UniversalHarness.bat', 'desktop/linux/UniversalHarness.sh', 'desktop/macos/UniversalHarness.command', 'desktop/launcher/README.md'];

function parseArgs(argv) {
  const out = { targets: [], out: path.join(REPO, 'dist'), 'skip-download': false, universal: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--target') out.targets.push(argv[++i]);
    else if (a === '--all') out.targets = ['win-x64', 'linux-x64', 'macos-arm64'];
    else if (a === '--out') out.out = path.resolve(argv[++i]);
    else if (a === '--skip-download') out['skip-download'] = true;
    else if (a === '--no-universal') out.universal = false;
    else if (a === '--help' || a === '-h') { usage(); process.exit(0); }
    else fail(`unknown argument: ${a}`);
  }
  if (!out.targets.length) out.targets = hostTarget() === 'win-x64' ? ['win-x64'] : [hostTarget()];
  for (const t of out.targets) {
    if (!MANIFEST.node?.[t]) fail(`target "${t}" is not in manifests/runtime.manifest.json`);
  }
  return out;
}

function usage() {
  process.stdout.write(`Usage: node scripts/build-desktop.mjs [--target win-x64|linux-x64|macos-arm64]... [--all]
       [--out dist] [--skip-download] [--no-universal]

Stages portable USB/Desktop roots and archives them. Defaults to the host
target when no --target is given.\n`);
}

function fail(msg) {
  process.stderr.write(`build-desktop: ${msg}\n`);
  process.exit(1);
}

function hostTarget() {
  const platform = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'macos' : 'linux';
  return `${platform}-${process.arch}`;
}

function sha256File(file) {
  const h = createHash('sha256');
  fs.createReadStream(file).pipe(h);
  return new Promise((res, rej) => h.on('finish', () => res(h.digest('hex'))).on('error', rej));
}

async function download(url, dest) {
  process.stdout.write(`  downloading ${url}\n`);
  const res = await fetch(url);
  if (!res.ok || !res.body) fail(`download failed: HTTP ${res.status} for ${url}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  await pipeline(res.body, fs.createWriteStream(dest));
}

/** Copy a repo directory tree, skipping junk (dist, git, node_modules, data). */
function copyTree(src, dest) {
  const skip = new Set(['node_modules', '.git', 'dist', 'data', 'runtime', 'logs', 'diagnostics', '.vscode', 'site']);
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyTree(s, d);
    else fs.copyFileSync(s, d);
  }
}

/** Stage one portable root for `target` under outDir. Returns the root path. */
async function stageTarget(target, opts) {
  const spec = MANIFEST.node[target];
  const rootName = 'UniversalHarness';
  const root = path.join(opts.out, `usb-${target}`, rootName);
  fs.rmSync(path.dirname(root), { recursive: true, force: true });

  process.stdout.write(`staging ${target} -> ${root}\n`);
  for (const dir of STAGE_TOP) copyTree(path.join(REPO, dir), path.join(root, dir));
  fs.copyFileSync(path.join(REPO, 'package.json'), path.join(root, 'package.json'));

  // Default data/ and logs/ folders: a fresh USB stick must never trip
  // UH_ROOT_NOT_FOUND / missing-directory errors on first launch.
  for (const rel of ['data/logs', 'data/config', 'data/projects', 'data/sessions', 'data/state', 'data/workspace', 'data/backups', 'logs']) {
    fs.mkdirSync(path.join(root, rel), { recursive: true });
  }
  fs.writeFileSync(
    path.join(root, 'data', 'config', 'config.json'),
    `${JSON.stringify({ schemaVersion: 1, adapter: { harness: 'deepseek' }, logging: { level: 'info' } }, null, 2)}\n`,
  );

  // Bundled runtime: verify (or download + verify) the pinned Node archive.
  const archiveDir = path.join(opts.out, 'node-cache');
  const archiveName = `${target}.${spec.format}`;
  const archive = path.join(archiveDir, archiveName);
  if (!fs.existsSync(archive)) {
    if (opts['skip-download']) {
      process.stdout.write(`  --skip-download: bundling without the Node runtime (uh setup will fetch it)\n`);
    } else {
      await download(spec.url, archive);
    }
  }
  if (fs.existsSync(archive)) {
    const actual = await sha256File(archive);
    if (actual.toLowerCase() !== spec.sha256.toLowerCase()) {
      fail(`sha256 mismatch for ${archiveName}: expected ${spec.sha256}, got ${actual}`);
    }
    process.stdout.write(`  sha256 verified: ${archiveName}\n`);
    // Extract straight into runtime/node/<target>/ exactly as `uh setup` does.
    const dest = path.join(root, 'runtime', 'node', target);
    fs.mkdirSync(dest, { recursive: true });
    extractArchive(archive, spec.format, dest);
    process.stdout.write(`  runtime extracted to runtime/node/${target}\n`);
  }

  // Launchers for every OS ride along in every bundle; only the matching one
  // is executable on the running host, the rest are inert text.
  for (const rel of LAUNCHERS) {
    const src = path.join(REPO, rel);
    if (fs.existsSync(src)) {
      const dest = path.join(root, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    }
  }
  return root;
}

function extractArchive(archive, format, dest) {
  const r = (cmd, args) => {
    const res = spawnSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    if (res.status !== 0) fail(`extraction failed (${cmd} ${args.join(' ')}): ${res.stderr}`);
  };
  if (format === 'zip') {
    if (process.platform === 'win32') r('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${dest}' -Force`]);
    else r('unzip', ['-q', archive, '-d', dest]);
  } else {
    r('tar', ['-xf', archive, '-C', dest]);
  }
}

function archiveRoot(root, target, opts) {
  const ext = target === 'win-x64' ? 'zip' : 'tar.gz';
  const base = `UniversalHarness-v${VERSION}-usb-${target}`;
  const dest = path.join(opts.out, `${base}.${ext}`);
  process.stdout.write(`archiving ${dest}\n`);
  fs.rmSync(dest, { force: true });
  if (ext === 'zip') {
    if (process.platform === 'win32') {
      r2('powershell.exe', ['-NoProfile', '-Command', `Compress-Archive -Path '${root}' -DestinationPath '${dest}' -Force`]);
    } else {
      r2('zip', ['-qr', dest, path.basename(root)], path.dirname(root));
    }
  } else {
    r2('tar', ['-czf', dest, path.basename(root)], path.dirname(root));
  }
  return dest;
}

function r2(cmd, args, cwd) {
  const res = spawnSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  if (res.status !== 0) fail(`${cmd} failed: ${res.stderr?.toString().slice(0, 400)}`);
}

/** Cross-target universal bundle: repo tree + all downloaded runtimes staged. */
async function stageUniversal(opts) {
  const root = path.join(opts.out, 'usb-universal', 'UniversalHarness');
  fs.rmSync(path.dirname(root), { recursive: true, force: true });
  process.stdout.write(`staging universal bundle -> ${root}\n`);
  for (const dir of STAGE_TOP) copyTree(path.join(REPO, dir), path.join(root, dir));
  fs.copyFileSync(path.join(REPO, 'package.json'), path.join(root, 'package.json'));
  for (const rel of ['data/logs', 'data/config', 'data/projects', 'data/sessions', 'data/state', 'data/workspace', 'data/backups', 'logs']) {
    fs.mkdirSync(path.join(root, rel), { recursive: true });
  }
  fs.writeFileSync(
    path.join(root, 'data', 'config', 'config.json'),
    `${JSON.stringify({ schemaVersion: 1, adapter: { harness: 'deepseek' }, logging: { level: 'info' } }, null, 2)}\n`,
  );
  for (const rel of LAUNCHERS) {
    const src = path.join(REPO, rel);
    if (fs.existsSync(src)) {
      const dest = path.join(root, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    }
  }
  for (const target of ['win-x64', 'linux-x64', 'macos-arm64']) {
    const spec = MANIFEST.node[target];
    const archive = path.join(opts.out, 'node-cache', `${target}.${spec.format}`);
    if (!fs.existsSync(archive)) continue; // only bundle what was fetched
    const dest = path.join(root, 'runtime', 'node', target);
    fs.mkdirSync(dest, { recursive: true });
    extractArchive(archive, spec.format, dest);
  }
  return root;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  fs.mkdirSync(opts.out, { recursive: true });
  const artifacts = [];
  for (const target of opts.targets) {
    const root = await stageTarget(target, opts);
    if (!fs.existsSync(path.join(root, 'bin', 'uh.mjs'))) fail(`staged root is invalid (missing bin/uh.mjs): ${root}`);
    artifacts.push(archiveRoot(root, target, opts));
  }
  if (opts.universal) {
    const root = await stageUniversal(opts);
    const dest = path.join(opts.out, `UniversalHarness-v${VERSION}-usb-universal.zip`);
    process.stdout.write(`archiving ${dest}\n`);
    fs.rmSync(dest, { force: true });
    if (process.platform === 'win32') {
      r2('powershell.exe', ['-NoProfile', '-Command', `Compress-Archive -Path '${root}' -DestinationPath '${dest}' -Force`]);
    } else {
      r2('zip', ['-qr', dest, path.basename(root)], path.dirname(root));
    }
    artifacts.push(dest);
  }
  process.stdout.write(`\ndone. artifacts:\n${artifacts.map((a) => `  ${a}`).join('\n')}\n`);
}

main().catch((e) => fail(e?.stack || e?.message || String(e)));
