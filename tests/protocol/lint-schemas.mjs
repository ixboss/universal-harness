// Phase 0 schema linter: verifies cross-file $ref targets resolve.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = 'shared/protocol/v1';
const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
const docs = Object.fromEntries(
  files.map((f) => [f, JSON.parse(readFileSync(join(dir, f), 'utf8'))]),
);

const strip = (s) => s.replace(/^#\//, '');
const base = (s) => s.replace(/#.*$/, '');
const tail = (s) => (s.includes('#') ? s.split('#')[1].replace(/^\//, '') : '');

let refs = 0;
let problems = 0;

for (const f of files) {
  const walk = (node, path) => {
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (k === '$ref' && typeof v === 'string' && !v.startsWith('https://')) {
          refs++;
          const targetFile = base(v);
          const frag = tail(v);
          // resolve #/$defs/X within same doc, or "file.schema.json#/$defs/X"
          const t = targetFile || f;
          if (!docs[t]) {
            console.log(`DANGLING file: ${v} (in ${f} at ${path})`);
            problems++;
          } else if (frag) {
            // frag like "$defs/NodeId"
            const parts = frag.split('/').filter(Boolean);
            let cur = docs[t];
            for (const p of parts) {
              cur = cur == null ? undefined : cur[p];
            }
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

console.log(`files: ${files.length}, refs checked: ${refs}, problems: ${problems}`);
process.exit(problems ? 1 : 0);
