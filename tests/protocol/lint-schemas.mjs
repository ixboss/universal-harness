// Phase 0.1 schema linter:
//  1. Verifies every cross-file $ref across the JSON Schema contract resolves.
//  2. Verifies every EventKind in the enum is mapped to exactly one DurabilityClass
//     (machine-readable durability contract).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = 'shared/protocol/v1';
const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
const docs = Object.fromEntries(
  files.map((f) => [f, JSON.parse(readFileSync(join(dir, f), 'utf8'))]),
);

const base = (s) => s.replace(/#.*$/, '');
const tail = (s) => (s.includes('#') ? s.split('#')[1].replace(/^\//, '') : '');

let refs = 0;
let problems = 0;

// --- check 1: cross-schema $ref resolution ---
for (const f of files) {
  const walk = (node, path) => {
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (k === '$ref' && typeof v === 'string' && !v.startsWith('https://')) {
          refs++;
          const targetFile = base(v) || f;
          const frag = tail(v);
          if (!docs[targetFile]) {
            console.log(`DANGLING file: ${v} (in ${f} at ${path})`);
            problems++;
          } else if (frag) {
            const parts = frag.split('/').filter(Boolean);
            let cur = docs[targetFile];
            for (const p of parts) cur = cur == null ? undefined : cur[p];
            if (cur === undefined) {
              console.log(`DANGLING ref: ${v} (in ${f} at ${path})`);
              problems++;
            }
          }
        } else {
          walk(v, `${path}/${k}`);
        }
      }
    }
  };
  walk(docs[f], '');
}

// --- check 2: EventDurability covers every EventKind exactly once ---
const events = docs['events.schema.json'];
const kinds = events.$defs.EventKind.enum;
const durability = events.$defs.EventDurability;
const mapped = Object.keys(durability.properties || {});
for (const kind of kinds) {
  if (!mapped.includes(kind)) {
    console.log(`DURABILITY GAP: event kind '${kind}' has no DurabilityClass mapping`);
    problems++;
  }
}
for (const key of mapped) {
  if (!kinds.includes(key)) {
    console.log(`DURABILITY ORPHAN: '${key}' mapped but not an EventKind`);
    problems++;
  }
}
if (durability.required && durability.required.length !== mapped.length) {
  console.log('DURABILITY: required list must cover every mapped property');
  problems++;
}

console.log(`files: ${files.length}, refs checked: ${refs}, problems: ${problems}`);
process.exit(problems ? 1 : 0);
