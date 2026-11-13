// scripts/verify-licenses.mjs — fail the build on unrecorded third-party
// components (risk R-08).
//
// Checks:
//   1. Every pinned runtime record in manifests/runtime.manifest.json (node
//      targets + the dsh package) is referenced in THIRD_PARTY_NOTICES.md.
//   2. Every vendored component actually present on disk (runtime/dsh, the
//      dsh transitive dependencies, android/third_party) is recorded.
//   3. The upstream import record (Mobile-Harness snapshot commit) is present.
//
// Zero dependencies; runs on the bundled portable Node.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const notices = fs.readFileSync(path.join(REPO, 'THIRD_PARTY_NOTICES.md'), 'utf8').toLowerCase();
const problems = [];
const check = (ok, label) => { if (!ok) problems.push(label); };

function recorded(needle) {
  return notices.includes(needle.toLowerCase());
}

// 1. Manifest records.
const manifest = JSON.parse(fs.readFileSync(path.join(REPO, 'manifests', 'runtime.manifest.json'), 'utf8'));
for (const [target, spec] of Object.entries(manifest.node || {})) {
  check(recorded('v' + spec.version?.replace(/^v/, '')) || recorded(spec.version), `node runtime ${target} (${spec.version}) not recorded in THIRD_PARTY_NOTICES.md`);
}
const dsh = manifest.dsh || {};
check(recorded(dsh.package || '@deepseek-ai/dsh'), `dsh package (${dsh.package}) not recorded`);

// 2. Vendored components present on disk must be recorded.
function exists(rel) { return fs.existsSync(path.join(REPO, rel)); }

// dsh transitive dependencies listed in the notices.
for (const dep of ['koffi', 'node-pty', '@google/genai', 'protobufjs', 'fflate', 'zod']) {
  if (exists(path.join('runtime', 'dsh', 'node_modules', dep))) {
    check(recorded(dep), `vendored dsh dependency "${dep}" present on disk but not recorded`);
  }
}

// Android third_party vendored trees.
const tpDir = path.join(REPO, 'android', 'third_party');
if (fs.existsSync(tpDir)) {
  for (const name of fs.readdirSync(tpDir)) {
    if (name.startsWith('.')) continue;
    check(recorded(name), `vendored android/third_party/${name} not recorded`);
  }
}
check(recorded('PRoot'), 'PRoot record missing');
check(recorded('GPL-2.0'), 'PRoot GPL-2.0 record missing');

// 3. Upstream import record.
check(recorded('techjarves/mobile-harness'), 'upstream Mobile-Harness import record missing');

if (problems.length) {
  process.stderr.write(`verify-licenses: ${problems.length} problem(s):\n${problems.map((p) => `  - ${p}`).join('\n')}\n`);
  process.exit(1);
}
process.stdout.write(`verify-licenses: all third-party components are recorded in THIRD_PARTY_NOTICES.md\n`);
