// Local, portable backup/restore for Universal Harness metadata (spec §13).
//
// Scope is deliberately small: versioned, integrity-checked copies of the UH
// metadata that lives in data/ (workspace registry + markers, configuration,
// migration history, session index). dsh's own session logs are not copied —
// they are dsh-owned and re-derived from $DSH_HOME.
//
// A backup is a directory containing the copied files plus manifest.json with
// a per-file SHA-256. Restore verifies the manifest first and refuses to
// overwrite *newer* state unless forced — never a blind overwrite.

import fs from 'node:fs';
import path from 'node:path';
import { sha256File, sha256Bytes } from '../integrity/mod.mjs';
import { UhError, ERR } from '../errors/mod.mjs';
import { ensureDir } from '../paths/mod.mjs';

const BACKUP_SCHEMA = 1;
const BACKED_UP = [
  { from: 'data/workspace/registry.json', to: 'workspace/registry.json' },
  { from: 'data/workspace/.workspace.json', to: 'workspace/.workspace.json' },
  { from: 'data/config/config.json', to: 'config/config.json' },
  { from: 'data/config/config.secure.json', to: 'config/config.secure.json' },
  { from: 'data/sessions/index.json', to: 'sessions/index.json' },
];

/**
 * Create a versioned backup.
 *
 * @param {Object} opts { root, p, label, log }
 * @returns {Promise<{ref:string, manifest:Object, files:string[]}>}
 */
export async function createBackup({ root, p, label, log = consoleShim() }) {
  const backupsDir = (p && p.backups) || path.join(root, 'data', 'backups');
  ensureDir(backupsDir);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const ref = `${ts}-${String(label || 'manual').replace(/[^a-z0-9._-]+/gi, '_').slice(0, 40)}`;
  const dir = path.join(backupsDir, ref);
  ensureDir(dir);

  const files = [];
  const manifest = { schemaVersion: BACKUP_SCHEMA, ref, createdAt: Date.now(), root: path.resolve(root), entries: [] };

  for (const { from, to } of BACKED_UP) {
    const src = path.join(root, from);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(dir, to);
    ensureDir(path.dirname(dst));
    fs.copyFileSync(src, dst);
    const sha = await sha256File(dst);
    manifest.entries.push({ from, to, sha256: sha, bytes: fs.statSync(dst).size });
    files.push(to);
  }
  manifest.checksum = sha256Bytes(JSON.stringify(manifest.entries));
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  log.info('backup created', { ref, files: files.length });
  return { ref, manifest, files };
}

/** List available backups (newest first). */
export function listBackups({ root, p }) {
  const dir = (p && p.backups) || path.join(root, 'data', 'backups');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const mp = path.join(dir, e.name, 'manifest.json');
      if (!fs.existsSync(mp)) return { ref: e.name, valid: false };
      try {
        const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
        return { ref: e.name, valid: true, createdAt: m.createdAt, files: m.entries?.length || 0, checksum: m.checksum };
      } catch { return { ref: e.name, valid: false }; }
    })
    .sort((a, b) => b.ref.localeCompare(a.ref));
}

/** Verify a backup's manifest against its files. */
export async function verifyBackup({ root, p, ref }) {
  const dir = backupDir(root, p, ref);
  const m = readManifest(dir);
  const problems = [];
  for (const e of m.entries) {
    const actual = await sha256File(path.join(dir, e.to));
    if (actual !== e.sha256) problems.push({ file: e.to, expected: e.sha256, actual });
  }
  const computed = sha256Bytes(JSON.stringify(m.entries));
  if (computed !== m.checksum) problems.push({ file: 'manifest.json', reason: 'checksum mismatch' });
  return { ref, ok: problems.length === 0, problems };
}

/**
 * Restore a backup. Never blind: refuses if the live workspace metadata is
 * newer than the backup unless `force` is set.
 *
 * @param {Object} opts { root, p, ref, force, log }
 */
export async function restoreBackup({ root, p, ref, force = false, log = consoleShim() }) {
  const dir = backupDir(root, p, ref);
  const m = readManifest(dir);
  const verification = await verifyBackup({ root, p, ref });
  if (!verification.ok) {
    throw new UhError(ERR.BACKUP_INVALID,
      `backup ${ref} failed integrity verification`,
      { problems: verification.problems.slice(0, 5) },
      'The backup is corrupted; choose another ref from `uh backup` history or restore from a second copy.');
  }

  // Newer-state guard: a live registry updated after the backup was taken is
  // not overwritten silently.
  const liveReg = path.join(root, 'data', 'workspace', 'registry.json');
  if (fs.existsSync(liveReg) && !force) {
    const liveMtime = fs.statSync(liveReg).mtimeMs;
    if (liveMtime > m.createdAt) {
      throw new UhError(ERR.BACKUP_CONFLICT,
        `live workspace metadata (updated ${new Date(liveMtime).toISOString()}) is newer than backup ${ref}`,
        { backupAt: new Date(m.createdAt).toISOString() },
        'Restore deliberately refuses to overwrite newer state. Re-run with --force only if the newer state is wrong.');
    }
  }

  for (const e of m.entries) {
    const dst = path.join(root, e.from);
    ensureDir(path.dirname(dst));
    fs.copyFileSync(path.join(dir, e.to), dst);
  }
  log.info('backup restored', { ref, files: m.entries.length });
  return { ref, restored: m.entries.map((e) => e.from) };
}

function backupDir(root, p, ref) {
  const dir = path.join((p && p.backups) || path.join(root, 'data', 'backups'), ref);
  if (!fs.existsSync(dir)) throw new UhError(ERR.BACKUP_INVALID, `backup ref not found: ${ref}`, { ref },
    'List available backups with `uh backup --list`.');
  return dir;
}

function readManifest(dir) {
  const mp = path.join(dir, 'manifest.json');
  if (!fs.existsSync(mp)) throw new UhError(ERR.BACKUP_INVALID, `backup has no manifest: ${path.basename(dir)}`, {},
    'The backup directory is incomplete; use another ref.');
  return JSON.parse(fs.readFileSync(mp, 'utf8'));
}
