// Universal Harness — the workspace/project file API (brief §12; PROTOCOL §7).
//
// This layer sits above the Phase 1 workspace store (core/workspace), which
// owns the project registry. It adds:
//   - schema-shaped project ids (proj_<32hex>) derived deterministically from
//     the registry's own ids, so the registry format is untouched;
//   - path-safe file browse/read/write, the security boundary for §12.
//
// Path safety is enforced BEFORE any filesystem access. Every client-supplied
// path is rejected when it is absolute, traverses upward (..), uses a Windows
// drive/UNC form, escapes via a symlink, or contains a NUL byte or control
// characters. POSIX and Windows spellings are both handled because a client's
// platform need not match the node's.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { sha256Hex } from '../protocol/mod.mjs';

const MAX_PATH_LEN = 1024;
const MAX_FILE_BYTES = 8 * 1024 * 1024; // protocol read/write ceiling for v1

export function createWorkspaceApi({ root, p, store, log = null }) {
  const projectsDir = p.projects || path.join(root, 'data', 'projects');

  /** Deterministic, stable, schema-conformant id from the registry's own id. */
  function toProjectId(registryId) {
    return 'proj_' + sha256Hex(String(registryId)).slice(0, 32);
  }
  function fromProjectId(projectId) {
    const reg = store.loadRegistry();
    const entry = (reg.projects || []).find((x) => toProjectId(x.id) === projectId);
    return entry || null;
  }

  function projectDir(entry) {
    return path.resolve(root, entry.relPath);
  }

  // ---------------------------------------------------------------- projects
  function listProjects() {
    return store.listProjects().map((x) => ({
      projectId: toProjectId(x.id),
      name: x.name,
      path: x.relPath || null,
      missing: !x.exists,
    }));
  }

  function createProject({ name, path: externalPath = null }) {
    if (!name || typeof name !== 'string') throw new ApiError('INVALID_MESSAGE', 'project name is required');
    // The registry stores workspace locations relative to the portable root;
    // an absolute external binding is out of scope for v1 (PROTOCOL §12).
    let relPath = null;
    if (externalPath) {
      const checked = safeRelativeOnly(externalPath);
      relPath = checked;
    }
    const record = store.registerProject({ name, relPath });
    return {
      projectId: toProjectId(record.id),
      name: record.name,
      workspacePath: projectDir(registryEntry(record.id)),
    };
  }

  function registryEntry(id) {
    const reg = store.loadRegistry();
    return (reg.projects || []).find((x) => x.id === id) || null;
  }

  function openProject(projectId) {
    const entry = fromProjectId(projectId);
    if (!entry) return { ok: false, code: 'NOT_FOUND', reason: 'unknown project id' };
    const dir = projectDir(entry);
    if (!fs.existsSync(dir)) return { ok: false, code: 'WORKSPACE_UNAVAILABLE', reason: 'project directory is absent from the drive' };
    return { ok: true, projectId, name: entry.name, workspacePath: dir };
  }

  function requireProject(projectId) {
    const opened = openProject(projectId);
    if (!opened.ok) throw new ApiError(opened.code, opened.reason);
    return opened;
  }

  // ------------------------------------------------------------------ files
  function browse({ projectId, path: rel = null }) {
    const { workspacePath } = requireProject(projectId);
    const target = safeResolve(workspacePath, rel);
    let entries;
    try {
      entries = fs.readdirSync(target, { withFileTypes: true });
    } catch (e) {
      throw new ApiError('NOT_FOUND', `cannot browse: ${e.message}`);
    }
    return {
      entries: entries.map((e) => {
        let size = null, modifiedAt = null;
        try {
          const st = fs.statSync(path.join(target, e.name));
          size = st.size;
          modifiedAt = st.mtime.toISOString();
        } catch {}
        return {
          name: e.name,
          kind: e.isSymbolicLink() ? 'symlink' : e.isDirectory() ? 'directory' : 'file',
          size,
          modifiedAt,
        };
      }),
    };
  }

  function read({ projectId, path: rel }) {
    const { workspacePath } = requireProject(projectId);
    const target = safeResolve(workspacePath, rel);
    let content, st;
    try {
      st = fs.statSync(target);
      if (!st.isFile()) throw new ApiError('INVALID_MESSAGE', 'path is not a regular file');
      if (st.size > MAX_FILE_BYTES) throw new ApiError('INVALID_MESSAGE', `file exceeds the ${MAX_FILE_BYTES}-byte read ceiling`);
      content = fs.readFileSync(target, 'utf8');
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw new ApiError('NOT_FOUND', `cannot read: ${e.message}`);
    }
    const versionIndex = loadVersionIndex(workspacePath);
    const key = toKey(rel);
    const record = versionIndex[key];
    return {
      content,
      version: record ? record.version : 0,
      hash: sha256Hex(content),
      modifiedAt: st.mtime.toISOString(),
    };
  }

  function write({ projectId, path: rel, content, baseHash = null, overwrite = false }) {
    const { workspacePath } = requireProject(projectId);
    const target = safeResolve(workspacePath, rel);
    if (typeof content !== 'string') throw new ApiError('INVALID_MESSAGE', 'content must be a string');
    if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) {
      throw new ApiError('INVALID_MESSAGE', `content exceeds the ${MAX_FILE_BYTES}-byte write ceiling`);
    }
    const versionIndex = loadVersionIndex(workspacePath);
    const key = toKey(rel);

    // Optimistic concurrency (PROTOCOL §7): compare against the current file.
    // Every filesystem failure below is mapped to a protocol error — raw errno
    // codes must never surface as the envelope's error code.
    let current = null;
    try {
      const st = fs.statSync(target);
      if (!st.isFile()) throw new ApiError('INVALID_MESSAGE', 'target is not a regular file');
      current = fs.readFileSync(target, 'utf8');
    } catch (e) {
      if (e instanceof ApiError) throw e;
      if (e.code === 'ENOENT') current = null; // raced away between stat and read: treat as create
      else throw new ApiError('WORKSPACE_UNAVAILABLE', `cannot inspect the existing file: ${e.message}`);
    }
    if (current !== null && !overwrite) {
      const currentHash = sha256Hex(current);
      if (baseHash !== currentHash) {
        throw new ApiError('CONFLICT', 'the file changed since your last read', {
          data: { hash: currentHash, version: (versionIndex[key] || {}).version || 0 },
        });
      }
    }
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      atomicWrite(target, content);
    } catch (e) {
      throw new ApiError('WORKSPACE_UNAVAILABLE', `cannot write the file: ${e.message}`);
    }

    const next = (versionIndex[key] ? versionIndex[key].version : 0) + 1;
    versionIndex[key] = { version: next, hash: sha256Hex(content), modifiedAt: new Date().toISOString() };
    try {
      saveVersionIndex(workspacePath, versionIndex);
    } catch (e) {
      throw new ApiError('WORKSPACE_UNAVAILABLE', `cannot update the version index: ${e.message}`);
    }
    return { version: next, hash: versionIndex[key].hash };
  }

  const VERSIONS_FILE = '.uh-file-versions.json';
  function loadVersionIndex(workspacePath) {
    const file = path.join(workspacePath, VERSIONS_FILE);
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
  }
  function saveVersionIndex(workspacePath, index) {
    atomicWrite(path.join(workspacePath, VERSIONS_FILE), index);
  }
  function toKey(rel) {
    return String(rel || '').replace(/\\/g, '/');
  }

  return {
    listProjects,
    createProject,
    openProject,
    browse,
    read,
    write,
    toProjectId,
    /** Diagnostics: never exposes file contents. */
    describe() {
      return { projects: listProjects().length, projectsDir };
    },
  };
}

export class ApiError extends Error {
  constructor(code, message, { data = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.apiCode = code; // a protocol ErrorCode
    this.data = data;
  }
}

// ---------------------------------------------------------------- path safety

/**
 * Accept a client-supplied project path only when it is relative and stays
 * inside the portable root. Absolute/UNC/drive forms are rejected.
 */
export function safeRelativeOnly(clientPath) {
  const raw = String(clientPath || '');
  if (!raw) throw new ApiError('INVALID_MESSAGE', 'empty project path');
  if (raw.length > MAX_PATH_LEN) throw new ApiError('INVALID_MESSAGE', 'path too long');
  if (raw.includes('\0')) throw new ApiError('INVALID_MESSAGE', 'path contains a NUL byte');
  const forward = raw.replace(/\\/g, '/');
  if (forward.startsWith('/')) throw new ApiError('INVALID_MESSAGE', 'absolute paths are not permitted');
  if (/^[A-Za-z]:/.test(raw)) throw new ApiError('INVALID_MESSAGE', 'drive-letter paths are not permitted');
  if (raw.startsWith('\\\\') || raw.startsWith('//')) throw new ApiError('INVALID_MESSAGE', 'UNC paths are not permitted');
  const segments = forward.split('/').filter((s) => s.length > 0);
  for (const seg of segments) {
    if (seg === '..') throw new ApiError('INVALID_MESSAGE', 'parent-directory traversal is not permitted');
    if (/[<>:"|?*\x00-\x1f]/.test(seg)) throw new ApiError('INVALID_MESSAGE', 'path segment contains illegal characters');
  }
  return segments.join('/');
}

/**
 * Resolve a client-supplied relative path against a workspace root, rejecting
 * every traversal vector. Returns an absolute path inside `root`.
 *
 * @throws {ApiError} INVALID_MESSAGE for any rejected path, with a reason that
 *   names the class of attack but never echoes a filesystem absolute path back
 *   to the client.
 */
export function safeResolve(root, clientPath) {
  const raw = clientPath === null || clientPath === undefined ? '' : String(clientPath);
  if (raw.length > MAX_PATH_LEN) throw new ApiError('INVALID_MESSAGE', 'path too long');
  if (raw.includes('\0')) throw new ApiError('INVALID_MESSAGE', 'path contains a NUL byte');

  const forward = raw.replace(/\\/g, '/');
  if (forward.startsWith('/')) throw new ApiError('INVALID_MESSAGE', 'absolute paths are not permitted');
  if (/^[A-Za-z]:/.test(raw)) throw new ApiError('INVALID_MESSAGE', 'drive-letter paths are not permitted');
  if (raw.startsWith('\\\\') || raw.startsWith('//')) throw new ApiError('INVALID_MESSAGE', 'UNC paths are not permitted');
  if (raw.startsWith('~')) throw new ApiError('INVALID_MESSAGE', 'home-relative paths are not permitted');

  const segments = forward.split('/').filter((s) => s.length > 0);
  for (const seg of segments) {
    if (seg === '..') throw new ApiError('INVALID_MESSAGE', 'parent-directory traversal is not permitted');
    if (seg === '.') continue;
    if (/[<>:"|?*\x00-\x1f]/.test(seg)) throw new ApiError('INVALID_MESSAGE', `path segment contains illegal characters`);
  }

  const resolved = path.resolve(root, ...segments);
  const rootResolved = path.resolve(root);
  // Containment check, prefix-safe on both separators.
  const inside = resolved === rootResolved || resolved.startsWith(withSep(rootResolved));
  if (!inside) throw new ApiError('INVALID_MESSAGE', 'resolved path escapes the workspace');

  // Symlink escape: the real location of the deepest existing ancestor must
  // remain inside the root. A not-yet-existing leaf is checked via its parent.
  const realRoot = realpathOrSelf(rootResolved);
  let probe = resolved;
  let depth = 0;
  while (depth++ < 64) {
    if (fs.existsSync(probe)) {
      const real = realpathOrSelf(probe);
      const contained = real === realRoot || real.startsWith(withSep(realRoot));
      if (!contained) throw new ApiError('INVALID_MESSAGE', 'path escapes the workspace through a symlink');
      break;
    }
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  return resolved;
}

function withSep(p) {
  return p.endsWith(path.sep) ? p : p + path.sep;
}
function realpathOrSelf(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

/** True when `maybeChild` is inside `dir` (used by tests across platforms). */
export function isInside(dir, maybeChild) {
  const a = path.resolve(dir);
  const b = path.resolve(maybeChild);
  return b === a || b.startsWith(withSep(a));
}

function atomicWrite(file, obj) {
  const tmp = `${file}.${process.pid}.tmp`; // process-qualified: see core/auth atomicWrite
  const data = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd); // durable before the rename, so a crash cannot truncate the target
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

export { MAX_FILE_BYTES };
