#!/usr/bin/env node
// Universal Harness command line (Phase 1: desktop portable core).
//
// This file is executed by the *bundled* Node runtime — never by a system
// node. The shims UniversalHarness.cmd / UniversalHarness.sh locate the
// bundled binary so no global Node/npm/pnpm/Python/Git is required (spec §3).

import { findRoot, validateRoot, portablePaths } from '../core/paths/mod.mjs';
import { createLogger } from '../core/logging/mod.mjs';
import { UhError } from '../core/errors/mod.mjs';
import { setupRuntime } from '../core/runtime/setup.mjs';
import { runDoctor, printDoctorReport } from '../core/diagnostics/mod.mjs';
import { cmdExec, cmdSmoke, cmdRuntime } from '../core/cli/modes.mjs';
import { cmdWorkspace, cmdSession, cmdMigrate, cmdBackup, cmdRestore } from '../core/cli/registry.mjs';

const USAGE = `Universal Harness — desktop portable core (Phase 1)

Usage: uh <command> [args]

Commands:
  setup                 download + verify the pinned Node bundle and dsh distribution
  doctor                run environment/runtime/workspace/session diagnostics
  runtime status        show the exact Node + dsh versions in use
  workspace <sub>       workspace registry: list | show <id> | init [name]
  session <sub>         session index: list | show <id>
  exec "<prompt>"       one-shot: launch dsh SDK, initialize, prompt, stream, complete
  smoke                 full §18 chain incl. shutdown, restart, reopen and replay
  migrate check|apply   detect a moved workspace root and migrate safely
  backup [label]        create a versioned backup of Universal Harness metadata
  restore <label>       restore metadata backup (conflict-checked, never blind)
  version               show version + pinned runtime manifest summary

Environment:
  UH_ROOT               override the detected root directory
  UH_HOME               override the portable home (data/) directory
  DSH_HOME              passed through to dsh (its credential/session store)
  UH_LOG_LEVEL          debug | info | warn | error
`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    process.stdout.write(USAGE);
    return 0;
  }
  if (cmd === 'version') {
    const pkg = await import('../package.json', { with: { type: 'json' } }).catch(() => null);
    process.stdout.write(`Universal Harness ${pkg?.default?.version ?? 'dev'}\n`);
    return 0;
  }

  const root = findRoot();
  if (!root) {
    process.stderr.write('UH_ROOT_NOT_FOUND: run from inside the UniversalHarness directory or set UH_ROOT.\n');
    return 12;
  }
  const v = validateRoot(root);
  if (!v.ok) {
    process.stderr.write(`UH_ROOT_INVALID: ${v.problems.join('; ')}\n`);
    return 12;
  }

  const log = createLogger({ level: process.env.UH_LOG_LEVEL || 'info' }).child({ cmd });
  const p = portablePaths(root);

  try {
    switch (cmd) {
      case 'setup': {
        const res = await setupRuntime({ root, force: rest.includes('--force'), log });
        printDoctorReport({ checks: res.status.checks }, process.stdout);
        return res.status.ok ? 0 : 1;
      }
      case 'doctor': {
        const report = await runDoctor({ root, log, argv: rest });
        printDoctorReport(report, process.stdout);
        writeDiagnostics(report, p);
        return report.ok ? 0 : 1;
      }
      case 'runtime': return await cmdRuntime(rest, { root, p, log });
      case 'workspace': return await cmdWorkspace(rest, { root, p, log });
      case 'session': return await cmdSession(rest, { root, p, log });
      case 'migrate': return await cmdMigrate(rest, { root, p, log });
      case 'backup': return await cmdBackup(rest, { root, p, log });
      case 'restore': return await cmdRestore(rest, { root, p, log });
      case 'exec': return await cmdExec(rest, { root, p, log });
      case 'smoke': return await cmdSmoke(rest, { root, p, log });
      default:
        process.stderr.write(`unknown command: ${cmd}\n\n${USAGE}`);
        return 2;
    }
  } catch (err) {
    const e = err instanceof UhError ? err
      : new UhError('UH_INTERNAL', err?.message || String(err), {}, undefined, err);
    log.error('command failed', { code: e.code, ...e.toJSON(), stack: process.env.UH_DEBUG ? err?.stack : undefined });
    process.stderr.write(`${e.toString()}\n`);
    return 1;
  }
}

function writeDiagnostics(report, p) {
  try {
    fs.mkdirSync(p.diagnostics, { recursive: true });
    const file = `doctor-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    const abs = path.join(p.diagnostics, file);
    fs.writeFileSync(abs, JSON.stringify(report, null, 2));
    process.stdout.write(`\nDiagnostics written to ${path.join('diagnostics', file)}\n`);
  } catch { /* diagnostics must never crash the CLI */ }
}

import fs from 'node:fs';
import path from 'node:path';

main().then((code) => process.exit(code)).catch((e) => {
  process.stderr.write(`UH_INTERNAL: ${e?.stack || e}\n`);
  process.exit(1);
});
