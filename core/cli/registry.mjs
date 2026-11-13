// CLI registry commands: workspace, session, migrate, backup, restore.
// These own no execution logic — they format the state managed by the core
// modules for the command line.

import fs from 'node:fs';
import path from 'node:path';
import { createWorkspaceStore } from '../workspace/mod.mjs';
import { createSessionStore } from '../sessions/mod.mjs';
import { createBackup, listBackups, verifyBackup, restoreBackup } from '../backup/mod.mjs';
import { exportWorkspace, importBundle, verifyBundle } from '../bundle/mod.mjs';
import { checkMove, applyMigration, migrationHistory, validateMigration } from '../migration/mod.mjs';
import { redact } from '../errors/mod.mjs';
import { listAdapters } from '../adapter/registry.mjs';
import os from 'node:os';

/** `uh adapters` — list the registered harness adapters and the active one. */
export async function cmdAdapters(args, { root, p, log }) {
  let active = null;
  try {
    const { createConfig } = await import('../config/mod.mjs');
    active = createConfig({ root, p }).load()?.adapter?.harness || 'deepseek';
  } catch { active = 'deepseek'; }
  console.log('registered harness adapters:');
  for (const a of listAdapters()) {
    const flag = a.id === active ? '  [active]' : '';
    console.log(`  ${a.id.padEnd(18)} ${a.kind.padEnd(14)} ${a.label}${flag}`);
    console.log(`      ${a.description}`);
  }
  console.log(`\nselect with \`uh serve --adapter <id>\`, UH_ADAPTER, or data/config/config.json (adapter.harness).`);
  return 0;
}

export async function cmdWorkspace(args, { root, p, log }) {
  const store = createWorkspaceStore({ root, p, log });
  const sub = args[0] || 'list';
  if (sub === 'init') {
    const name = args[1] || path.basename(path.resolve(root));
    const marker = store.init({ label: name, force: args.includes('--force') });
    console.log(`workspace initialized: ${marker.id} (${marker.label})`);
    return 0;
  }
  if (sub === 'list' || sub === 'show') {
    const marker = store.loadMarker();
    if (!marker) { console.log('no workspace initialized; run `uh workspace init`.'); return 1; }
    console.log(`workspace ${marker.id}  label: ${marker.label}  created: ${new Date(marker.createdAt).toISOString()}`);
    const projects = store.listProjects();
    if (!projects.length) console.log('  (no projects registered)');
    for (const proj of projects) {
      console.log(`  ${proj.exists ? 'ok  ' : 'MISS'} ${proj.name}  ${proj.relPath}  id=${proj.id}`);
    }
    return 0;
  }
  if (sub === 'project') {
    const name = args[1];
    if (!name) { console.log('usage: uh workspace project <name>'); return 2; }
    const rec = store.registerProject({ name });
    console.log(`project registered: ${rec.name} -> ${rec.relPath} (id ${rec.id})`);
    return 0;
  }
  console.log('usage: uh workspace init|list|show|project <name>');
  return 2;
}

export async function cmdSession(args, { root, p, log }) {
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const sessions = createSessionStore({ dshHome, log });
  const sub = args[0] || 'list';
  if (sub === 'list') {
    const all = sessions.list();
    if (!all.length) { console.log(`no dsh sessions found under ${dshHome}`); return 0; }
    for (const s of all) {
      const flag = s.incomplete ? ' [INCOMPLETE]' : '';
      console.log(`${s.id}  ${s.eventCount} events  v${s.formatVersion}${flag}`);
      console.log(`    cwd: ${s.cwd}`);
      console.log(`    modified: ${new Date(s.modifiedAt).toISOString()}  turns: ${s.turnCount}`);
    }
    return 0;
  }
  if (sub === 'show' || sub === 'replay') {
    const id = args[1];
    if (!id) { console.log('usage: uh session show <id>'); return 2; }
    const events = sessions.replay(id);
    console.log(`session ${id}: ${events.length} durable events`);
    for (const e of events.slice(0, 60)) {
      const data = e.data ? ' ' + JSON.stringify(redactObject(e.data)).slice(0, 120) : '';
      console.log(`  seq ${e.seq ?? '?'} ${e.type}${data}`);
    }
    if (events.length > 60) console.log(`  … ${events.length - 60} more`);
    return 0;
  }
  console.log('usage: uh session list|show <id>');
  return 2;
}

export async function cmdMigrate(args, { root, p, log }) {
  const store = createWorkspaceStore({ root, p, log });
  const sub = args[0] || 'check';
  if (sub === 'check') {
    const { moved, from, to } = checkMove(store);
    if (!moved) { console.log('workspace root unchanged; nothing to migrate.'); return 0; }
    const v = validateMigration(store, { to });
    console.log(`workspace moved:\n  from: ${from}\n  to:   ${to}`);
    console.log(`validation: ${v.ok ? 'OK' : 'REFUSED'}${v.problems.length ? ` (${v.problems.join('; ')})` : ''}`);
    return v.ok ? 0 : 1;
  }
  if (sub === 'apply') {
    const res = await applyMigration({ store, root, p, log });
    if (!res.moved) { console.log(res.note); return 0; }
    console.log(`migrated ${res.from} -> ${res.to}\nbackup point: ${res.backupRef}\nhistory id: ${res.id}`);
    return 0;
  }
  if (sub === 'history') {
    const hist = migrationHistory({ p });
    if (!hist.length) { console.log('no migrations recorded.'); return 0; }
    for (const h of hist) console.log(`${h.at}  ${h.from} -> ${h.to}  (backup ${h.backupRef})`);
    return 0;
  }
  console.log('usage: uh migrate check|apply|history');
  return 2;
}

export async function cmdBackup(args, { root, p, log }) {
  if (args.includes('--list') || args[0] === 'list') {
    const list = listBackups({ root, p });
    if (!list.length) { console.log('no backups yet.'); return 0; }
    for (const b of list) console.log(`${b.ref}  ${b.valid ? 'valid' : 'INVALID'}  ${b.files} files`);
    return 0;
  }
  const label = args.find((a) => !a.startsWith('-')) || 'manual';
  const res = await createBackup({ root, p, label, log });
  console.log(`backup created: ${res.ref} (${res.files.length} files)`);
  return 0;
}

export async function cmdRestore(args, { root, p, log }) {
  const ref = args.find((a) => !a.startsWith('-'));
  if (!ref) { console.log('usage: uh restore <ref> [--force]  (refs: uh backup --list)'); return 2; }
  const force = args.includes('--force');
  const v = await verifyBackup({ root, p, ref });
  if (!v.ok) { console.log(`backup ${ref} FAILED verification: ${JSON.stringify(v.problems.slice(0, 3))}`); return 1; }
  try {
    const res = await restoreBackup({ root, p, ref, force, log });
    console.log(`restored ${ref}: ${res.restored.join(', ')}`);
    return 0;
  } catch (e) {
    console.log(`${e.code || 'ERROR'}: ${e.message}`);
    if (e.action) console.log(`action: ${e.action}`);
    return 1;
  }
}

function redactObject(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = typeof v === 'string' ? redact(v)
      : v && typeof v === 'object' ? redactObject(v)
      : v;
  }
  return out;
}

/** Read a `--flag value` or `--flag=value` option from an argv slice. */
function flagValue(args, name) {
  const i = args.indexOf(name);
  if (i >= 0 && i + 1 < args.length && !args[i + 1].startsWith('-')) return args[i + 1];
  const eq = args.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : null;
}

export async function cmdExport(args, { root, p, log }) {
  if (args[0] === 'verify') {
    const bundle = flagValue(args, '--bundle') || args[1];
    if (!bundle) { console.log('usage: uh export verify <dir>'); return 2; }
    const v = await verifyBundle({ bundleDir: path.resolve(bundle) });
    console.log(`bundle ${v.ok ? 'OK' : 'INVALID'}: ${v.manifest?.totals?.files ?? '?'} file(s)`);
    for (const problem of v.problems.slice(0, 10)) console.log(`  ${problem.reason}: ${problem.message}`);
    return v.ok ? 0 : 1;
  }
  const out = flagValue(args, '--out') || args.find((a) => !a.startsWith('-'));
  if (!out) { console.log('usage: uh export --out <dir> [--include-projects] [--force]'); return 2; }
  try {
    const res = await exportWorkspace({
      root, p, outDir: path.resolve(out),
      includeProjects: args.includes('--include-projects'),
      force: args.includes('--force'),
      log,
    });
    console.log(`exported ${res.manifest.totals.files} file(s), ${res.manifest.totals.bytes} bytes -> ${res.out}`);
    return 0;
  } catch (e) {
    console.log(`${e.code || 'ERROR'}: ${e.message}`);
    if (e.action) console.log(`action: ${e.action}`);
    return 1;
  }
}

export async function cmdImport(args, { root, p, log }) {
  const bundle = flagValue(args, '--bundle') || args.find((a) => !a.startsWith('-'));
  if (!bundle) { console.log('usage: uh import --bundle <dir> [--dry-run]'); return 2; }
  try {
    const res = await importBundle({ root, p, bundleDir: path.resolve(bundle), dryRun: args.includes('--dry-run'), log });
    if (res.dryRun) {
      console.log(`dry-run: would write ${res.toWrite.length} file(s), skip ${res.skipped.length} identical`);
    } else {
      console.log(`imported: wrote ${res.toWrite.length} file(s), skipped ${res.skipped.length} identical${res.rootRederived ? ', recorded root re-derived' : ''}`);
    }
    return 0;
  } catch (e) {
    console.log(`${e.code || 'ERROR'}: ${e.message}`);
    for (const c of (e.context && e.context.conflicts) || []) console.log(`  conflict: ${c.path}`);
    for (const pr of (e.context && e.context.problems) || []) console.log(`  problem: ${pr.message || pr.reason}`);
    if (e.action) console.log(`action: ${e.action}`);
    return 1;
  }
}
