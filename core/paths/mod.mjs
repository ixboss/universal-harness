// Portable path ownership for Universal Harness.
//
// Rules enforced here (spec §5/§6):
//   - the root is *detected* (marker file walk), never assumed by drive letter;
//   - everything the user may move between machines is stored *relative* to the
//     root, as portable (POSIX-separated) relative strings;
//   - device-bound state is resolved from the OS user directory, not the root.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { deviceStateDir, PLATFORM } from '../platform/mod.mjs';

/** Files that identify a Universal Harness root directory (any one suffices). */
export const ROOT_MARKERS = ['bin/uh.mjs', 'manifests/runtime.manifest.json'];

/**
 * Detect the Universal Harness root above `start` (defaults to cwd).
 *
 * Walks upward until a directory contains one of {@link ROOT_MARKERS}. An
 * explicit `UH_ROOT` override is honoured first (it must still be validated by
 * the caller — see {@link validateRoot}).
 *
 * @param {string} [start] directory to start searching from
 * @returns {string|null} absolute root path, or null if not found
 */
export function findRoot(start = process.cwd()) {
  const override = process.env.UH_ROOT;
  if (override) return path.resolve(override);

  let dir = path.resolve(start);
  // Guard against an infinite loop on POSIX roots.
  for (let i = 0; i < 64; i++) {
    if (ROOT_MARKERS.some((m) => fs.existsSync(path.join(dir, m)))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/**
 * Validate that a candidate directory is a usable Universal Harness root:
 * readable, writable, and containing the launcher tree.
 *
 * @param {string} root absolute path
 * @returns {{ok:boolean, problems:string[]}}
 */
export function validateRoot(root) {
  const problems = [];
  if (!root || !path.isAbsolute(root)) problems.push(`root is not an absolute path: ${root}`);
  if (!fs.existsSync(root)) problems.push(`root does not exist: ${root}`);
  else {
    for (const m of ['bin', 'core', 'manifests']) {
      if (!fs.existsSync(path.join(root, m))) problems.push(`missing expected directory: ${m}/`);
    }
    // Writable check — a read-only drive must be reported, not silently worked around.
    const probe = path.join(root, '.uh-write-probe');
    try {
      fs.writeFileSync(probe, '');
      fs.unlinkSync(probe);
    } catch (err) {
      problems.push(`root is not writable (${err.code || err.message})`);
    }
  }
  return { ok: problems.length === 0, problems };
}

/**
 * Portable root state. All derived paths hang off this object so that a moved
 * workspace can be re-resolved by calling {@link portablePaths} again with the
 * new root and rewriting only the stored relative strings.
 *
 * @typedef {Object} PortablePaths
 * @property {string} root absolute root
 * @property {string} data data/
 * @property {string} projects data/projects/
 * @property {string} sessions data/sessions/
 * @property {string} config data/config/
 * @property {string} workspace data/workspace/
 * @property {string} backups data/backups/
 * @property {string} logs data/logs/
 * @property {string} manifests manifests/
 * @property {string} runtime runtime/
 * @property {string} runtimeNode runtime/node/<target>/
 * @property {string} runtimeDsh runtime/dsh/
 * @property {string} diagnostics diagnostics/
 * @property {string} device device-bound state directory (never on the drive)
 */

/**
 * Resolve all portable paths for a root.
 *
 * @param {string} [root] root path; auto-detected when omitted
 * @returns {PortablePaths}
 */
export function portablePaths(root = findRoot()) {
  if (!root) throw new UhPathError('UH_ROOT_NOT_FOUND',
    'Universal Harness root could not be detected from the current directory.',
    'Run this command from inside the UniversalHarness directory, or set UH_ROOT to its location.');
  const data = path.join(root, 'data');
  return {
    root,
    data,
    projects: path.join(data, 'projects'),
    sessions: path.join(data, 'sessions'),
    config: path.join(data, 'config'),
    workspace: path.join(data, 'workspace'),
    backups: path.join(data, 'backups'),
    logs: path.join(data, 'logs'),
    manifests: path.join(root, 'manifests'),
    runtime: path.join(root, 'runtime'),
    runtimeNode: path.join(root, 'runtime', 'node'),
    runtimeDsh: path.join(root, 'runtime', 'dsh'),
    diagnostics: path.join(root, 'diagnostics'),
    device: deviceStateDir(),
  };
}

/**
 * Convert an absolute path inside the root into a portable relative string.
 * Portable strings always use POSIX separators so a workspace moved between
 * Windows and Linux records the same value.
 *
 * @param {string} root absolute root
 * @param {string} abs absolute path (may be outside the root)
 * @returns {string|null} relative path like `data/projects/a`, or null if outside
 */
export function toPortableRelative(root, abs) {
  const rel = path.relative(path.resolve(root), path.resolve(abs));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

/**
 * Resolve a portable relative string against a root (accepts both separators).
 *
 * @param {string} root absolute root
 * @param {string} rel portable relative path
 * @returns {string} absolute path
 */
export function resolvePortable(root, rel) {
  return path.resolve(root, String(rel).split('/').join(path.sep));
}

/** True when a stored relative string is still resolvable under `root`. */
export function relativeExists(root, rel) {
  return fs.existsSync(resolvePortable(root, rel));
}

/**
 * Device-bound subpaths. Each is a distinct ownership class (spec §5).
 *
 * @param {PortablePaths} p portable paths
 */
export function devicePaths(p) {
  return {
    root: p.device,
    secure: path.join(p.device, 'secure'),   // OS-protected blobs, e.g. DPAPI
    identity: path.join(p.device, 'identity'), // future node identity keys
    cache: path.join(p.device, 'cache'),
  };
}

/** Ensure a directory exists (mkdir -p), returning whether it was created. */
export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return fs.existsSync(dir);
}

/** Version of the root-relative layout, bumped on any breaking layout change. */
export const LAYOUT_VERSION = 1;

class UhPathError extends Error {
  constructor(code, message, action) {
    super(message);
    this.name = 'UhPathError';
    this.code = code;
    this.action = action;
  }
}
export { UhPathError };
