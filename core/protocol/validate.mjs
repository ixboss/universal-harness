// Compact JSON Schema (draft 2020-12 subset) validator.
//
// Validates the Universal Protocol v1 contract in shared/protocol/v1/ at runtime:
// every envelope and payload is checked before the node acts on it. Supports the
// keywords the contract actually uses: type, const, enum, required, properties,
// additionalProperties, items, $ref (internal + cross-file), pattern, minimum/
// maximum, minLength/maxLength, minItems/maxItems, oneOf/anyOf/allOf, format
// (date-time only). Unknown keywords are ignored by design.

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

/**
 * Load every *.schema.json of a directory into a map keyed by file name, with
 * cross-file `$ref` resolved against the map (e.g. "identifiers.schema.json#/...").
 */
export function loadSchemaSet(dir) {
  const schemas = new Map();
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.schema.json'))) {
    schemas.set(f, JSON.parse(readFileSync(join(dir, f), 'utf8')));
  }
  return new Validator(schemas);
}

/**
 * Resolve a "$ref" fragment. Two forms appear in the contract:
 * "#/$defs/Name" (same document) and "other.schema.json#/$defs/Name" (cross-file).
 * Anchors (plain "#Name") are not used by the contract.
 */
function resolveRef(ref, current, schemas) {
  const [filePart, frag] = ref.split('#');
  const doc = filePart ? schemas.get(filePart) : current;
  if (!doc) throw new Error(`unknown schema document in $ref: ${ref}`);
  if (!frag || frag === '/' || frag === '') return doc;
  if (!frag.startsWith('/$defs/')) throw new Error(`unsupported $ref fragment: ${ref}`);
  const defName = frag.slice('/$defs/'.length);
  const def = (doc.$defs || {})[defName];
  if (!def) throw new Error(`unknown $ref target: ${ref}`);
  return def;
}

export class Validator {
  constructor(schemas) { this.schemas = schemas; }

  /** Validate `value` against a named schema document root. */
  validateDocument(name, value) {
    const doc = this.schemas.get(name);
    if (!doc) return { ok: false, error: `unknown schema document: ${name}` };
    return this.validate(value, doc, doc);
  }

  /** Validate against a `$defs` entry of a document: validateDef('events.schema.json', 'TaskLifecycleEvent', v). */
  validateDef(docName, defName, value) {
    const doc = this.schemas.get(docName);
    const def = doc?.$defs?.[defName];
    if (!def) return { ok: false, error: `unknown definition ${docName}#/${defName}` };
    return this.validate(value, def, doc);
  }

  /**
   * Validate against a schema node. Returns { ok, error }. On failure the error is a
   * short human message with a JSON pointer to the offending field.
   */
  validate(value, node, doc, path = '') {
    if (typeof node === 'boolean') {
      if (!node) return fail(path, 'schema denies this value');
      return OK;
    }
    if (!node || typeof node !== 'object') return OK;

    if (node.$ref) {
      const target = resolveRef(node.$ref, doc, this.schemas);
      return this.validate(value, target, target.$id ? target : doc, path);
    }

    if (node.allOf) {
      for (const sub of node.allOf) {
        const r = this.validate(value, sub, doc, path);
        if (!r.ok) return r;
      }
      return OK;
    }
    if (node.oneOf) {
      let matches = 0;
      let lastError = '';
      for (const sub of node.oneOf) {
        const r = this.validate(value, sub, doc, path);
        if (r.ok) matches++;
        else lastError = r.error;
      }
      if (matches !== 1) return fail(path, matches === 0 ? `matched none of oneOf (${lastError})` : 'matched multiple oneOf branches');
      return OK;
    }
    if (node.anyOf) {
      for (const sub of node.anyOf) {
        if (this.validate(value, sub, doc, path).ok) return OK;
      }
      return fail(path, 'matched none of anyOf');
    }

    if (node.const !== undefined) {
      if (!deepEqual(value, node.const)) return fail(path, `must equal ${JSON.stringify(node.const)}`);
    }
    if (node.enum !== undefined) {
      if (!node.enum.some((v) => deepEqual(value, v))) return fail(path, `must be one of ${JSON.stringify(node.enum)}`);
    }

    if (node.type !== undefined) {
      const types = Array.isArray(node.type) ? node.type : [node.type];
      if (!types.some((t) => typeMatches(value, t))) return fail(path, `expected type ${types.join('|')}, got ${actualType(value)}`);
    }

    switch (actualType(value)) {
      case 'string': {
        if (node.minLength !== undefined && value.length < node.minLength) return fail(path, `shorter than minLength ${node.minLength}`);
        if (node.maxLength !== undefined && value.length > node.maxLength) return fail(path, `longer than maxLength ${node.maxLength}`);
        if (node.pattern !== undefined && !new RegExp(node.pattern).test(value)) return fail(path, `does not match pattern ${node.pattern}`);
        if (node.format === 'date-time' && !DATE_TIME_RE.test(value)) return fail(path, 'not a valid RFC 3339 date-time');
        if (node.format === 'hex64' && !/^[0-9a-f]{64}$/.test(value)) return fail(path, 'not 64 lowercase hex chars');
        break;
      }
      case 'integer': {
        if (node.minimum !== undefined && value < node.minimum) return fail(path, `less than minimum ${node.minimum}`);
        if (node.maximum !== undefined && value > node.maximum) return fail(path, `greater than maximum ${node.maximum}`);
        break;
      }
      case 'array': {
        if (node.minItems !== undefined && value.length < node.minItems) return fail(path, `fewer than minItems ${node.minItems}`);
        if (node.maxItems !== undefined && value.length > node.maxItems) return fail(path, `more than maxItems ${node.maxItems}`);
        if (node.items !== undefined) {
          for (let i = 0; i < value.length; i++) {
            const r = this.validate(value[i], node.items, doc, `${path}/${i}`);
            if (!r.ok) return r;
          }
        }
        break;
      }
      case 'object': {
        if (node.required) {
          for (const key of node.required) {
            if (!(key in value)) return fail(path, `missing required property "${key}"`);
          }
        }
        const props = node.properties || {};
        for (const key of Object.keys(value)) {
          if (!(key in props)) {
            if (node.additionalProperties === false) return fail(path, `additional property "${key}" not allowed`);
            if (node.additionalProperties && typeof node.additionalProperties === 'object') {
              const r = this.validate(value[key], node.additionalProperties, doc, `${path}/${key}`);
              if (!r.ok) return r;
            }
            continue;
          }
          const r = this.validate(value[key], props[key], doc, path ? `${path}/${key}` : key);
          if (!r.ok) return r;
        }
        break;
      }
      default:
        break;
    }
    return OK;
  }
}

const OK = { ok: true, error: null };
function fail(path, message) { return { ok: false, error: path ? `${path}: ${message}` : message }; }

function actualType(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}
function typeMatches(v, t) {
  if (t === 'integer') return Number.isInteger(v);
  if (t === 'number') return typeof v === 'number' && !Number.isNaN(v);
  if (t === 'array') return Array.isArray(v);
  if (t === 'object') return typeof v === 'object' && v !== null && !Array.isArray(v);
  if (t === 'null') return v === null;
  return typeof v === t;
}
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  if (typeof a === 'object') {
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

/** Load the bundled contract relative to this module (repo layout independent). */
export function bundledSchemas() {
  const here = dirname(fileURLToPath(import.meta.url));
  // core/protocol/validate.mjs -> ../../shared/protocol/v1
  return loadSchemaSet(join(here, '..', '..', 'shared', 'protocol', 'v1'));
}
