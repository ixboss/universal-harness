// Phase 1 repository validation:
//  1. all JSON Schemas parse
//  2. cross-schema $ref resolution + durability coverage (via lint-schemas)
//  3. markdown relative-link targets exist; anchors correspond to real headings
//  4. secret/credential scan of the whole tree
//  5. implementation code only where it belongs (core/ bin/ tests/ manifests/),
//     and no generated/working-state directories tracked
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { execSync } from 'node:child_process';

const root = '.';
let problems = 0;

const allFiles = execSync('git ls-files', { encoding: 'utf8', cwd: root })
  .split('\n').filter(Boolean);
console.log(`tracked files: ${allFiles.length}`);

// --- 1. JSON schemas parse ---
const schemaDir = 'shared/protocol/v1';
for (const f of readdirSync(schemaDir).filter((x) => x.endsWith('.json'))) {
  try { JSON.parse(readFileSync(join(schemaDir, f), 'utf8')); } catch (e) {
    console.log(`SCHEMA PARSE FAIL: ${f}: ${e.message}`); problems++;
  }
}

// --- 2. cross-schema refs + durability (reuse the linter) ---
try {
  execSync('node tests/protocol/lint-schemas.mjs', { stdio: 'inherit', cwd: root });
} catch {
  console.log('LINTER FAILED'); problems++;
}

// --- 3. markdown link checking ---
// GitHub heading-anchor algorithm: lowercase, drop non [a-z0-9- ], each whitespace char -> '-'.
// Runs are NOT collapsed: "9. Doctor / diagnostics" -> "9-doctor--diagnostics".
const slug = (str) => str.toLowerCase()
  .replace(/[^\sa-z0-9-]/g, '')
  .replace(/\s/g, '-');

for (const f of allFiles.filter((f) => f.endsWith('.md'))) {
  const text = readFileSync(f, 'utf8');
  // capture path WITHOUT the anchor fragment
  const linkRe = /\[[^\]]*\]\(([^)#\s]+)(?:#([^)\s)]+))?\)/g;
  let m;
  while ((m = linkRe.exec(text))) {
    const target = m[1], anchor = m[2];
    if (/^(https?:|mailto:)/.test(target)) continue;
    const resolved = join(dirname(f), target);
    if (!existsSync(resolved)) {
      console.log(`BROKEN LINK: ${f} -> ${target}`); problems++;
      continue;
    }
    if (anchor) {
      const targetText = readFileSync(resolved, 'utf8');
      const targetAnchors = new Set(
        [...targetText.matchAll(/^#{2,6}\s+(.+)$/gm)].map((h) => slug(h[1].trim())),
      );
      if (!targetAnchors.has(anchor)) {
        console.log(`BROKEN ANCHOR: ${f} -> ${target}#${anchor}`); problems++;
      }
    }
  }
}

// --- 4. secret scan ---
// Lines marked `uh-secret-fixture` are deliberate inputs to the redaction tests (obviously
// non-real values like sk-deadbeef…); they are the reason the scanner exists, not a violation.
const secretPatterns = [
  /-----BEGIN (EC |RSA |DSA |OPENSSH )?PRIVATE KEY-----/i,
  /(?:api[_-]?key|secret|password|token|passwd)\s*[:=]\s*['"][A-Za-z0-9_\-]{16,}['"]/i,
];
for (const f of allFiles) {
  const lines = readFileSync(f, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('uh-secret-fixture')) continue;
    if (secretPatterns[0].test(lines[i]) || secretPatterns[1].test(lines[i])) {
      console.log(`SECRET-LIKE LITERAL: ${f}:${i + 1}`); problems++;
    }
  }
}
// tokens/keys in filenames
for (const f of allFiles) {
  if (/\.(pem|key|p12|pfx|env)$/i.test(f)) { console.log(`SECRET-LIKE FILE: ${f}`); problems++; }
}

// --- 5. implementation code lives where it belongs ---
// Phase 1 boundary: desktop portable core only. Implementation may live under core/, bin/,
// tests/, manifests/ (plus root package files). Anything else (android/, ios/, scripts/, stray
// platform code) is out of Phase 1 scope and must be flagged.
const implRoots = ['core/', 'bin/', 'tests/', 'manifests/'];
const allowedRootFiles = new Set(['package.json', '.gitignore', 'LICENSE', 'README.md',
  'THIRD_PARTY_NOTICES.md']);
const allowedExt = new Set(['.md', '.json', '.mjs', '.cmd', '.sh']);
for (const f of allFiles) {
  if (implRoots.some((p) => f.startsWith(p)) || allowedRootFiles.has(f)) continue;
  if (!allowedExt.has(extname(f))) {
    console.log(`UNEXPECTED FILE (outside core/bin/tests/manifests): ${f}`); problems++;
  }
}
// working state / generated trees must never be committed
const bannedPrefixes = ['data/', 'runtime/', 'diagnostics/', 'logs/', 'node_modules/',
  'cache/', 'state/', 'temp/', '.zcode/'];
for (const f of allFiles) {
  if (bannedPrefixes.some((p) => f.startsWith(p))) {
    console.log(`LEAKED WORKING STATE: ${f}`); problems++;
  }
}
// junk artifacts
for (const f of allFiles) {
  if (/\.(DS_Store|part|tmp|orig|log)$/.test(f) || f.endsWith('.mjs~')) {
    console.log(`JUNK ARTIFACT: ${f}`); problems++;
  }
}

console.log(`validation problems: ${problems}`);
process.exit(problems ? 1 : 0);
