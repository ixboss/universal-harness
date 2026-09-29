// Portable migration foundation (spec §14).
//
// Migration is *detected*, never automatic: when the workspace root moved
// (D:\UniversalHarness -> E:\UniversalHarness, or a POSIX path change), the
// registry's stored relative paths still resolve, but the recorded absolute
// root disagrees with the current one. Migration:
//   1. detects the path change;
//   2. validates the new root;
//   3. creates a backup point of the metadata *before* any change;
//   4. updates only the derived absolute root (stable ids untouched);
//   5. records the migration in a durable history;
//   6. refuses to run when the new root is invalid or a conflict is present.
//
// What cannot be migrated (documented, not guessed): absolute paths baked into
// third-party stores outside this tree (e.g. $DSH_HOME session logs embed their
// original cwd in the immutable session header — those headers are dsh-owned
// and left untouched; dsh re-keys them by workspace directory, not by us).

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { UhError, ERR } from '../errors/mod.mjs';
import { validateRoot, ensureDir } from '../paths/mod.mjs';
import { createBackup } from '../backup/mod.mjs';

/**
 * Detect a moved workspace.
 *
 * @param {Object} store workspace store
 * @returns {{moved:boolean, from:string|null, to:string|null}}
 */
export function checkMove(store, { root } = {}) {
  const reg = store.loadRegistry();
  // Resolve against the workspace root, not the process cwd: migration is
  // about where the tree lives, not where the command was invoked.
  const to = path.resolve(root || store.root || process.cwd());
  const from = reg.recordedRoot || null;
  const moved = !!(from && from.toLowerCase() !== to.toLowerCase());
  return { moved, from, to };
}

/**
 * Verify a migration is safe before touching anything.
 */
export function validateMigration(store, { to }) {
  const problems = [];
  const v = validateRoot(to);
  problems.push(...v.problems);
  const conflicts = store.conflicts();
  if (conflicts.length) {
    problems.push(`identity conflict: ${conflicts.map((c) => c.kind).join(', ')}`);
  }
  return { ok: problems.length === 0, problems, conflicts };
}

/**
 * Apply the migration. Always non-destructive: a backup point is created first
 * and the old registry is preserved inside it.
 *
 * @param {Object} opts { store, root, p, log, force }
 * @returns {Object} migration record
 */
export async function applyMigration({ store, root, p, log = consoleShim(), force = false }) {
  const { moved, from, to } = checkMove(store, { root });
  if (!moved) return { moved: false, note: 'workspace root unchanged; nothing to migrate' };

  const validation = validateMigration(store, { to });
  if (!validation.ok && !force) {
    throw new UhError(ERR.MIGRATION_REFUSED,
      'migration refused: new root failed validation',
      { problems: validation.problems },
      'Fix the reported problems (writable root, identity conflicts) or run on a healthy copy of the workspace.');
  }

  // 3. backup point before changing anything.
  const backup = await createBackup({ root, p, label: `migration-${Date.now()}`, log });

  // 4. update derived root only; stable ids are untouched.
  const reg = store.loadRegistry();
  const previousRoot = reg.recordedRoot;
  reg.recordedRoot = to;
  store.save(reg);

  // 5. durable history.
  const histDir = path.join(p.data, 'migration');
  ensureDir(histDir);
  const record = {
    id: randomUUID(),
    at: new Date().toISOString(),
    from: previousRoot,
    to,
    backupRef: backup.ref,
    schemaVersion: store.loadRegistry().schemaVersion,
  };
  fs.writeFileSync(path.join(histDir, `${record.id}.json`), JSON.stringify(record, null, 2));

  log.info('workspace migrated', { from, to, backup: backup.ref });
  return { moved: true, from, to, backupRef: backup.ref, id: record.id };
}

/** Read the migration history (most recent first). */
export function migrationHistory({ p }) {
  const dir = path.join(p.data, 'migration');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
    .sort((a, b) => (b.at || '').localeCompare(a.at || ''));
}
