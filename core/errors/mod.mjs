// Error categories, structured errors, and log/value redaction.
//
// Spec §16: every major failure carries a stable error code, a human-readable
// message, safe diagnostic context, and actionable recovery guidance. Secrets
// (API keys, tokens, private keys, credentials, sensitive env) never appear in
// errors or logs — enforced by the redactor used by both.

import path from 'node:path';

/** Stable error codes. Adding a code is a breaking change to the diagnostics
 *  surface; reuse `UH_INTERNAL` for genuinely novel failures. */
export const ERR = {
  UH_ROOT_NOT_FOUND: 'UH_ROOT_NOT_FOUND',
  UH_ROOT_INVALID: 'UH_ROOT_INVALID',
  MANIFEST_MISSING: 'MANIFEST_MISSING',
  MANIFEST_MALFORMED: 'MANIFEST_MALFORMED',
  MANIFEST_ENTRY_MISSING: 'MANIFEST_ENTRY_MISSING',
  RUNTIME_MISSING: 'RUNTIME_MISSING',
  RUNTIME_HASH_MISMATCH: 'RUNTIME_HASH_MISMATCH',
  RUNTIME_VERSION_MISMATCH: 'RUNTIME_VERSION_MISMATCH',
  RUNTIME_ARCH_UNSUPPORTED: 'RUNTIME_ARCH_UNSUPPORTED',
  DSH_MISSING: 'DSH_MISSING',
  DSH_VERSION_MISMATCH: 'DSH_VERSION_MISMATCH',
  DSH_START_FAILED: 'DSH_START_FAILED',
  DSH_INIT_FAILED: 'DSH_INIT_FAILED',
  DSH_PROTOCOL_ERROR: 'DSH_PROTOCOL_ERROR',
  DSH_TIMEOUT: 'DSH_TIMEOUT',
  DSH_ABNORMAL_EXIT: 'DSH_ABNORMAL_EXIT',
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  WORKSPACE_CONFLICT: 'WORKSPACE_CONFLICT',
  WORKSPACE_INVALID: 'WORKSPACE_INVALID',
  BACKUP_INVALID: 'BACKUP_INVALID',
  BACKUP_CONFLICT: 'BACKUP_CONFLICT',
  MIGRATION_REFUSED: 'MIGRATION_REFUSED',
  SECURE_STORAGE_UNAVAILABLE: 'SECURE_STORAGE_UNAVAILABLE',
  CANCELLED: 'CANCELLED',
  UH_INTERNAL: 'UH_INTERNAL',
};

/** High-level categories for tooling/UI. */
export const CATEGORY = {
  ENVIRONMENT: 'environment',
  RUNTIME: 'runtime',
  WORKSPACE: 'workspace',
  SESSION: 'session',
  ADAPTER: 'adapter',
  SECURITY: 'security',
  INTERNAL: 'internal',
  USER: 'user',
};

const CATEGORY_BY_CODE = {
  [ERR.UH_ROOT_NOT_FOUND]: CATEGORY.ENVIRONMENT,
  [ERR.UH_ROOT_INVALID]: CATEGORY.ENVIRONMENT,
  [ERR.MANIFEST_MISSING]: CATEGORY.RUNTIME,
  [ERR.MANIFEST_MALFORMED]: CATEGORY.RUNTIME,
  [ERR.MANIFEST_ENTRY_MISSING]: CATEGORY.RUNTIME,
  [ERR.RUNTIME_MISSING]: CATEGORY.RUNTIME,
  [ERR.RUNTIME_HASH_MISMATCH]: CATEGORY.RUNTIME,
  [ERR.RUNTIME_VERSION_MISMATCH]: CATEGORY.RUNTIME,
  [ERR.RUNTIME_ARCH_UNSUPPORTED]: CATEGORY.RUNTIME,
  [ERR.DSH_MISSING]: CATEGORY.RUNTIME,
  [ERR.DSH_VERSION_MISMATCH]: CATEGORY.RUNTIME,
  [ERR.DSH_START_FAILED]: CATEGORY.ADAPTER,
  [ERR.DSH_INIT_FAILED]: CATEGORY.ADAPTER,
  [ERR.DSH_PROTOCOL_ERROR]: CATEGORY.ADAPTER,
  [ERR.DSH_TIMEOUT]: CATEGORY.ADAPTER,
  [ERR.DSH_ABNORMAL_EXIT]: CATEGORY.ADAPTER,
  [ERR.SESSION_NOT_FOUND]: CATEGORY.SESSION,
  [ERR.WORKSPACE_CONFLICT]: CATEGORY.WORKSPACE,
  [ERR.WORKSPACE_INVALID]: CATEGORY.WORKSPACE,
  [ERR.BACKUP_INVALID]: CATEGORY.SECURITY,
  [ERR.BACKUP_CONFLICT]: CATEGORY.SECURITY,
  [ERR.MIGRATION_REFUSED]: CATEGORY.WORKSPACE,
  [ERR.SECURE_STORAGE_UNAVAILABLE]: CATEGORY.SECURITY,
  [ERR.CANCELLED]: CATEGORY.USER,
  [ERR.UH_INTERNAL]: CATEGORY.INTERNAL,
};

/**
 * Structured Universal Harness error.
 *
 * The `message` and `context` must be safe to print at any log level — the
 * redactor is still applied on the way out as defence in depth.
 */
export class UhError extends Error {
  /**
   * @param {string} code one of {@link ERR}
   * @param {string} message human-readable, secret-free
   * @param {Object} [context] safe diagnostic context (never secrets)
   * @param {string} [action] recovery guidance
   * @param {Error} [cause] original error
   */
  constructor(code, message, context, action, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'UhError';
    this.code = code;
    this.category = CATEGORY_BY_CODE[code] || CATEGORY.INTERNAL;
    this.context = context || {};
    this.action = action || defaultAction(code);
  }

  /** Machine + human readable single-line form. */
  toString() {
    const ctx = Object.keys(this.context).length
      ? ' ' + redact(JSON.stringify(this.context))
      : '';
    return `${this.code}: ${redact(this.message)}${ctx}${this.action ? ` (action: ${redact(this.action)})` : ''}`;
  }

  /** Structured JSON for logs/UI — already redacted. */
  toJSON() {
    return {
      name: this.name,
      code: this.code,
      category: this.category,
      message: redact(this.message),
      context: redactObject(this.context),
      action: redact(this.action || ''),
      cause: this.cause ? String(redact(this.cause.message || this.cause)) : undefined,
    };
  }
}

function defaultAction(code) {
  switch (code) {
    case ERR.UH_ROOT_NOT_FOUND: return 'Run from inside the UniversalHarness directory, or set UH_ROOT.';
    case ERR.MANIFEST_MISSING: return 'Restore the repository manifests/ directory; it is part of the shipped tree.';
    case ERR.RUNTIME_MISSING: return 'Run `uh setup` to install the pinned bundled runtime.';
    case ERR.RUNTIME_HASH_MISMATCH: return 'The bundled runtime archive is corrupted; delete runtime/ and re-run `uh setup`.';
    case ERR.RUNTIME_VERSION_MISMATCH: return 'Run `uh setup` to install the manifest-pinned Node version.';
    case ERR.RUNTIME_ARCH_UNSUPPORTED: return 'This platform/architecture has no manifest entry; see COMPATIBILITY.md.';
    case ERR.DSH_MISSING: return 'Run `uh setup` to install the pinned @deepseek-ai/dsh distribution.';
    case ERR.DSH_TIMEOUT: return 'Raise the timeout or check system load; a stuck dsh is force-killed after the bound.';
    case ERR.SECURE_STORAGE_UNAVAILABLE: return 'Store the secret in your OS credential store, or set it in the dsh credential file; never as plaintext in the portable tree.';
    default: return 'See docs/ for this error code.';
  }
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

const SECRET_PATTERNS = [
  /(?:api[_-]?key|secret|token|password|passwd|credential|auth|bearer)["' :=]*[A-Za-z0-9_\-./+]{20,}/gi,
  /\b(?:sk-[A-Za-z0-9]{20,})\b/g,                      // common provider key prefix
  /\b(?:Bearer\s+[A-Za-z0-9_\-./+]{16,})\b/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

const REPLACEMENT = '[REDACTED]';

/**
 * Redact secret-looking substrings from a value that is about to be logged or
 * shown in an error. This is defence in depth — callers must still not put
 * secrets into messages in the first place.
 *
 * @param {string} value
 * @returns {string}
 */
export function redact(value) {
  if (typeof value !== 'string') return value;
  let out = value;
  for (const re of SECRET_PATTERNS) out = out.replace(re, REPLACEMENT);
  return out;
}

/** Redact every string value in a plain object (shallow, non-mutating). */
export function redactObject(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = typeof v === 'string' ? redact(v)
      : v && typeof v === 'object' ? redactObject(v)
      : v;
  }
  return out;
}

const SENSITIVE_ENV = /^(DEEPSEEK_API_KEY|.*_API_KEY|.*_TOKEN|.*_SECRET|.*_PASSWORD|CREDENTIAL|AUTH|npm_config_.*_auth.*)$/i;

/**
 * Produce a safe copy of `process.env` for child processes: sensitive-looking
 * variables are passed through (the child needs them) but this function is
 * never used for logging. For logging use {@link describeEnvSafe}.
 *
 * @param {Record<string,string>} [extra]
 */
export function childEnv(extra) {
  return { ...process.env, ...(extra || {}) };
}

/** Safe, redacted summary of env variables that influence dsh. */
export function describeEnvSafe() {
  const names = Object.keys(process.env).filter((k) => SENSITIVE_ENV.test(k));
  const summary = {};
  for (const k of names) summary[k] = process.env[k] ? `${process.env[k].length} chars [REDACTED]` : '';
  if (process.env.DSH_HOME) summary.DSH_HOME = process.env.DSH_HOME;
  return { sensitive: names.length, detail: summary, platform: process.platform };
}

/** Redact a path's leaf so user directories are anonymised in diagnostics. */
export function redactPath(p) {
  if (typeof p !== 'string') return p;
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (home && p.toLowerCase().startsWith(String(home).toLowerCase())) {
    return path.join('~', path.relative(home, p));
  }
  return p;
}
