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
import { createSecureStorage } from '../secrets/mod.mjs';

const CONFIG_SCHEMA = 1;
export const DEFAULT_CONFIG = {
  schemaVersion: CONFIG_SCHEMA,
  runtime: { channel: 'pinned', preferBundledNode: true },
  workspace: { defaultLabel: null },
  adapter: {
    provider: 'deepseek-official',
    model: 'deepseek-official',
    reasoningEffort: null,
    maxTokens: null,
    timeouts: {},
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
    const tmp = `${configPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, configPath);
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

/** Shallow-ish merge that keeps unknown user keys (forward compatibility). */
function merge(base, user) {
  if (!user || typeof user !== 'object') return base;
  const out = { ...base, ...user };
  for (const [k, v] of Object.entries(base)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && user[k] && typeof user[k] === 'object') {
      out[k] = { ...v, ...user[k] };
    }
  }
  return out;
}
