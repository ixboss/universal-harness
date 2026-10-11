// Universal Harness — controller device identity (Phase 3C).
//
// A controller is a device in the node's pairing model: it holds one long-lived
// Ed25519 keypair, and its public key becomes a DeviceRecord when a pairing
// token is consumed. The private key NEVER leaves the controller and NEVER
// lives in the portable tree — it is sealed through the same secureStorage
// architecture the node identity uses, with a mode-0600 sidecar file fallback
// and an honest describe() either way. There is no plaintext store.

import fs from 'node:fs';
import path from 'node:path';
import {
  generateKeyPairSync, createPrivateKey, createPublicKey, createHash, sign,
} from 'node:crypto';
import { devicePaths } from '../paths/mod.mjs';

const KEY_VERSION = 1;

export function devicePublicKeyPem(keyPem) {
  return createPublicKey({ key: keyPem, format: 'pem' }).export({ type: 'spki', format: 'pem' }).trim();
}

/** SHA-256 over the DER (SPKI) of the public key — the node derives deviceId from it. */
export function deviceFingerprint(publicPem) {
  const der = createPublicKey({ key: publicPem, format: 'pem' }).export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('hex');
}

/**
 * deviceId exactly as the node derives it (core/auth pair(): SHA-256 over the
 * PEM text the client presented, first 32 hex). Hashing the PEM string rather
 * than the DER is the deployed node behavior — the client replicates it so
 * both sides agree on the identifier without touching node code.
 */
export function deviceIdFromPem(publicPem) {
  const pem = String(publicPem).trim();
  return 'device_' + createHash('sha256').update(pem).digest('hex').slice(0, 32);
}

export function generateDeviceKeyPem() {
  return generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
}

/** Sign UTF-8 data with the controller's private key; returns base64. */
export function signBytes(privateKeyPem, data) {
  return sign(null, Buffer.from(data, 'utf8'), createPrivateKey({ key: privateKeyPem, format: 'pem' })).toString('base64');
}

/**
 * Load the controller device key for one profile, generating it on first use.
 * The profile dir is under the device-local tree (`controller/<profile>/`),
 * never the portable root.
 *
 * @param {{p: object, profile?: string, secureStorage?: object, log?: object}} opts
 * @returns {Promise<{privateKeyPem: string, publicKeyPem: string, deviceId: string, protection: string}>}
 */
export async function loadOrCreateControllerKey({ p, profile = 'default', secureStorage = null, log = null }) {
  if (!/^[a-z0-9][a-z0-9._-]{0,31}$/i.test(profile)) {
    throw new Error(`invalid controller profile name: ${JSON.stringify(profile)}`);
  }
  const dir = path.join(devicePaths(p).root, 'controller', profile);
  fs.mkdirSync(dir, { recursive: true });
  const storeKey = `uh-controller-${profile}-private`;
  const fallbackPath = path.join(dir, 'controller-key.private.pem');

  const readPrivateFile = () => {
    try { return fs.readFileSync(fallbackPath, 'utf8'); } catch { return null; }
  };

  let privateKeyPem = null;
  let protection = null;
  if (secureStorage) {
    try {
      const stored = await secureStorage.get(storeKey);
      if (typeof stored === 'string' && stored.includes('PRIVATE KEY')) {
        privateKeyPem = stored;
        protection = 'os-secure-storage';
      }
    } catch { /* backend unavailable — fall through to the file */ }
  }
  if (!privateKeyPem) privateKeyPem = readPrivateFile();

  if (privateKeyPem) {
    if (!protection) protection = secureStorage ? 'file-0600-fallback' : 'file-0600';
    return assemble(privateKeyPem, protection);
  }

  privateKeyPem = generateDeviceKeyPem();
  if (secureStorage) {
    try {
      await secureStorage.set(storeKey, privateKeyPem);
      protection = 'os-secure-storage';
    } catch (e) {
      fs.writeFileSync(fallbackPath, privateKeyPem, { mode: 0o600 });
      protection = 'file-0600-fallback';
      log?.warn?.(`OS secure storage unavailable for the controller key (${e.message}); using a restricted file`);
    }
  } else {
    fs.writeFileSync(fallbackPath, privateKeyPem, { mode: 0o600 });
    protection = 'file-0600';
  }
  return assemble(privateKeyPem, protection);
}

function assemble(privateKeyPem, protection) {
  const publicKeyPem = devicePublicKeyPem(privateKeyPem);
  const deviceId = deviceIdFromPem(publicKeyPem);
  return {
    privateKeyPem,
    publicKeyPem,
    deviceId,
    protection,
    /** Sign a challenge / canonical string with the controller's private key (base64). */
    sign(data) { return signBytes(privateKeyPem, data); },
    describe() {
      // Public metadata only — the same honesty contract as the node identity.
      return { v: KEY_VERSION, deviceId, protection };
    },
  };
}
