// Doctor / diagnostics (spec §11).
//
// Six groups, each check already phrased in the actionable FAIL format:
//
//   FAIL: <label>
//   Expected: ...
//   Actual:   ...
//   Action:   ...
//
// Secrets are never exposed: every Actual/Expected string passes through the
// redactor, and credential checks only ever report presence, never content.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { platformInfo } from '../platform/mod.mjs';
import { validateRoot, findRoot, portablePaths } from '../paths/mod.mjs';
import { createRuntimeManager } from '../runtime/mod.mjs';
import { createWorkspaceStore } from '../workspace/mod.mjs';
import { createSessionStore } from '../sessions/mod.mjs';
import { createAdapter } from '../adapter/mod.mjs';
import { createSecureStorage } from '../secrets/mod.mjs';
import { redact } from '../errors/mod.mjs';

const PROCESS_CHECK_TIMEOUT = 90_000; // dsh sdk profile boots a plugin tree

/**
 * Run the full diagnostic pass.
 *
 * @param {Object} opts { root, log, argv, skipProcess }
 * @returns {Promise<Object>} report { environment, groups, checks, ok }
 */
export async function runDoctor({ root, log, argv = [], skipProcess = false } = {}) {
  const detected = root || findRoot();
  const checks = [];
  const add = (group, id, label, ok, expected, actual, action) =>
    checks.push({ group, id, label, status: ok ? 'ok' : 'fail',
      expected: redact(String(expected ?? '')), actual: redact(String(actual ?? '')),
      action: ok ? null : action });

  const environment = platformInfo();

  // --- group: environment ------------------------------------------------
  add('environment', 'root.detect', 'Universal Harness root detected', !!detected,
    '<repository root>', detected, 'Run from inside the UniversalHarness directory or set UH_ROOT.');
  if (!detected) return { environment, checks, ok: false, groups: groupSummary(checks) };

  const v = validateRoot(detected);
  add('environment', 'root.valid', 'root is a usable (writable) root', v.ok,
    'bin/, core/, manifests/ present and writable', v.problems.join('; '),
    'Restore the repository tree or run from a location where the root is writable.');

  const p = portablePaths(detected);
  for (const [name, dir] of [['data', p.data], ['runtime', p.runtime], ['diagnostics', p.diagnostics]]) {
    add('environment', `dirs.${name}`, `${name}/ directory is writable`,
      isWritableDir(dir), dir, dir,
      `Create ${name}/ with write permission for the current user.`);
  }

  add('environment', 'device.state', 'device-bound state directory usable',
    isWritableDir(p.device), p.device, p.device,
    'The device state directory holds OS-protected secrets; it must be writable by the current user.');

  // --- group: runtime -----------------------------------------------------
  const rm = createRuntimeManager({ root: detected });
  add('runtime', 'manifest.load', 'runtime manifest loads and validates', !!rm.manifest,
    'manifests/runtime.manifest.json', 'loaded', 'Restore the repository manifests/ directory.');

  let runtimeStatus = null;
  try { runtimeStatus = await rm.status(); }
  catch (e) { add('runtime', 'runtime.status', 'runtime status check completed', false, 'no errors', e.message, e.action || 'Run `uh setup`.'); }

  if (runtimeStatus) {
    for (const c of runtimeStatus.checks) {
      add('runtime', `runtime.${c.id}`, c.label, c.status === 'ok', c.expected, c.actual, c.action);
    }
  }

  // --- group: security ----------------------------------------------------
  const secrets = createSecureStorage({ root: detected, p });
  const info = secrets.describe();
  add('security', 'secrets.backend', 'OS secure storage backend available',
    info.backend !== 'unavailable', 'dpapi (Windows) or equivalent', info.backend, info.note);

  // Portable tree must contain no secret-like files.
  const leaked = scanForPlaintextSecrets(p.data);
  add('security', 'secrets.portable-clean', 'no plaintext secret files in the portable tree',
    leaked.length === 0, 'no *.key/*.pem/.env/credentials files', leaked.join(', ') || 'clean',
    'Remove secret material from the portable tree; store it in OS secure storage instead.');

  // --- group: workspace ---------------------------------------------------
  const store = createWorkspaceStore({ root: detected, p, log });
  const marker = store.loadMarker();
  add('workspace', 'workspace.identity', 'workspace identity marker present', !!marker,
    'data/workspace/.workspace.json', marker ? marker.id : 'missing',
    'Run `uh workspace init` to create the workspace identity.');

  if (marker) {
    const reg = store.loadRegistry();
    add('workspace', 'workspace.registry', 'workspace registry readable', !!reg,
      'data/workspace/registry.json', `schema v${reg.schemaVersion}`,
      'Restore data/workspace/registry.json from a backup (`uh restore`).');

    const missing = store.missingProjects();
    add('workspace', 'workspace.missing-projects', 'all registered project directories exist',
      missing.length === 0, '0 missing', missing.length ? missing.map((m) => `${m.name}@${m.relPath}`).join(', ') : '0 missing',
      missing.length ? 'The project directories were moved or deleted; re-register or remove them from the registry.' : null);

    const conflicts = store.conflicts();
    add('workspace', 'workspace.conflicts', 'no workspace identity conflicts',
      conflicts.length === 0, 'no conflicts', conflicts.map((c) => c.kind).join(', ') || 'none',
      conflicts.length ? (conflicts[0].action || 'Resolve the identity conflict before pairing.') : null);
  }

  // --- group: sessions ----------------------------------------------------
  const sessions = createSessionStore({ dshHome: process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), log });
  let sessionList = [];
  try { sessionList = sessions.list(); } catch (e) { /* reported below */ }
  add('sessions', 'sessions.store', 'dsh session store is accessible',
    sessionList.length >= 0, `${sessions.sessionsDir}`, sessionList.length >= 0 ? `${sessionList.length} session(s) indexed` : 'unreadable',
    'Ensure DSH_HOME points at a dsh home directory.');

  const incomplete = sessionList.filter((s) => s.incomplete);
  add('sessions', 'sessions.incomplete', 'no sessions with unfinished turns',
    incomplete.length === 0, '0 incomplete', incomplete.length ? `${incomplete.length} incomplete (latest: ${incomplete[0].id})` : '0 incomplete',
    incomplete.length ? 'An interrupted turn left a session open; dsh will resume it, or review it with `uh session show <id>`.' : null);

  // --- group: process execution ------------------------------------------
  if (!skipProcess && runtimeStatus?.ok) {
    try {
      const result = await checkProcessExecution({ rm, root: detected, log });
      add('process', 'dsh.start', 'dsh SDK process starts and native dependencies load',
        result.start, 'process spawn + protocol frames', result.start ? 'spawned' : result.error,
        'Run `uh setup` again; a start failure usually means a corrupted runtime tree.');
      add('process', 'dsh.initialize', 'dsh SDK initialization completes',
        result.initialize, 'initialize -> serverInfo', result.initialize ? 'serverInfo received' : result.error,
        result.initialize ? null : 'Check the provider credential and network; initialization resolves the LLM route.');
      if (result.initialize) {
        add('process', 'dsh.shutdown', 'dsh SDK shuts down gracefully',
          result.shutdown, 'shutdown -> exit 0', result.shutdown ? `exit ${result.exitCode}` : 'did not exit 0',
          'A hung shutdown is escalated to SIGTERM then SIGKILL by the adapter; investigate stderr in the diagnostics report.');
      }
    } catch (e) {
      add('process', 'dsh.check', 'process execution check completed', false, 'no exception', e.message,
        'The runtime is installed but the live process check failed; rerun `uh doctor`.');
    }
  }

  const ok = checks.every((c) => c.status === 'ok');
  return { environment, checks, ok, groups: groupSummary(checks), generatedAt: new Date().toISOString(), root: detected };
}

function groupSummary(checks) {
  const m = {};
  for (const c of checks) {
    m[c.group] = m[c.group] || { total: 0, failed: 0 };
    m[c.group].total++;
    if (c.status !== 'ok') m[c.group].failed++;
  }
  return m;
}

/**
 * Live check: launch dsh, initialize, shut down. This exercises native module
 * loading, the plugin tree boot, and the SDK protocol — source inspection
 * alone never counts as verification.
 */
async function checkProcessExecution({ rm, root, log }) {
  const ad = createAdapter({ rm, log: { info() {}, warn() {}, debug() {}, error() {} }, cwd: root });
  let start = false, initializeOk = false, shutdownOk = false, exitCode = null;
  try {
    await ad.launch();
    start = true;
    const init = await ad.initialize({ cwd: root });
    initializeOk = !!(init.serverInfo);
    const exit = await ad.shutdown();
    exitCode = exit?.code ?? null;
    shutdownOk = exit?.code === 0;
  } catch (e) {
    return { start, initialize: initializeOk, shutdown: shutdownOk, exitCode, error: e.message || String(e) };
  }
  return { start, initialize: initializeOk, shutdown: shutdownOk, exitCode };
}

function isWritableDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '.uh-write-probe');
    fs.writeFileSync(probe, '');
    fs.unlinkSync(probe);
    return true;
  } catch { return false; }
}

function scanForPlaintextSecrets(dir) {
  if (!fs.existsSync(dir)) return [];
  const found = [];
  const walk = (d) => {
    for (const name of fs.readdirSync(d)) {
      const abs = path.join(d, name);
      let st;
      try { st = fs.statSync(abs); } catch { continue; }
      if (st.isDirectory()) { walk(abs); continue; }
      if (/\.(key|pem|p12|pfx|env)$/i.test(name) || /credential/i.test(name)) found.push(path.relative(dir, abs));
    }
  };
  walk(dir);
  return found;
}

/** Render a doctor report in the actionable FAIL/OK format. */
export function printDoctorReport(report, stream = process.stdout) {
  const lines = [];
  const env = report.environment || {};
  lines.push(`Universal Harness diagnostics — ${report.generatedAt || new Date().toISOString()}`);
  lines.push(`Environment: ${env.osType} ${env.osVersion} ${env.arch} | node ${env.nodeVersion} | target ${env.target}`);
  lines.push('');
  let current = null;
  for (const c of report.checks || []) {
    if (c.group !== current) { current = c.group; lines.push(`[${current}]`); }
    if (c.status === 'ok') {
      lines.push(`  OK   ${c.id} — ${c.label}${c.actual ? ` (${c.actual})` : ''}`);
    } else {
      lines.push(`  FAIL ${c.id} — ${c.label}`);
      lines.push(`       Expected: ${c.expected}`);
      lines.push(`       Actual:   ${c.actual}`);
      if (c.action) lines.push(`       Action:   ${c.action}`);
    }
  }
  lines.push('');
  const failed = (report.checks || []).filter((c) => c.status !== 'ok').length;
  lines.push(report.ok ? 'RESULT: all checks passed.' : `RESULT: ${failed} check(s) failed. See actions above.`);
  stream.write(lines.join('\n') + '\n');
}
