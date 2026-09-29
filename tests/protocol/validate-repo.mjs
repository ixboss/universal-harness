// Phase 0.1 repository validation:
//  1. all JSON Schemas parse
//  2. cross-schema $ref resolution + durability coverage (via lint-schemas)
//  3. markdown relative-link targets exist; anchors correspond to real headings
//  4. secret/credential scan of the whole tree
//  5. no implementation code beyond the schema linter (docs/schemas only)
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, extname, basename } from 'node:path';
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
const secretPatterns = [
  /-----BEGIN (EC |RSA |DSA |OPENSSH )?PRIVATE KEY-----/i,
  /(?:api[_-]?key|secret|password|token|passwd)\s*[:=]\s*['"][A-Za-z0-9_\-]{16,}['"]/i,
  /^[A-Za-z0-9+/]{40,}={0,2}$/m, // base64 blobs (very coarse; exclude json md only files below)
];
for (const f of allFiles) {
  const text = readFileSync(f, 'utf8');
  if (secretPatterns[0].test(text)) { console.log(`PRIVATE KEY MATERIAL: ${f}`); problems++; }
  if (secretPatterns[1].test(text)) { console.log(`ASSIGNED SECRET-like literal: ${f}`); problems++; }
}
// tokens/keys in filenames
for (const f of allFiles) {
  if (/\.(pem|key|p12|pfx|env)$/i.test(f)) { console.log(`SECRET-LIKE FILE: ${f}`); problems++; }
}

// --- 5. no implementation code beyond linter ---
const allowedExt = new Set(['.md', '.json']);
const allowedFiles = new Set([
  'tests/protocol/lint-schemas.mjs',
  'tests/protocol/validate-repo.mjs',
  '.gitignore',
  'LICENSE',
]);
for (const f of allFiles) {
  const ext = extname(f);
  if (!allowedExt.has(ext) && !allowedFiles.has(f)) {
    console.log(`UNEXPECTED IMPLEMENTATION FILE: ${f}`); problems++;
  }
}
// catch secrets-ignore hygiene: no .env/data dirs tracked
for (const f of allFiles) {
  if (f.startsWith('data/') || f.startsWith('logs/') || f.startsWith('.zcode/')) {
    console.log(`LEAKED WORKING STATE: ${f}`); problems++;
  }
}

console.log(`validation problems: ${problems}`);
process.exit(problems ? 1 : 0);
