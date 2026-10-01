// Universal Harness — persistent node identity (brief §14).
//
// One identity per device, generated once and reused for the life of the
// install. It is the anchor for first-contact trust: the pairing payload binds
// the short-lived token to this identity's fingerprint, so a token stolen from
// a QR code cannot be replayed against a different peer (NEG-PAIR-01).
//
// Storage rules:
//   - The private key NEVER lives in the portable tree (data/) and is never
//     committed. It is sealed with OS secure storage where available (DPAPI on
//     Windows) and otherwise kept in a mode-0600 file under the device-local
//     identity directory, with that fact reported honestly by describe().
//   - The public key, nodeId, and fingerprint are safe to expose; diagnostics
//     surface exactly those and nothing else.
//
// Identity here is deliberately *node* identity (the execution node). Client
// devices get their own long-lived keys recorded in DeviceRecords (core/auth).

import fs from 'node:fs';
import path from 'node:path';
import { generateKeyPairSync, createPrivateKey, createPublicKey, sign, verify, randomBytes, createHash } from 'node:crypto';
import { devicePaths } from '../paths/mod.mjs';
import { sha256Hex } from '../protocol/mod.mjs';

const IDENTITY_VERSION = 1;
const STORE_KEY_PRIVATE = 'node-identity-private';

/**
 * Deterministic derivation: the nodeId and fingerprint are functions of the
 * public key only, so any party holding the public key can check them.
 */
export function publicKeyFromPem(pem) {
  return createPublicKey({ key: pem, format: 'pem' });
}

export function publicKeyToPem(key) {
  return key.export({ type: 'spki', format: 'pem' }).trim();
}

/** SHA-256 over the DER (SPKI) encoding of the public key — the binding artifact. */
export function nodeFingerprintPem(pem) {
  const key = publicKeyFromPem(pem);
  const der = key.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('hex');
}

/** NodeId: node_ + first 32 hex of the fingerprint, matching identifiers.schema.json. */
export function nodeIdFromPem(pem) {
  return 'node_' + nodeFingerprintPem(pem).slice(0, 32);
}

function generateIdentity() {
  // Ed25519: deterministic, small signatures, no parameters to negotiate.
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicPem = publicKeyToPem(publicKey);
  return {
    v: IDENTITY_VERSION,
    algorithm: 'ed25519',
    nodeId: nodeIdFromPem(publicPem),
    fingerprint: nodeFingerprintPem(publicPem),
    publicKeyPem: publicPem,
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    createdAt: new Date().toISOString(),
  };
}

/**
 * Load the persistent node identity, generating and persisting it on first use.
 * The private key is sealed via `secureStorage` when that backend is available
 * and otherwise written as a 0600 PEM next to the public record; `describe()`
 * always states which.
 *
 * Async because the OS secure store is async (DPAPI round-trips through
 * PowerShell). Callers must await it.
 *
 * @param {{p: object, secureStorage?: object, log?: object}} opts
 */
export async function loadOrCreateNodeIdentity({ p, secureStorage = null, log = null }) {
  const dp = devicePaths(p);
  const recordPath = path.join(dp.identity, 'node.json');
  const privateKeyPath = path.join(dp.identity, 'node.private.pem');
  fs.mkdirSync(dp.identity, { recursive: true });

  const writePrivateFile = (pem) => {
    fs.writeFileSync(privateKeyPath, pem, { mode: 0o600 });
  };
  const readPrivateFile = () => {
    try { return fs.readFileSync(privateKeyPath, 'utf8'); } catch { return null; }
  };

  // --- existing record ---
  if (fs.existsSync(recordPath)) {
    let record;
    try { record = JSON.parse(fs.readFileSync(recordPath, 'utf8')); }
    catch (e) { throw new IdentityError('corrupt', `node identity record is unreadable: ${e.message}`); }

    if (!record || record.v !== IDENTITY_VERSION || !record.publicKeyPem || !record.nodeId) {
      throw new IdentityError('incompatible', 'node identity record is not a v1 record');
    }
    // The private key may live in the OS store or the sidecar file. The store
    // API is async and returns null when the blob is absent.
    let privatePem = null;
    if (secureStorage) {
      try {
        const stored = await secureStorage.get(STORE_KEY_PRIVATE);
        privatePem = typeof stored === 'string' ? stored : null;
      } catch { privatePem = null; }
    }
    if (!privatePem) privatePem = readPrivateFile();
    if (!privatePem || typeof privatePem !== 'string') {
      throw new IdentityError('missing-private', 'node identity public record exists but its private key is absent');
    }

    // Fail closed on a tampered/inconsistent identity rather than silently
    // regenerating a new nodeId, which would silently invalidate every pairing.
    const expectedId = nodeIdFromPem(record.publicKeyPem);
    const expectedFp = nodeFingerprintPem(record.publicKeyPem);
    if (record.nodeId !== expectedId || record.fingerprint !== expectedFp) {
      throw new IdentityError('inconsistent', 'node identity record does not match its own public key');
    }
    if (!publicKeyMatches(record.publicKeyPem, privatePem)) {
      throw new IdentityError('inconsistent', 'node identity public key does not match the stored private key');
    }
    return assemble(record, privatePem, 'loaded');
  }

  // --- first launch: generate ---
  const identity = generateIdentity();
  const { privateKeyPem, ...safe } = identity;
  atomicWrite(recordPath, safe);

  let protection;
  if (secureStorage) {
    try {
      await secureStorage.set(STORE_KEY_PRIVATE, privateKeyPem);
      protection = 'os-secure-storage';
    } catch (e) {
      // Fall back to the restricted file rather than aborting node startup,
      // but report it loudly so the operator knows.
      writePrivateFile(privateKeyPem);
      protection = 'file-0600-fallback';
      log?.warn?.(`OS secure storage unavailable for node identity (${e.message}); using restricted file`);
    }
  } else {
    writePrivateFile(privateKeyPem);
    protection = 'file-0600';
  }
  return assemble(identity, privateKeyPem, protection);
}

function publicKeyMatches(publicPem, privatePem) {
  try {
    const priv = createPrivateKey({ key: privatePem, format: 'pem' });
    const derivedPublic = publicKeyToPem(createPublicKey(priv));
    // Compare on the DER fingerprint so PEM whitespace differences cannot matter.
    return nodeFingerprintPem(derivedPublic) === nodeFingerprintPem(publicPem);
  } catch { return false; }
}

function assemble(identity, privatePem, protection) {
  const keyObject = createPrivateKey({ key: privatePem, format: 'pem' });
  return {
    nodeId: identity.nodeId,
    fingerprint: identity.fingerprint,
    publicKeyPem: identity.publicKeyPem,
    algorithm: identity.algorithm,
    createdAt: identity.createdAt,
    protection: typeof protection === 'string' ? protection : 'loaded',
    /** Sign a challenge for a client (challenge-response authentication). */
    sign(data) {
      return sign(null, Buffer.from(data), keyObject);
    },
    verify(clientPublicKeyPem, data, signature) {
      try {
        return verify(null, Buffer.from(data), publicKeyFromPem(clientPublicKeyPem), Buffer.from(signature));
      } catch { return false; }
    },
    /** Safe metadata for diagnostics; never includes private material. */
    describe() {
      return {
        nodeId: identity.nodeId,
        fingerprint: identity.fingerprint,
        algorithm: identity.algorithm,
        createdAt: identity.createdAt,
        protection: typeof protection === 'string' ? protection : 'loaded',
      };
    },
  };
}

export class IdentityError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'IdentityError';
    this.identityError = kind; // 'corrupt' | 'incompatible' | 'inconsistent' | 'missing-private'
  }
}

function atomicWrite(file, obj) {
  const tmp = `${file}.${process.pid}.tmp`; // process-qualified: see core/auth atomicWrite
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(obj, null, 2));
    fs.fsyncSync(fd); // durable before the rename, so a crash cannot leave an empty file
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}
