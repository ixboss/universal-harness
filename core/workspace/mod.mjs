// Workspace registry — stable IDs, not filesystem paths (spec §6).
//
// The portable tree owns:
//   data/workspace/.workspace.json   identity marker (stable id travels with the drive)
//   data/workspace/registry.json     registry: projects, recorded root, history
//
// Everything that can move between machines is stored relative to the root
// (POSIX separators via core/paths), so a workspace that moves from
// D:\UniversalHarness to E:\UniversalHarness re-resolves automatically. The
// *absolute* root is recorded only to *detect* the move (core/migration),
// never to address state.

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { UhError, ERR } from '../errors/mod.mjs';
import { ensureDir, toPortableRelative } from '../paths/mod.mjs';

const REGISTRY_SCHEMA = 1;

/** Create or load the workspace store for a root. */
export function createWorkspaceStore({ root, p, log = consoleShim() }) {
  const storeRoot = path.resolve(root);
  const wsDir = path.join((p && p.workspace) || path.join(root, 'data', 'workspace'));
  const markerPath = path.join(wsDir, '.workspace.json');
  const registryPath = path.join(wsDir, 'registry.json');
  ensureDir(wsDir);

  function readJson(file, fallback) {
    if (!fs.existsSync(file)) return fallback;
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { return fallback; }
  }

  /** Initialize the workspace identity marker once. Refuses silent overwrite. */
  function init({ label, force = false } = {}) {
    const existing = readJson(markerPath, null);
    if (existing && !force) {
      throw new UhError(ERR.WORKSPACE_INVALID,
        `workspace identity already exists (${existing.id})`,
        { id: existing.id },
        'Use --force to reinitialize only if you understand this changes the workspace identity seen by paired clients.');
    }
    const marker = { id: randomUUID(), label: label || path.basename(path.resolve(root)), createdAt: Date.now() };
    atomicWrite(markerPath, marker);
    return marker;
  }

  function loadMarker() { return readJson(markerPath, null); }

  function loadRegistry() {
    const reg = readJson(registryPath, null);
    if (!reg) return freshRegistry();
    if (reg.schemaVersion !== REGISTRY_SCHEMA) {
      throw new UhError(ERR.WORKSPACE_INVALID,
        `registry schema ${reg.schemaVersion} is not supported by this build (${REGISTRY_SCHEMA})`,
        { schemaVersion: reg.schemaVersion },
        'Run `uh migrate check` — a future version migrates registry formats; this build refuses to touch an unknown schema.');
    }
    return reg;
  }

  function freshRegistry() {
    const marker = loadMarker() || init({});
    return {
      schemaVersion: REGISTRY_SCHEMA,
      workspaceId: marker.id,
      recordedRoot: path.resolve(root),
      projects: [],
      updatedAt: Date.now(),
    };
  }

  function save(registry) {
    registry.updatedAt = Date.now();
    registry.recordedRoot = path.resolve(root);
    atomicWrite(registryPath, registry);
    return registry;
  }

  /** Detect duplicate/conflicting identity: marker vs registry disagree. */
  function conflicts() {
    const marker = loadMarker();
    const reg = readJson(registryPath, null);
    if (!marker || !reg) return [];
    const out = [];
    if (marker.id !== reg.workspaceId) {
      out.push({ kind: 'workspace-id-mismatch', marker: marker.id, registry: reg.workspaceId,
        action: 'The drive was copied or partially restored. Decide which identity is authoritative, then reinitialize deliberately.' });
    }
    const seen = new Set();
    for (const proj of reg.projects || []) {
      if (seen.has(proj.id)) out.push({ kind: 'duplicate-project-id', id: proj.id,
        action: 'Two projects share a stable id; one is a copy. Rename or reinitialize one project.' });
      seen.add(proj.id);
    }
    return out;
  }

  /**
   * Register a project under the workspace. Projects live under data/projects/
   * and carry their own stable id in a marker file, so they keep their identity
   * when the workspace moves.
   */
  function registerProject({ name, relPath, force = false } = {}) {
    const reg = loadRegistry();
    const slug = slugify(name);
    const projDir = relPath ? path.resolve(root, relPath) : path.join(p.projects || path.join(root, 'data', 'projects'), slug);
    ensureDir(projDir);
    const pMarker = path.join(projDir, '.uh-project.json');
    const existing = readJson(pMarker, null);
    if (existing && !force) {
      return attach(reg, existing, projDir);
    }
    const record = { id: randomUUID(), name, slug, createdAt: Date.now() };
    atomicWrite(pMarker, record);
    return attach(reg, record, projDir);
  }

  function attach(reg, record, projDir) {
    const rel = toPortableRelative(root, projDir);
    if (!rel) throw new UhError(ERR.WORKSPACE_INVALID, 'project directory is outside the workspace root', { dir: projDir });
    const existing = reg.projects.find((x) => x.id === record.id || x.relPath === rel);
    if (existing) { existing.name = record.name; existing.lastSeen = Date.now(); }
    else reg.projects.push({ id: record.id, name: record.name, relPath: rel, createdAt: record.createdAt, lastSeen: Date.now() });
    save(reg);
    return { id: record.id, name: record.name, relPath: rel };
  }

  function listProjects() {
    const reg = loadRegistry();
    return (reg.projects || []).map((x) => ({ ...x, exists: fs.existsSync(path.resolve(root, x.relPath)) }));
  }

  function findProject(query) {
    return listProjects().find((x) => x.id === query || x.name === query || x.slug === query) || null;
  }

  /** Registered projects whose directory has gone missing. */
  function missingProjects() {
    return listProjects().filter((x) => !x.exists);
  }

  return {
    init, loadMarker, loadRegistry, save, conflicts,
    registerProject, listProjects, findProject, missingProjects,
    paths: { wsDir, markerPath, registryPath },
    get root() { return storeRoot; },
  };
}

function slugify(name) {
  return String(name || 'project').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'project';
}

function atomicWrite(file, obj) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

function consoleShim() { return { info() {}, warn() {}, debug() {}, error() {} }; }
