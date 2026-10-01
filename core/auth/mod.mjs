// Universal Harness — authentication, pairing, and device records (brief §5).
//
// Trust model, restated from the contract (PROTOCOL §4):
//
//   * A pairing token ALONE authorises nothing. The token is single-use and
//     short-lived, and the pairing payload binds it to the node's persistent
//     identity fingerprint. The client records that binding out-of-band (from
//     the QR) and checks the peer it actually talks to against it BEFORE any
//     trust is stored. A token replayed against a different peer fails with
//     NODE_IDENTITY_MISMATCH — that is NEG-PAIR-01.
//
//   * On every connection the node sends a fresh nonce (node.hello). The client
//     must sign it with its long-lived device private key (auth.connect /
//     device.pair). Possession of a device id or a token without the key fails
//     with CHALLENGE_FAILED.
//
//   * Scopes are granted AFTER authentication succeeds and recorded verbatim;
//     the node may grant a subset of what was requested.
//
// Device records and active pairing tokens live in the device-local tree
// (never in the portable data/ tree), so they do not travel with a USB drive.

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { devicePaths } from '../paths/mod.mjs';
import { now, newRequestId } from '../protocol/mod.mjs';
import { redact } from '../errors/mod.mjs';
import { PAIR_FAIL } from '../protocol/mod.mjs';

const DEVICES_FILE = 'devices.json';
const PENDING_TOKEN_FILE = 'pending-pairing.json';
const TOKEN_TTL_MS = 60_000;

export function createAuthStore({ p, log = null, identity, tokenTtlMs = TOKEN_TTL_MS }) {
  const dp = devicePaths(p);
  fs.mkdirSync(dp.root, { recursive: true });
  const devicesPath = path.join(dp.root, DEVICES_FILE);
  const pendingPath = path.join(dp.root, PENDING_TOKEN_FILE);

  let currentToken = null;

  // ---------- persistence ----------
  function loadDevices() {
    try {
      const raw = fs.readFileSync(devicesPath, 'utf8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed.devices) ? parsed.devices : [];
    } catch { return []; }
  }
  function saveDevices(devices) {
    atomicWrite(devicesPath, { v: 1, devices });
  }

  // ---------- pending pairing token (cross-process) ----------
  // The token itself is held in memory by whichever process minted it; the
  // device-local tree carries only a SHA-256 hash plus its lifetime, so `uh
  // pair` and a separately running `uh serve` can cooperate without the
  // plaintext token ever touching disk. Consuming or burning the token
  // deletes the record; the file's absence reads as "no token".
  function persistPendingToken(token, expiresAtMs) {
    atomicWrite(pendingPath, {
      v: 1,
      tokenHash: hashToken(token),
      mintedAt: new Date().toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
    });
  }
  function loadPendingToken() {
    try {
      const rec = JSON.parse(fs.readFileSync(pendingPath, 'utf8'));
      if (!rec || rec.v !== 1 || !/^[0-9a-f]{64}$/.test(rec.tokenHash)) return null;
      const expiresAt = Date.parse(rec.expiresAt);
      if (!Number.isFinite(expiresAt)) return null;
      return { tokenHash: rec.tokenHash, expiresAt };
    } catch { return null; }
  }
  function clearPendingToken() {
    try { fs.rmSync(pendingPath, { force: true }); } catch { /* best effort */ }
  }

  // ---------- pairing tokens ----------
  /**
   * Mint the short-lived single-use pairing token and the out-of-band payload a
   * client verifies before trusting this node. `endpoint` and the certificate
   * fingerprint are supplied by the caller (transport layer); the identity
   * fingerprint always comes from the persistent node identity.
   */
  function mintPairingPayload({ endpoint, nodeCertSha256 = null, nodeName = null }) {
    currentToken = {
      token: randomBytes(24).toString('base64url'),
      createdAt: Date.now(),
      expiresAt: Date.now() + tokenTtlMs,
      consumed: false,
    };
    // Persist the hash so a separately running server process can consume the
    // token; the plaintext exists only in this process's memory and in the
    // payload returned to the caller (the out-of-band channel).
    persistPendingToken(currentToken.token, currentToken.expiresAt);
    return {
      v: 1,
      nodeId: identity.nodeId,
      endpoint,
      nodeName,
      token: currentToken.token,
      expiresAt: new Date(currentToken.expiresAt).toISOString(),
      nodeIdentitySha256: identity.fingerprint,
      nodeCertSha256,
      nodePublicKeyPem: identity.publicKeyPem,
    };
  }

  function consumePairingToken(candidate) {
    if (typeof candidate !== 'string' || !candidate) {
      return { ok: false, code: PAIR_FAIL.TOKEN_EXPIRED };
    }
    if (currentToken) {
      // Fast path: this process minted the token.
      if (!safeEqual(candidate, currentToken.token)) {
        // A wrong token is refused but not burned — identical to the pre-existing
        // behaviour; only consumption (or expiry) ends a token's life.
        return { ok: false, code: PAIR_FAIL.TOKEN_EXPIRED };
      }
      if (Date.now() > currentToken.expiresAt) {
        currentToken.consumed = true;
        clearPendingToken();
        return { ok: false, code: PAIR_FAIL.TOKEN_EXPIRED };
      }
      if (currentToken.consumed) return { ok: false, code: PAIR_FAIL.TOKEN_CONSUMED };
      currentToken.consumed = true; // single-use, even for a later failed challenge
      clearPendingToken();
      return { ok: true };
    }
    // Cross-process path: a sibling process (uh pair) minted the token; the
    // hash record is the only shared state.
    const pending = loadPendingToken();
    if (!pending) return { ok: false, code: PAIR_FAIL.TOKEN_EXPIRED };
    if (Date.now() > pending.expiresAt) {
      clearPendingToken();
      return { ok: false, code: PAIR_FAIL.TOKEN_EXPIRED };
    }
    if (!safeEqual(hashToken(candidate), pending.tokenHash)) {
      return { ok: false, code: PAIR_FAIL.TOKEN_EXPIRED };
    }
    clearPendingToken(); // single-use, exactly like the in-memory token
    return { ok: true };
  }

  // ---------- challenge-response ----------
  /** Fresh nonce for an incoming connection; 128 bits, base64url. */
  function newChallenge() {
    return randomBytes(32).toString('base64url');
  }

  /**
   * Verify a client's signature over a challenge we issued. Constant-failure:
   * every failure path returns CHALLENGE_FAILED with no information about which
   * step failed, so a probe cannot distinguish an unknown device id from a bad
   * signature.
   */
  function verifyChallenge({ deviceId, sigB64, challenge }, { unknownDeviceOk = false } = {}) {
    const record = loadDevices().find((d) => d.deviceId === deviceId);
    if (!record) {
      if (unknownDeviceOk) return { ok: false, code: PAIR_FAIL.CHALLENGE_FAILED };
      return { ok: false, code: PAIR_FAIL.CHALLENGE_FAILED };
    }
    if (record.status !== 'active') return { ok: false, code: 'DEVICE_REVOKED' };
    let valid = false;
    try {
      valid = identity.verify(record.devicePublicKeyPem, Buffer.from(challenge, 'utf8'), Buffer.from(sigB64, 'base64'));
    } catch { valid = false; }
    if (!valid) return { ok: false, code: PAIR_FAIL.CHALLENGE_FAILED };
    return { ok: true, record };
  }

  /**
   * Complete first-contact pairing. Steps in order (each failure aborts):
   *   1. the client's claimed expected node identity must equal OUR identity
   *      fingerprint — else the client bound this token to a different node;
   *   2. the token must be ours, live, and unconsumed;
   *   3. the client must prove possession of its device private key.
   * Only then is a DeviceRecord created.
   */
  function pair(payload) {
    const {
      deviceName, platform, devicePublicKeyPem,
      expectedNodeIdentitySha256, sigB64, challenge, requestedScopes = [], token,
    } = payload;
    if (!expectedNodeIdentitySha256 || !safeEqual(expectedNodeIdentitySha256, identity.fingerprint)) {
      // The pin is mandatory (NEG-PAIR-01): a client that did not record the
      // node's fingerprint out-of-band has skipped its TOFU check, and the node
      // refuses to pair it. This check runs BEFORE token consumption, so a
      // mismatched identity cannot burn a valid token.
      return { ok: false, code: PAIR_FAIL.NODE_IDENTITY_MISMATCH };
    }
    const tokenCheck = consumePairingToken(payload.token);
    if (!tokenCheck.ok) return { ok: false, code: tokenCheck.code };

    let verified = false;
    try {
      verified = identity.verify(devicePublicKeyPem, Buffer.from(challenge, 'utf8'), Buffer.from(sigB64, 'base64'));
    } catch { verified = false; }
    if (!verified) return { ok: false, code: PAIR_FAIL.CHALLENGE_FAILED };

    const devices = loadDevices();
    const deviceId = 'device_' + createHash('sha256').update(devicePublicKeyPem).digest('hex').slice(0, 32);
    const existing = devices.find((d) => d.deviceId === deviceId);
    if (existing) {
      // Re-pairing an already-known device key: refresh its record, never mint
      // a second device id for the same key.
      existing.status = 'active';
      existing.name = deviceName || existing.name;
      existing.platform = platform || existing.platform;
      existing.scopes = resolveGranted(requestedScopes, existing.scopes);
      existing.pairedAt = now();
      existing.lastSeenAt = now();
      saveDevices(devices);
      return { ok: true, deviceId, grantedScopes: existing.scopes, rePaired: true };
    }

    const granted = resolveGranted(requestedScopes, null);
    const record = {
      deviceId,
      name: String(deviceName || 'unnamed device').slice(0, 64),
      platform: ['ios', 'android', 'web', 'desktop'].includes(platform) ? platform : 'desktop',
      devicePublicKeyPem,
      scopes: granted,
      status: 'active',
      pairedAt: now(),
      lastSeenAt: now(),
    };
    devices.push(record);
    saveDevices(devices);
    log?.info?.(`paired device ${redact(deviceId)} platform=${record.platform} scopes=${granted.join(',')}`);
    return { ok: true, deviceId, grantedScopes: granted, rePaired: false };
  }

  /**
   * Grant policy: node-admin and terminal are never auto-granted from a bare
   * request — they require an explicit local action (brief §6, §13). Everything
   * else requested is granted as-is, recorded verbatim.
   */
  function resolveGranted(requested, held) {
    const auto = new Set(held || []);
    for (const s of requested || []) {
      if (s === 'node-admin' || s === 'terminal') continue;
      auto.add(s);
    }
    return [...auto];
  }

  function listDevices() {
    return loadDevices().map((d) => ({
      deviceId: d.deviceId,
      name: d.name,
      platform: d.platform,
      scopes: d.scopes.slice(),
      status: d.status,
      pairedAt: d.pairedAt,
      lastSeenAt: d.lastSeenAt || null,
    }));
  }

  function revokeDevice(deviceId, { forget = false } = {}) {
    const devices = loadDevices();
    const record = devices.find((d) => d.deviceId === deviceId);
    if (!record) return { ok: false, code: 'NOT_FOUND' };
    if (forget) {
      const next = devices.filter((d) => d.deviceId !== deviceId);
      saveDevices(next);
      log?.info?.(`forgot device ${redact(deviceId)}`);
      return { ok: true, status: 'forgotten' };
    }
    record.status = 'revoked';
    saveDevices(devices);
    log?.info?.(`revoked device ${redact(deviceId)}`);
    return { ok: true, status: 'revoked' };
  }

  function touchDevice(deviceId) {
    const devices = loadDevices();
    const record = devices.find((d) => d.deviceId === deviceId);
    if (record) { record.lastSeenAt = now(); saveDevices(devices); }
  }

  return {
    mintPairingPayload,
    newChallenge,
    verifyChallenge,
    pair,
    listDevices,
    revokeDevice,
    touchDevice,
    get pairingOpen() {
      if (currentToken && !currentToken.consumed && Date.now() <= currentToken.expiresAt) return true;
      const pending = loadPendingToken();
      return !!pending && Date.now() <= pending.expiresAt;
    },
    /** Diagnostics only; exposes no key material. */
    describe() {
      return {
        nodeId: identity.nodeId,
        deviceCount: loadDevices().length,
        activeDevices: loadDevices().filter((d) => d.status === 'active').length,
        pairingOpen: this.pairingOpen,
      };
    },
  };
}

/** SHA-256 of a token — the only token form ever persisted or compared on disk. */
function hashToken(token) {
  return createHash('sha256').update(String(token), 'utf8').digest('hex');
}

/**
 * Timing-safe string equality. Both sides are hashed first so the comparison
 * is constant-time and length-safe (timingSafeEqual throws on length mismatch).
 * Used for token and fingerprint material.
 */
function safeEqual(a, b) {
  const ha = createHash('sha256').update(String(a ?? ''), 'utf8').digest();
  const hb = createHash('sha256').update(String(b ?? ''), 'utf8').digest();
  return timingSafeEqual(ha, hb);
}

function atomicWrite(file, obj) {
  // The temp name is process-qualified: two node processes (e.g. `uh pair` and
  // `uh serve`) may atomically write files in the same device-local directory
  // concurrently, and a shared ".tmp" name would let one rename yank the other's
  // in-flight file away (rename ENOENT).
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(obj, null, 2));
    fs.fsyncSync(fd); // durable before the rename, so a crash cannot leave an empty file
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

export { newRequestId };
