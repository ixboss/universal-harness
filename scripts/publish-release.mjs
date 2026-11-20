// scripts/publish-release.mjs — assemble release artifacts, generate
// SHA256SUMS.txt, and publish the GitHub Release.
//
//   node scripts/publish-release.mjs --out dist            (assemble + SHA256SUMS only)
//   node scripts/publish-release.mjs --out dist --publish  (also `gh release create v<version>`)
//
// `--publish` requires the `gh` CLI authenticated against ixboss/universal-harness.
// Zero dependencies; runs on the bundled portable Node.

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;
const TAG = `v${VERSION}`;
const REPO_SLUG = 'ixboss/universal-harness';

const ANDROID_ARTIFACT = path.join(REPO, 'android', 'app', 'build', 'outputs', 'apk', 'online', 'release', 'app-online-release.apk');

function parseArgs(argv) {
  const out = { out: path.join(REPO, 'dist'), publish: false, draft: false, notes: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') out.out = path.resolve(argv[++i]);
    else if (a === '--publish') out.publish = true;
    else if (a === '--draft') out.draft = true;
    else if (a === '--notes-file') out.notes = path.resolve(argv[++i]);
    else if (a === '--help' || a === '-h') { usage(); process.exit(0); }
    else fail(`unknown argument: ${a}`);
  }
  return out;
}

function usage() {
  process.stdout.write(`Usage: node scripts/publish-release.mjs [--out dist] [--publish] [--draft] [--notes-file NOTES.md]\n`);
}

function fail(msg) {
  process.stderr.write(`publish-release: ${msg}\n`);
  process.exit(1);
}

function sha256File(file) {
  const h = createHash('sha256');
  fs.createReadStream(file).pipe(h);
  return new Promise((res, rej) => h.on('finish', () => res(h.digest('hex'))).on('error', rej));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(opts.out)) fail(`--out directory does not exist: ${opts.out} (run scripts/build-desktop.mjs first)`);

  // Collect release artifacts from dist/ + the Android APK if built. Bundles
  // are version-named, so only the current version's artifacts are taken:
  // stale leftovers of older builds in dist/ are never uploaded or checksummed.
  const prefix = `UniversalHarness-v${VERSION}-`;
  const files = fs.readdirSync(opts.out)
    .filter((f) => (f.endsWith('.zip') || f.endsWith('.tar.gz')) && f.startsWith(prefix))
    .map((f) => path.join(opts.out, f));

  // The APK's gradle name carries no version, so it cannot be matched the same
  // way: normalise whichever fresh APK is present (gradle output locally, the
  // CI-staged copy here) into the versioned destination name. Versioned APKs
  // of OTHER versions are stale and left alone.
  const destApk = path.join(opts.out, `${prefix}android.apk`);
  const apkCandidates = [
    ANDROID_ARTIFACT,
    ...fs.readdirSync(opts.out)
      .filter((f) => f.endsWith('.apk') && !f.startsWith('UniversalHarness-v'))
      .map((f) => path.join(opts.out, f)),
  ];
  const apkSource = apkCandidates.find((f) => fs.existsSync(f)) || (fs.existsSync(destApk) ? destApk : null);
  if (apkSource) {
    if (apkSource !== destApk) {
      fs.rmSync(destApk, { force: true }); // Windows rename cannot replace in place
      fs.copyFileSync(apkSource, destApk);
    }
    files.push(destApk);
  } else {
    process.stdout.write(`note: no Android APK found (skipping)\n`);
  }
  if (!files.length) fail(`no release artifacts (.zip/.tar.gz) found in ${opts.out}`);

  // SHA256SUMS.txt over every artifact.
  const lines = [];
  for (const file of files.sort()) {
    const hash = await sha256File(file);
    lines.push(`${hash}  ${path.basename(file)}`);
    process.stdout.write(`${hash}  ${path.basename(file)}\n`);
  }
  const sumsPath = path.join(opts.out, 'SHA256SUMS.txt');
  fs.writeFileSync(sumsPath, lines.join('\n') + '\n');
  files.push(sumsPath);

  if (!opts.publish) {
    process.stdout.write(`\nartifacts ready in ${opts.out} (use --publish to create the GitHub Release)\n`);
    return;
  }

  // Publish via gh — idempotent: create the release, or upload into the
  // existing one (--clobber overwrites stale assets from a re-run).
  const create = spawnSync('gh', [
    'release', 'create', TAG,
    '--repo', REPO_SLUG,
    '--title', `Universal Harness v${VERSION}`,
    ...(opts.draft ? ['--draft'] : []),
    '--generate-notes',
    ...(opts.notes ? ['--notes-file', opts.notes] : []),
    ...files,
  ], { stdio: 'inherit' });
  if (create.status !== 0) {
    process.stdout.write(`release ${TAG} already exists — uploading/clobbering assets\n`);
    const upload = spawnSync('gh', ['release', 'upload', TAG, '--repo', REPO_SLUG, '--clobber', ...files], { stdio: 'inherit' });
    if (upload.status !== 0) fail(`gh release upload failed (exit ${upload.status})`);
  }
  process.stdout.write(`published ${TAG} with ${files.length} artifact(s)\n`);
}

main().catch((e) => fail(e?.stack || e?.message || String(e)));
