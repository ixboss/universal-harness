// Runtime manifest loading and validation.
//
// The manifest is the deterministic, auditable runtime pin (spec §4): it must
// answer "which exact dsh + Node am I executing?" without ambiguity. A manifest
// that fails validation is never used to execute anything.

import fs from 'node:fs';
import path from 'node:path';
import { UhError, ERR } from '../errors/mod.mjs';
import { SUPPORTED_TARGETS } from '../platform/mod.mjs';

const SCHEMA_VERSION = 1;
const HEX64 = /^[0-9a-f]{64}$/;
const SHA512 = /^sha512-[A-Za-z0-9+/]+={0,2}$/;

/**
 * Load and validate the runtime manifest.
 *
 * @param {string} manifestPath absolute path to manifests/runtime.manifest.json
 * @returns {Object} the parsed manifest (validated in place)
 */
export function loadManifest(manifestPath) {
  if (!fs.existsSync(manifestPath)) {
    throw new UhError(ERR.MANIFEST_MISSING,
      `runtime manifest not found at ${path.basename(manifestPath)}`,
      { manifestPath }, 'Restore the repository manifests/ directory.');
  }
  let raw;
  try { raw = fs.readFileSync(manifestPath, 'utf8'); }
  catch (e) { throw new UhError(ERR.MANIFEST_MALFORMED, 'manifest is not readable', { cause: e.message }); }
  let m;
  try { m = JSON.parse(raw); }
  catch (e) { throw new UhError(ERR.MANIFEST_MALFORMED, 'manifest is not valid JSON', { cause: e.message }); }

  assert(m && typeof m === 'object' && m.schemaVersion === SCHEMA_VERSION,
    `manifest.schemaVersion must be exactly ${SCHEMA_VERSION}`);
  assert(m.node && typeof m.node === 'object', 'manifest.node must be an object');
  assert(m.dsh && typeof m.dsh === 'object', 'manifest.dsh must be an object');

  for (const target of SUPPORTED_TARGETS) {
    const e = m.node[target];
    assert(e, `manifest.node[${target}] is missing`);
    assert(typeof e.version === 'string' && e.version.startsWith('v'),
      `manifest.node[${target}].version must be a vX.Y.Z string`);
    assert(/^(zip|tar\.(xz|gz))$/.test(e.format), `manifest.node[${target}].format must be zip/tar.xz/tar.gz`);
    assert(typeof e.url === 'string' && /^https:\/\//.test(e.url), `manifest.node[${target}].url must be https`);
    assert(typeof e.sha256 === 'string' && HEX64.test(e.sha256),
      `manifest.node[${target}].sha256 must be a 64-hex SHA-256`);
    assert(typeof e.checksumSource === 'string', `manifest.node[${target}].checksumSource is required`);
    assert(typeof e.extractedRoot === 'string' && e.extractedRoot.length > 0,
      `manifest.node[${target}].extractedRoot is required`);
    assert(typeof e.nodeRelPath === 'string' && e.nodeRelPath.length > 0,
      `manifest.node[${target}].nodeRelPath is required`);
  }

  const d = m.dsh;
  assert(typeof d.package === 'string' && d.package.startsWith('@deepseek-ai/'),
    'manifest.dsh.package must be the official @deepseek-ai/* package');
  assert(typeof d.version === 'string' && d.version.length > 0, 'manifest.dsh.version is required');
  assert(typeof d.registry === 'string' && /^https:\/\//.test(d.registry), 'manifest.dsh.registry must be https');
  assert(typeof d.integrity === 'string' && SHA512.test(d.integrity), 'manifest.dsh.integrity must be sha512-*');

  return m;

  function assert(cond, msg) {
    if (!cond) throw new UhError(ERR.MANIFEST_MALFORMED, msg, { manifestPath });
  }
}

/** Manifest node entry shape for tooling. */
export function nodeEntry(manifest, target) {
  const e = manifest.node[target];
  if (!e) throw new UhError(ERR.RUNTIME_ARCH_UNSUPPORTED,
    `no manifest entry for runtime target ${target}`,
    { target, supported: SUPPORTED_TARGETS },
    `This platform/architecture has no pinned runtime in the manifest; supported targets: ${SUPPORTED_TARGETS.join(', ')}.`);
  return e;
}

/** dsh entry shape for tooling. */
export function dshEntry(manifest) {
  return manifest.dsh;
}
