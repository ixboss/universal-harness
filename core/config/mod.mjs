// Configuration (spec §15).
//
// Two ownership classes, kept strictly apart:
//
//  - Portable configuration (data/config/config.json): workspace preferences,
//    runtime channel selection, UI prefs, non-secret provider configuration.
//    Travels with the drive.
//
//  - Device-local secure configuration (via core/secrets, stored under the OS
//    user directory with Windows DPAPI or an explicit failure): API keys,
//    private keys, future pairing secrets. NEVER in the portable tree, NEVER
//    plaintext.
//
// If OS secure storage is unavailable for the current platform, setSecret
// fails explicitly with SECURE_STORAGE_UNAVAILABLE rather than falling back to
// plaintext — per the hard rule in the Phase 1 brief.

import fs from 'node:fs';
import path from 'node:path';
import { UhError, ERR, redact } from '../errors/mod.mjs';
import { ensureDir } from '../paths/mod.mjs';
import { writeFileAtomicSync } from '../portable/mod.mjs';
import { createSecureStorage } from '../secrets/mod.mjs';

const CONFIG_SCHEMA = 1;
export const DEFAULT_CONFIG = {
  schemaVersion: CONFIG_SCHEMA,
  runtime: { channel: 'pinned', preferBundledNode: true },
  workspace: { defaultLabel: null },
  adapter: {
    // The active harness adapter (Multi-Harness registry, core/adapter/
    // registry.mjs): deepseek | omniroute | openai-compatible | claude-code |
    // gemini-cli. Resolved per serve/exec: --adapter flag > UH_ADAPTER env >
    // this value.
    harness: 'deepseek',
    // Launch-time fallbacks tried in order when the active adapter cannot
    // start (router down, CLI missing). Empty = fail the task as before.
    harnessChain: [],
    provider: 'deepseek-official',
    model: 'deepseek-official',
    reasoningEffort: null,
    maxTokens: null,
    timeouts: {},
    // Per-harness settings (overridden by UH_OMNIROUTE_* / UH_OPENAI_* /
    // UH_CLAUDE_* / UH_GEMINI_* environment variables).
    omniroute: { baseUrl: null, model: null, apiKeyRef: null },
    openaiCompatible: { baseUrl: null, model: null, apiKeyRef: null },
    claudeCode: { command: null, args: null },
    geminiCli: { command: null, args: null },
  },
  // Bounded connection management for the network listener (Phase 3C). The
  // defaults keep room for several legitimate LAN controllers while capping
  // the established-stream surface; idleTimeoutMs reaps a connection silent
  // in BOTH directions for the whole window (an observing controller that is
  // receiving events is never idle).
  server: {
    maxConnections: 32,
    idleTimeoutMs: 300000,
  },
  logging: { level: 'info' },
};

/**
 * @param {Object} opts { root, p, dshHome }
 */
export function createConfig({ root, p }) {
  const configDir = (p && p.config) || path.join(root, 'data', 'config');
  const configPath = path.join(configDir, 'config.json');
  ensureDir(configDir);
  const secrets = createSecureStorage({ root, p });

  function load() {
    if (!fs.existsSync(configPath)) return structuredClone(DEFAULT_CONFIG);
    try {
      const user = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      return merge(structuredClone(DEFAULT_CONFIG), user);
    } catch (e) {
      throw new UhError(ERR.UH_INTERNAL, `portable config is unreadable: ${e.message}`, { configPath },
        'Fix or delete data/config/config.json; defaults apply after deletion.');
    }
  }

  function save(patch) {
    const next = merge(load(), patch);
    next.schemaVersion = CONFIG_SCHEMA;
    // Canonical helper: process-qualified temp + fsync, so `uh config set`
    // cannot collide with a concurrent process writing the same file.
    writeFileAtomicSync(configPath, JSON.stringify(next, null, 2));
    return next;
  }

  /**
   * Store a secret in the OS secure store. Never writes the portable tree and
   * never falls back to plaintext.
   */
  async function setSecret(name, value) {
    if (typeof value !== 'string' || value.length === 0) throw new UhError(ERR.UH_INTERNAL, 'secret value must be a non-empty string');
    await secrets.set(name, value);
    return { name, stored: true, at: secrets.locationDescription() };
  }

  async function getSecret(name) { return secrets.get(name); }
  async function deleteSecret(name) { return secrets.remove(name); }
  function secretBackendInfo() { return secrets.describe(); }

  return { load, save, setSecret, getSecret, deleteSecret, secretBackendInfo, configPath };
}

/** Deep merge for plain objects: user keys are layered over defaults at any
 * depth (arrays are replaced wholesale), so `{"adapter":{"omniroute":
 * {"baseUrl":"…"}}}` no longer wipes the rest of the omniroute section, and
 * unknown user keys survive for forward compatibility. */
function merge(base, user) {
  if (!user || typeof user !== 'object') return base;
  const out = Array.isArray(base) && Array.isArray(user) ? [...user]
    : { ...base };
  for (const [k, v] of Object.entries(user)) {
    const b = base?.[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && b && typeof b === 'object' && !Array.isArray(b)) {
      out[k] = merge(b, v);
    } else {
      out[k] = v;
    }
  }
  return out;
}
