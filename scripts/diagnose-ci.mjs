// scripts/diagnose-ci.mjs — fast CI-facing doctor subset.
//
// Runs the checks that are meaningful in a CI container (no runtime download,
// no network): repo validation, manifest integrity, config parse, protocol
// schema lint. Exits 1 with the first failure category on any problem.
//
// Zero dependencies; runs on the bundled portable Node.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = [];

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}\n`);
}

// 1. Repo validation (schemas, links, secret scan, layout).
{
  const res = spawnSync(process.execPath, [path.join(REPO, 'tests', 'protocol', 'validate-repo.mjs')], { cwd: REPO, encoding: 'utf8' });
  record('validate-repo', res.status === 0, res.status === 0 ? '' : (res.stdout + res.stderr).slice(-600));
}

// 2. Runtime manifest parses and covers all pinned targets.
try {
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO, 'manifests', 'runtime.manifest.json'), 'utf8'));
  const targets = Object.keys(manifest.node || {});
  record('runtime manifest', targets.length >= 4, `targets: ${targets.join(', ')}`);
  record('dsh pin', Boolean(manifest.dsh?.integrity), manifest.dsh?.version || '');
} catch (e) {
  record('runtime manifest', false, e.message);
}

// 3. Protocol schemas parse.
try {
  const dir = path.join(REPO, 'shared', 'protocol', 'v1');
  const schemas = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  for (const f of schemas) JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  record('protocol schemas', schemas.length >= 6, `${schemas.length} files`);
} catch (e) {
  record('protocol schemas', false, e.message);
}

// 4. Core modules import cleanly (the cheapest full-graph check).
try {
  const url = (rel) => new URL(pathToFileURL(path.join(REPO, rel)));
  await import(url('core/adapter/registry.mjs'));
  await import(url('core/executor/mod.mjs'));
  await import(url('core/server/mod.mjs'));
  record('core imports', true);
} catch (e) {
  record('core imports', false, e.message);
}

const failed = results.filter((r) => !r.ok);
process.stdout.write(`\ndiagnose-ci: ${results.length - failed.length}/${results.length} checks passed\n`);
process.exit(failed.length ? 1 : 0);
