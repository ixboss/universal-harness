// Portable workspace bundles (Phase 5, spec §13): export and import of the
// Universal Harness metadata that must travel with a workspace.
//
// A bundle is a **directory** — no archive step, and therefore no extractor to
// harden. It is self-describing (`manifest.json` with a per-file SHA-256) and it
// is imported with three non-negotiable rules:
//
//   1. verify-then-commit — nothing is written until every entry's SHA-256 and
//      the manifest checksum have been verified;
//   2. never overwrite — an import that would change an existing file is refused
//      wholesale (`IMPORT_CONFLICT`) with a per-file report; there is no
//      `--force`. Recovery is an explicit user action;
//   3. hostile bundles are refused — an allowlist of travelable paths, strict
//      path canonicalisation, no symlinks, no duplicate/Unicode/case collisions,
//      no Windows reserved names, and hard resource limits.
//
// Export and import both hold the advisory workspace lock, so two Universal
// Harness commands never mutate one workspace at once.
//
// No dsh knowledge; the bundle carries only Universal Harness metadata.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { sha256File, sha256Bytes } from '../integrity/mod.mjs';
import { UhError, ERR } from '../errors/mod.mjs';
import {
  ensureDir, assertSafeRelativePath, canonicalPathKey,
  isWindowsReservedName, hasWindowsIllegalChars,
} from '../paths/mod.mjs';
import { writeFileAtomicSync } from '../portable/mod.mjs';
import { acquireLock, LOCK_CODE } from '../portable/lock.mjs';

/** Bundle format major version. A newer major is refused, never guessed at. */
export const BUNDLE_VERSION = 1;
/** Self-describing marker so a stray directory is never mistaken for a bundle. */
export const BUNDLE_KIND = 'universal-harness.workspace-bundle';
/** Manifest filename at the bundle root. */
export const BUNDLE_MANIFEST = 'manifest.json';

/** Hard bounds on hostile input. */
export const BUNDLE_LIMITS = {
  maxEntries: 50000,
  maxTotalBytes: 2 * 1024 * 1024 * 1024,
  maxEntryBytes: 512 * 1024 * 1024,
  maxPathLength: 1024,
  maxDepth: 64,
  maxManifestBytes: 8 * 1024 * 1024,
};

/** Metadata that travels by default. */
const METADATA_FILES = [
  'data/workspace/.workspace.json',
  'data/workspace/registry.json',
  'data/config/config.json',
  'data/sessions/index.json',
];

/**
 * Paths that never travel, whatever a bundle claims. Device-local state,
 * secrets, logs, regenerable runtime and node-owned event logs are all here.
 */
const NEVER_TRAVEL = [
  'data/logs/',
  'diagnostics/',
  'runtime/',
  'data/state/',
  'data/backups/',
  'data/config/config.secure.json',
  '.uh-file-versions.json',
];

const REGISTRY_REL = 'data/workspace/registry.json';

function logShim(log) {
  return log || { info() {}, warn() {}, error() {}, debug() {} };
}

function isNeverTravel(rel) {
  return NEVER_TRAVEL.some((p) => (p.endsWith('/') ? rel.startsWith(p) : rel === p || rel.startsWith(`${p}/`)));
}

const isMetadataPath = (rel) => METADATA_FILES.includes(rel);
const isMigrationPath = (rel) => /^data\/migration\/[^/]+\.json$/.test(rel);
const isProjectMarker = (rel) => /^data\/projects\/[^/]+\/\.uh-project\.json$/.test(rel);
const isProjectTree = (rel) => /^data\/projects\/[^/]+\/.+/.test(rel);

/** The bundle-content allowlist: everything else is refused on import. */
function allowedInBundle(rel, includeProjects) {
  if (isNeverTravel(rel)) return false;
  if (isMetadataPath(rel) || isMigrationPath(rel) || isProjectMarker(rel)) return true;
  if (includeProjects && isProjectTree(rel)) return true;
  return false;
}

/** A bundle never carries an absolute path: `recordedRoot` is neutralised. */
function neutralizeRegistry(buf) {
  try {
    const j = JSON.parse(buf.toString('utf8'));
    if (j && typeof j === 'object' && !Array.isArray(j)) {
      j.recordedRoot = null;
      return Buffer.from(`${JSON.stringify(j, null, 2)}\n`);
    }
  } catch { /* not JSON — verification still covers the raw bytes */ }
  return buf;
}

/** Comparison form used for idempotency: `recordedRoot` is not significant. */
function normalizeForCompare(rel, buf) {
  if (rel !== REGISTRY_REL) return buf;
  try {
    const j = JSON.parse(buf.toString('utf8'));
    if (j && typeof j === 'object') { j.recordedRoot = null; return Buffer.from(JSON.stringify(j)); }
  } catch { /* fall through */ }
  return buf;
}

function readFileOrNull(file) {
  try { return fs.readFileSync(file); } catch { return null; }
}

// ---------------------------------------------------------------------------
// Export (S2)
// ---------------------------------------------------------------------------

/** Walk a directory tree, refusing symlinks (bundles contain none). */
function walkFiles(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    const rel = path.relative(base, abs).split(path.sep).join('/');
    if (e.isSymbolicLink()) {
      throw new UhError(ERR.BUNDLE_INVALID, `refusing to export a symlink: ${rel}`, { path: rel },
        'Bundles contain no symlinks. Remove the link (or the project) and export again.');
    }
    if (e.isDirectory()) walkFiles(abs, base, out);
    else if (e.isFile()) out.push(abs);
  }
  return out;
}

/** Every workspace-relative path that should travel. */
function collectExportPaths(root, includeProjects) {
  const rels = new Set();
  for (const rel of METADATA_FILES) if (fs.existsSync(path.join(root, rel))) rels.add(rel);

  const migDir = path.join(root, 'data', 'migration');
  if (fs.existsSync(migDir)) {
    for (const n of fs.readdirSync(migDir)) if (n.endsWith('.json')) rels.add(`data/migration/${n}`);
  }

  const projRoot = path.join(root, 'data', 'projects');
  if (fs.existsSync(projRoot)) {
    for (const e of fs.readdirSync(projRoot, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const marker = `data/projects/${e.name}/.uh-project.json`;
      if (fs.existsSync(path.join(root, marker))) rels.add(marker);
      if (includeProjects) {
        for (const abs of walkFiles(path.join(projRoot, e.name))) {
          rels.add(path.relative(root, abs).split(path.sep).join('/'));
        }
      }
    }
  }
  return [...rels].sort();
}

/**
 * Build a bundle manifest (and the exact bytes each entry will carry) without
 * touching the filesystem beyond reading.
 *
 * @returns {Promise<{manifest:Object, bytesByPath:Map<string,Buffer>}>}
 */
export async function buildBundleManifest({ root, includeProjects = false, producer = {} }) {
  const rels = collectExportPaths(root, includeProjects);
  const bytesByPath = new Map();
  for (const rel of rels) {
    const buf = readFileOrNull(path.join(root, rel));
    if (buf === null) continue;
    bytesByPath.set(rel, rel === REGISTRY_REL ? neutralizeRegistry(buf) : buf);
  }

  const entries = [];
  let totalBytes = 0;
  for (const [rel, buf] of bytesByPath) {
    entries.push({ path: rel, sha256: sha256Bytes(buf), bytes: buf.length, kind: 'file' });
    totalBytes += buf.length;
  }

  let workspaceId = null;
  const marker = readFileOrNull(path.join(root, 'data', 'workspace', '.workspace.json'));
  if (marker) { try { workspaceId = JSON.parse(marker.toString('utf8')).id ?? null; } catch { /* leave null */ } }

  const manifest = {
    bundleVersion: BUNDLE_VERSION,
    kind: BUNDLE_KIND,
    createdAt: new Date().toISOString(),
    producer: {
      uhVersion: producer.uhVersion ?? null,
      platform: process.platform,
      arch: process.arch,
      layoutVersion: producer.layoutVersion ?? null,
    },
    source: { workspaceId, recordedRoot: null },
    options: { includeProjects: !!includeProjects },
    excludes: NEVER_TRAVEL,
    entries,
    totals: { files: entries.length, bytes: totalBytes },
  };
  manifest.entriesChecksum = sha256Bytes(JSON.stringify(entries));
  return { manifest, bytesByPath };
}

/**
 * Export the workspace metadata to a directory bundle.
 *
 * The bundle is written to a sibling staging directory and renamed into place,
 * so an interrupted export never leaves a half-written bundle at `outDir`.
 *
 * @param {Object} opts { root, p, outDir, includeProjects, force, log }
 */
export async function exportWorkspace({ root, p, outDir, includeProjects = false, force = false, log = logShim() }) {
  const release = acquireWorkspaceLock(root, p, 'export');
  try {
    if (fs.existsSync(outDir)) {
      if (!force) {
        throw new UhError(ERR.BUNDLE_INVALID, `refusing to overwrite an existing path: ${outDir}`, { out: outDir },
          'Choose a different --out path, or pass --force to replace the existing bundle.');
      }
      fs.rmSync(outDir, { recursive: true, force: true });
    }

    const { manifest, bytesByPath } = await buildBundleManifest({ root, includeProjects });
    const staging = `${outDir}.uh-export-${crypto.randomUUID()}`;
    ensureDir(staging);
    try {
      fs.writeFileSync(path.join(staging, BUNDLE_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
      for (const [rel, buf] of bytesByPath) {
        const dst = path.join(staging, rel);
        ensureDir(path.dirname(dst));
        fs.writeFileSync(dst, buf);
      }
      fs.renameSync(staging, outDir);
    } catch (err) {
      try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* best effort */ }
      throw err;
    }
    log.info('workspace exported', { out: outDir, files: manifest.totals.files });
    return { out: outDir, manifest };
  } finally { release(); }
}

// ---------------------------------------------------------------------------
// Import (S3)
// ---------------------------------------------------------------------------

/** Read and structurally validate the manifest. Throws on any hard failure. */
export function readBundleManifest(bundleDir) {
  const mp = path.join(bundleDir, BUNDLE_MANIFEST);
  let raw;
  try { raw = fs.readFileSync(mp, 'utf8'); } catch {
    throw new UhError(ERR.BUNDLE_INVALID, `no ${BUNDLE_MANIFEST} found in ${bundleDir}`, { bundle: bundleDir },
      'Point --bundle at a Universal Harness bundle directory (see `uh export`).');
  }
  if (raw.length > BUNDLE_LIMITS.maxManifestBytes) {
    throw new UhError(ERR.BUNDLE_INVALID, 'the bundle manifest exceeds the size limit', { bytes: raw.length },
      'The bundle is not a Universal Harness bundle, or is corrupt.');
  }
  let m;
  try { m = JSON.parse(raw); } catch {
    throw new UhError(ERR.BUNDLE_INVALID, 'the bundle manifest is not valid JSON', { bundle: bundleDir },
      'The bundle is corrupt; re-export it from the source workspace.');
  }
  if (!m || typeof m !== 'object' || Array.isArray(m)) {
    throw new UhError(ERR.BUNDLE_INVALID, 'the bundle manifest is not an object', {}, 'Re-export the bundle.');
  }
  if (m.kind !== BUNDLE_KIND) {
    throw new UhError(ERR.BUNDLE_INVALID, `not a Universal Harness bundle (kind=${JSON.stringify(m.kind)})`, {},
      'Use a bundle produced by `uh export`.');
  }
  if (!Number.isInteger(m.bundleVersion) || m.bundleVersion < 1) {
    throw new UhError(ERR.BUNDLE_INVALID, 'the bundle manifest has no valid bundleVersion', {},
      'Re-export the bundle with a current Universal Harness.');
  }
  if (m.bundleVersion > BUNDLE_VERSION) {
    throw new UhError(ERR.BUNDLE_VERSION_UNSUPPORTED,
      `bundle version ${m.bundleVersion} is newer than this Universal Harness supports (${BUNDLE_VERSION})`,
      { bundleVersion: m.bundleVersion, supported: BUNDLE_VERSION },
      'Update Universal Harness, or re-export the bundle from a compatible version.');
  }
  if (!Array.isArray(m.entries)) {
    throw new UhError(ERR.BUNDLE_INVALID, 'the bundle manifest has no entries array', {}, 'Re-export the bundle.');
  }
  return m;
}

/** Validate one entry path; throws on the first violation. */
function validateEntryPath(rel, includeProjects, seen) {
  let canonical;
  try { canonical = assertSafeRelativePath(rel); } catch (err) {
    throw new UhError(ERR.BUNDLE_INVALID, `unsafe path in bundle: ${rel}`, { path: rel },
      'The bundle contains a path that escapes the workspace; it is not trusted.');
  }
  if (canonical !== rel) {
    throw new UhError(ERR.BUNDLE_INVALID, `non-canonical path in bundle: ${rel}`, { path: rel },
      'Bundle paths must be canonical; re-export the bundle.');
  }
  if (rel.length > BUNDLE_LIMITS.maxPathLength) {
    throw new UhError(ERR.BUNDLE_INVALID, `bundle path exceeds the length limit: ${rel}`, { path: rel }, 'Re-export the bundle.');
  }
  const segs = rel.split('/');
  if (segs.length > BUNDLE_LIMITS.maxDepth) {
    throw new UhError(ERR.BUNDLE_INVALID, `bundle path is too deep: ${rel}`, { path: rel }, 'Re-export the bundle.');
  }
  for (const s of segs) {
    if (!s) throw new UhError(ERR.BUNDLE_INVALID, `empty path segment in bundle: ${rel}`, { path: rel }, 'Re-export the bundle.');
    if (isWindowsReservedName(s)) {
      throw new UhError(ERR.BUNDLE_INVALID, `reserved device name in bundle path: ${rel}`, { path: rel },
        'The path cannot be represented on every supported platform; re-export without it.');
    }
    if (hasWindowsIllegalChars(s)) {
      throw new UhError(ERR.BUNDLE_INVALID, `illegal character in bundle path: ${rel}`, { path: rel }, 'Re-export the bundle.');
    }
    if (/[. ]$/.test(s)) {
      throw new UhError(ERR.BUNDLE_INVALID, `path segment ends in a dot or space: ${rel}`, { path: rel }, 'Re-export the bundle.');
    }
  }
  if (!allowedInBundle(rel, includeProjects)) {
    throw new UhError(ERR.BUNDLE_INVALID, `path is not permitted in a bundle: ${rel}`, { path: rel },
      'Only Universal Harness metadata (and, with --include-projects, project trees) may travel in a bundle.');
  }
  const key = canonicalPathKey(rel);
  if (seen.has(key)) {
    throw new UhError(ERR.BUNDLE_INVALID, `duplicate or colliding path in bundle: ${rel}`, { path: rel },
      'Two bundle entries collide on a case-insensitive or normalisation-sensitive filesystem; re-export the bundle.');
  }
  seen.add(key);
}

/**
 * Full, non-destructive inspection of a bundle: structure, allowlist, checksums.
 * Returns a problem list rather than throwing, so it can back `verify`.
 *
 * @returns {Promise<{ok:boolean, problems:Array, manifest:Object|null, entries:Map<string,Object>}>}
 */
export async function inspectBundle(bundleDir) {
  const problems = [];
  let manifest = null;
  try { manifest = readBundleManifest(bundleDir); }
  catch (err) {
    return {
      ok: false,
      code: err.code || ERR.BUNDLE_INVALID,
      problems: [{ reason: err.code || 'BUNDLE_INVALID', message: err.message }],
      manifest: null,
      entries: new Map(),
    };
  }

  const includeProjects = !!manifest.options?.includeProjects;
  const entries = new Map();

  if (manifest.entries.length > BUNDLE_LIMITS.maxEntries) {
    problems.push({ reason: 'LIMIT', message: `too many entries (${manifest.entries.length})` });
  }
  const declaredTotal = manifest.entries.reduce((n, e) => n + (Number.isFinite(e?.bytes) ? e.bytes : 0), 0);
  if (declaredTotal > BUNDLE_LIMITS.maxTotalBytes) {
    problems.push({ reason: 'LIMIT', message: `declared total bytes ${declaredTotal} exceeds the limit` });
  }
  const computedChecksum = sha256Bytes(JSON.stringify(manifest.entries));
  if (manifest.entriesChecksum && computedChecksum !== manifest.entriesChecksum) {
    problems.push({ reason: 'CHECKSUM', message: 'manifest entries checksum mismatch' });
  }

  const seen = new Set();
  for (const e of manifest.entries) {
    if (!e || typeof e.path !== 'string') { problems.push({ reason: 'ENTRY', message: 'entry has no path' }); continue; }
    try { validateEntryPath(e.path, includeProjects, seen); }
    catch (err) { problems.push({ reason: err.code || 'PATH', message: err.message, path: e.path }); continue; }
    entries.set(e.path, e);
  }
  if (problems.length) return { ok: false, problems, manifest, entries };

  // The bundle tree must contain exactly the listed entries — no smuggled files.
  const dataRoot = path.join(bundleDir, 'data');
  if (!fs.existsSync(dataRoot)) {
    problems.push({ reason: 'MISSING', message: 'the bundle has no data/ tree' });
  } else {
    let walked = [];
    try { walked = walkFiles(dataRoot, bundleDir); }
    catch (err) { problems.push({ reason: err.code || 'BUNDLE_INVALID', message: err.message }); }
    for (const abs of walked) {
      const rel = path.relative(bundleDir, abs).split(path.sep).join('/');
      if (!entries.has(rel)) problems.push({ reason: 'UNLISTED', message: `bundle contains an unlisted file: ${rel}`, path: rel });
    }
  }
  for (const rel of entries.keys()) {
    const abs = path.join(bundleDir, rel);
    if (!fs.existsSync(abs)) { problems.push({ reason: 'MISSING', message: `bundle is missing a listed file: ${rel}`, path: rel }); continue; }
    const st = fs.lstatSync(abs);
    if (st.isSymbolicLink()) { problems.push({ reason: 'SYMLINK', message: `bundle contains a symlink: ${rel}`, path: rel }); continue; }
    if (st.size > BUNDLE_LIMITS.maxEntryBytes) { problems.push({ reason: 'LIMIT', message: `entry exceeds the size limit: ${rel}`, path: rel }); continue; }
    const actual = await sha256File(abs);
    if (actual !== entries.get(rel).sha256) {
      problems.push({ reason: 'HASH_MISMATCH', message: `entry failed verification: ${rel}`, path: rel, expected: entries.get(rel).sha256, actual });
    }
  }
  return { ok: problems.length === 0, problems, manifest, entries };
}

/** Verify a bundle without writing anything. */
export async function verifyBundle({ bundleDir }) {
  const { ok, problems, manifest } = await inspectBundle(bundleDir);
  return { ok, problems, manifest };
}

/**
 * Import a bundle. Verify-then-commit, never overwriting.
 *
 * @param {Object} opts { root, p, bundleDir, dryRun, log }
 * @returns {Promise<{dryRun:boolean, toWrite:string[], skipped:string[], rootRederived:boolean}>}
 */
export async function importBundle({ root, p, bundleDir, dryRun = false, log = logShim() }) {
  const { ok, problems, code, entries } = await inspectBundle(bundleDir);
  if (!ok) {
    throw new UhError(code || ERR.BUNDLE_INVALID, `the bundle failed verification (${problems.length} problem(s))`,
      { problems: problems.slice(0, 20) },
      'The bundle is corrupt, tampered with, or contains paths that are not permitted. Re-export it from a trusted source.');
  }

  // Never overwrite: compare (with `recordedRoot` normalised out) before writing.
  const conflicts = [];
  const toWrite = [];
  const skipped = [];
  for (const rel of entries.keys()) {
    const target = path.join(root, rel);
    const existing = readFileOrNull(target);
    if (existing === null) { toWrite.push(rel); continue; }
    const targetSha = sha256Bytes(normalizeForCompare(rel, existing));
    const incomingSha = sha256Bytes(normalizeForCompare(rel, readFileOrNull(path.join(bundleDir, rel))));
    if (targetSha === incomingSha) skipped.push(rel);
    else conflicts.push({ path: rel, existingSha256: targetSha, incomingSha256: incomingSha });
  }
  if (conflicts.length) {
    throw new UhError(ERR.IMPORT_CONFLICT,
      `${conflicts.length} file(s) already exist with different content`,
      { conflicts: conflicts.slice(0, 20), total: conflicts.length },
      'Import never overwrites. Rename or remove the listed target files, then re-run the import.');
  }

  if (dryRun) {
    log.info('import dry-run', { toWrite: toWrite.length, skipped: skipped.length });
    return { dryRun: true, toWrite, skipped, rootRederived: false };
  }

  const release = acquireWorkspaceLock(root, p, 'import');
  try {
    for (const rel of toWrite) {
      const target = path.join(root, rel);
      ensureDir(path.dirname(target));
      writeFileAtomicSync(target, readFileOrNull(path.join(bundleDir, rel)));
    }
  } finally { release(); }

  // A bundle never carries an absolute root; re-derive it for this machine.
  let rootRederived = false;
  if (entries.has(REGISTRY_REL)) {
    const regAbs = path.join(root, REGISTRY_REL);
    const buf = readFileOrNull(regAbs);
    if (buf) {
      try {
        const j = JSON.parse(buf.toString('utf8'));
        if (j && typeof j === 'object' && j.recordedRoot !== path.resolve(root)) {
          j.recordedRoot = path.resolve(root);
          writeFileAtomicSync(regAbs, `${JSON.stringify(j, null, 2)}\n`);
          rootRederived = true;
        }
      } catch { /* unreadable registry: leave it for `uh migrate` to handle */ }
    }
  }

  log.info('bundle imported', { files: toWrite.length, skipped: skipped.length, rootRederived });
  return { dryRun: false, toWrite, skipped, rootRederived };
}

// ---------------------------------------------------------------------------
// Locking
// ---------------------------------------------------------------------------

function lockPathFor(root, p) {
  const state = (p && p.state) || path.join(root, 'data', 'state');
  return path.join(state, 'locks', 'workspace.lock');
}

/** Take the advisory workspace lock, mapping lock failures to a workspace error. */
function acquireWorkspaceLock(root, p, purpose) {
  const lockPath = lockPathFor(root, p);
  ensureDir(path.dirname(lockPath));
  try {
    const handle = acquireLock(lockPath, { purpose });
    return () => { try { handle.release(); } catch { /* best effort */ } };
  } catch (err) {
    if (err && err.code === LOCK_CODE.WORKSPACE_LOCKED) {
      throw new UhError(ERR.WORKSPACE_LOCKED, 'the workspace is locked by another Universal Harness process',
        { path: lockPath }, 'Retry once the other command finishes, or run `uh doctor` if the lock looks stale.');
    }
    if (err && typeof err.code === 'string' && err.code.startsWith('LOCK_')) {
      throw new UhError(ERR.WORKSPACE_LOCKED, `the workspace lock could not be taken (${err.code})`,
        { path: lockPath }, err.action || 'Inspect the lock with `uh doctor`.');
    }
    throw err;
  }
}
