// Universal Harness — controller-side paired-node registry (Phase 3C).
//
// Ownership classes (mirrors the node's model, ADR-004):
//   portable tree  — project/session/task metadata. NEVER anything from here.
//   device-local   — this controller's private keys, the pins it trusts, and
//                    the record of which nodes it paired with.
//
// A registry entry therefore stores only public material: the node's endpoint,
// identity fingerprint and certificate fingerprint (the pins a reconnecting
// controller needs), the deviceId the node assigned, granted scopes, and
// timestamps. Private keys live in core/client/keys.mjs storage, never here.

import fs from 'node:fs';
import path from 'node:path';
import { devicePaths } from '../paths/mod.mjs';

const REGISTRY_VERSION = 1;

/**
 * @param {{p: object, profile?: string}} opts
 */
export function createControllerRegistry({ p, profile = 'default' }) {
  if (!/^[a-z0-9][a-z0-9._-]{0,31}$/i.test(profile)) {
    throw new Error(`invalid controller profile name: ${JSON.stringify(profile)}`);
  }
  const dir = path.join(devicePaths(p).root, 'controller', profile);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'nodes.json');

  function load() {
    if (!fs.existsSync(filePath)) return { v: REGISTRY_VERSION, nodes: [] };
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (raw?.v !== REGISTRY_VERSION || !Array.isArray(raw.nodes)) return { v: REGISTRY_VERSION, nodes: [] };
      return raw;
    } catch {
      // An unreadable registry must not silently forget the pins a controller
      // trusts; refuse loudly instead.
      throw new Error(`controller node registry is unreadable: ${filePath}`);
    }
  }

  function save(reg) {
    reg.updatedAt = new Date().toISOString();
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(reg, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, filePath);
    return reg;
  }

  return {
    get filePath() { return filePath; },
    /** All paired-node records. */
    list() { return load().nodes.map((n) => ({ ...n })); },
    get(nodeId) { return load().nodes.find((n) => n.nodeId === nodeId) || null; },
    /** The single paired node, or null; throws when several exist and no id was given. */
    resolve(nodeId = null) {
      const nodes = load().nodes;
      if (nodeId) {
        const found = nodes.find((n) => n.nodeId === nodeId);
        if (!found) throw new Error(`no paired node "${nodeId}" in this controller profile`);
        return found;
      }
      if (nodes.length === 1) return nodes[0];
      if (nodes.length === 0) throw new Error('no paired nodes; run `uh connect pair` with a pairing payload first');
      throw new Error(`multiple paired nodes; pass --node (candidates: ${nodes.map((n) => n.nodeId).join(', ')})`);
    },
    upsert(entry) {
      const reg = load();
      const existing = reg.nodes.find((n) => n.nodeId === entry.nodeId);
      if (existing) Object.assign(existing, entry, { lastSeenAt: new Date().toISOString() });
      else reg.nodes.push({ ...entry, pairedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString() });
      save(reg);
      return existing || entry;
    },
    remove(nodeId) {
      const reg = load();
      const before = reg.nodes.length;
      reg.nodes = reg.nodes.filter((n) => n.nodeId !== nodeId);
      save(reg);
      return reg.nodes.length < before;
    },
  };
}
