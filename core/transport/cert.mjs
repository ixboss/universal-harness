// Universal Harness — node TLS certificate (Phase 3B, brief §4).
//
// The node exposes exactly one authenticated control surface: a TLS listener
// whose server certificate is node-specific and self-signed. There is no CA,
// by design — trust is established out-of-band through the pairing payload
// (brief §5): the QR carries this certificate's SHA-256 fingerprint, and the
// client pins it. A peer presenting any other certificate fails closed with
// NODE_CERTIFICATE_MISMATCH before a single protocol message is processed.
//
// Why hand-rolled X.509: the repository has zero runtime dependencies
// (package.json), and Node exposes no certificate *creation* API — only
// parsing and verification. A self-signed ECDSA-P256/SHA-256 certificate is a
// small, fully-specified DER structure, so it is encoded here directly.
// ECDSA-P256 (not the Ed25519 protocol identity) is used because it is the one
// curve both Node's TLS and the Android JSSE/Conscrypt stack accept.
//
// Key material is device-bound: the private key is sealed in OS secure
// storage when a backend exists (DPAPI on Windows) and otherwise written as a
// mode-0600 PEM under the device-local identity directory. It never travels
// with the portable root and is never logged.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { devicePaths } from '../paths/mod.mjs';

const OID_ECDSA_WITH_SHA256 = '1.2.840.10045.4.3.2';
const OID_COMMON_NAME = '2.5.4.3';
const CURVE = 'prime256v1';
const STORE_KEY_PRIVATE = 'node-tls-private';
const CERT_VALIDITY_MS = 1000 * 60 * 60 * 24 * 365 * 10; // 10 years

// ---------------------------------------------------------------------------
// Minimal DER encoder (only what X.509 needs).
// ---------------------------------------------------------------------------

function derLength(len) {
  if (len < 0x80) return Buffer.from([len]);
  const limbs = [];
  let n = len;
  while (n > 0) { limbs.unshift(n & 0xff); n = Math.floor(n / 256); }
  return Buffer.from([0x80 | limbs.length, ...limbs]);
}

function derTagged(tag, contents) {
  return Buffer.concat([Buffer.from([tag]), derLength(contents.length), contents]);
}

/** SEQUENCE */
const derSeq = (c) => derTagged(0x30, c);
/** SET */
const derSet = (c) => derTagged(0x31, c);
/** CONTEXT [n] EXPLICIT */
const derExplicit = (n, c) => derTagged(0xa0 | n, c);
/** BIT STRING (no unused bits) */
const derBitString = (c) => derTagged(0x03, Buffer.concat([Buffer.from([0x00]), c]));
/** UTF8String */
const derUtf8 = (s) => derTagged(0x0c, Buffer.from(s, 'utf8'));
/** UTCTime: YYMMDDHHMMSSZ */
const derUtcTime = (d) => derTagged(0x17, Buffer.from(formatUtcTime(d), 'ascii'));
/** INTEGER from a non-negative bigint */
const derInt = (n) => {
  if (n === 0n) return derTagged(0x02, Buffer.from([0x00]));
  const hex = n.toString(16);
  const bytes = Buffer.from(hex.length % 2 ? `0${hex}` : hex, 'hex');
  // A leading 1-bit would make the INTEGER negative; prefix a zero byte.
  const padded = bytes[0] & 0x80 ? Buffer.concat([Buffer.from([0x00]), bytes]) : bytes;
  return derTagged(0x02, padded);
};

function oidToBytes(oid) {
  const parts = oid.split('.').map((p) => Number(p));
  const out = [40 * parts[0] + parts[1]];
  for (let i = 2; i < parts.length; i++) {
    const stack = [parts[i] & 0x7f];
    let v = parts[i] >>> 7;
    while (v > 0) { stack.unshift(0x80 | (v & 0x7f)); v >>>= 7; }
    out.push(...stack);
  }
  return Buffer.from(out);
}

const derOid = (oid) => derTagged(0x06, oidToBytes(oid));

function formatUtcTime(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

// ---------------------------------------------------------------------------
// Certificate construction
// ---------------------------------------------------------------------------

/**
 * Build a self-signed ECDSA-P256/SHA-256 X.509 certificate in DER.
 *
 * @param {{privateKey: crypto.KeyObject, commonName?: string, notAfter?: Date, serial?: Buffer}} opts
 * @returns {Buffer} DER certificate
 */
export function createSelfSignedCertificate({ privateKey, commonName = 'universal-harness-node', notAfter = null, serial = null }) {
  if (!privateKey || privateKey.asymmetricKeyType !== 'ec') {
    throw new CertError('key-type', 'a private EC key object is required to build the node certificate');
  }
  const publicKey = crypto.createPublicKey(privateKey);
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' });

  const sigAlg = derSeq(derOid(OID_ECDSA_WITH_SHA256));
  // CN-only Distinguished Name (issuer == subject: self-signed).
  const name = derSeq(derSet(derSeq(Buffer.concat([derOid(OID_COMMON_NAME), derUtf8(commonName)]))));
  const notBefore = new Date(Date.now() - 60_000); // 1m clock skew tolerance
  const validity = derSeq(Buffer.concat([
    derUtcTime(notBefore),
    derUtcTime(notAfter || new Date(Date.now() + CERT_VALIDITY_MS)),
  ]));

  const serialInt = serial
    ? Buffer_toNonNegativeBigInt(serial)
    : Buffer_toNonNegativeBigInt(crypto.randomBytes(16));

  const tbs = derSeq(Buffer.concat([
    derExplicit(0, derInt(2n)),          // version v3
    derInt(serialInt),                   // serialNumber
    sigAlg,                              // signature AlgorithmIdentifier
    name,                                // issuer
    validity,                            // validity
    name,                                // subject
    spkiDer,                             // subjectPublicKeyInfo
  ]));

  const signature = crypto.sign('sha256', tbs, privateKey);
  return derSeq(Buffer.concat([tbs, sigAlg, derBitString(signature)]));
}

function Buffer_toNonNegativeBigInt(buf) {
  let n = 0n;
  for (const b of buf) n = (n << 8n) | BigInt(b);
  return n;
}

/** SHA-256 of the DER certificate, lowercase hex — the fingerprint a client pins. */
export function certificateFingerprint(certDer) {
  return crypto.createHash('sha256').update(certDer).digest('hex');
}

/** DER -> PEM (X.509 CERTIFICATE). */
export function derToPem(certDer) {
  const b64 = certDer.toString('base64');
  const lines = b64.match(/.{1,64}/g) || [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`;
}

export class CertError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CertError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Persistence (device-bound)
// ---------------------------------------------------------------------------

/**
 * Load or generate the node's TLS certificate and its private key.
 *
 * The certificate is regenerated only when it is absent or unverifiable; its
 * fingerprint must be stable across normal restarts (brief §15), otherwise
 * every paired controller would see NODE_CERTIFICATE_MISMATCH.
 *
 * @param {{p: object, secureStorage?: object|null, log?: object, commonName?: string}} opts
 * @returns {Promise<{certPem: string, certDer: Buffer, fingerprintSha256: string, privateKeyPem: string, keyObject: crypto.KeyObject, createdAt: string, protection: string}>}
 */
export async function loadOrCreateNodeTlsCertificate({ p, secureStorage = null, log = null, commonName = null }) {
  const dp = devicePaths(p);
  const dir = dp.identity;
  const certPath = path.join(dir, 'node.tls.cert.pem');
  const keyPath = path.join(dir, 'node.tls.private.pem');
  const metaPath = path.join(dir, 'node.tls.json');
  fs.mkdirSync(dir, { recursive: true });

  const writeKeyFile = (pem) => fs.writeFileSync(keyPath, pem, { mode: 0o600 });
  const readKeyFile = () => { try { return fs.readFileSync(keyPath, 'utf8'); } catch { return null; } };

  const name = commonName || `node@${crypto.randomUUID().slice(0, 8)}`;

  // --- existing material ---
  if (fs.existsSync(certPath) && fs.existsSync(metaPath)) {
    let keyPem = null;
    if (secureStorage) {
      try { const stored = await secureStorage.get(STORE_KEY_PRIVATE); keyPem = typeof stored === 'string' ? stored : null; }
      catch { keyPem = null; } // a store failure must not strand the node; the sidecar is checked next
    }
    if (!keyPem) keyPem = readKeyFile();
    try {
      // The certificate is stored as PEM; fingerprint the DER it parses to, so
      // the recorded fingerprint is byte-identical to the one issued with.
      const cert = new crypto.X509Certificate(fs.readFileSync(certPath));
      const certDer = cert.raw;
      const priv = crypto.createPrivateKey({ key: keyPem, format: 'pem' });
      // Fail closed rather than silently reissuing a certificate whose key is
      // gone or whose fingerprint no longer matches what controllers pinned.
      if (cert.publicKey.asymmetricKeyType !== 'ec') throw new CertError('incompatible', 'stored certificate is not an EC certificate');
      if (!cert.verify(crypto.createPublicKey(priv))) throw new CertError('inconsistent', 'stored certificate does not match its stored private key');
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      const fp = certificateFingerprint(certDer);
      if (meta.fingerprintSha256 && meta.fingerprintSha256 !== fp) {
        throw new CertError('inconsistent', 'stored certificate fingerprint record is stale');
      }
      return {
        certPem: derToPem(certDer), certDer, fingerprintSha256: fp,
        privateKeyPem: keyPem, keyObject: priv,
        createdAt: meta.createdAt || cert.validFromDate,
        protection: keyProtection(secureStorage, readKeyFile()),
      };
    } catch (e) {
      throw new CertError('corrupt', `node TLS certificate cannot be used: ${e.message}. Delete the device identity directory to reissue the node certificate; paired controllers must then be re-paired.`);
    }
  }

  // --- first launch: generate ---
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: CURVE });
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const certDer = createSelfSignedCertificate({ privateKey, commonName: name });
  const fingerprintSha256 = certificateFingerprint(certDer);

  fs.writeFileSync(certPath, derToPem(certDer), { mode: 0o644 });
  const meta = { v: 1, fingerprintSha256, commonName: name, createdAt: new Date().toISOString() };
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n', { mode: 0o644 });

  let protection;
  if (secureStorage) {
    try {
      await secureStorage.set(STORE_KEY_PRIVATE, privateKeyPem);
      protection = 'os-secure-storage';
      // Keep the sidecar in sync only when the OS store accepted the key; if it
      // did, the file below is not created at all.
    } catch (e) {
      writeKeyFile(privateKeyPem);
      protection = 'file-0600-fallback';
      log?.warn?.(`OS secure storage unavailable for node TLS key (${e.message}); using restricted file`);
    }
  } else {
    writeKeyFile(privateKeyPem);
    protection = 'file-0600';
  }

  log?.info?.('node TLS certificate issued', { fingerprint: fingerprintSha256.slice(0, 16) + '…', protection });
  return {
    certPem: derToPem(certDer), certDer, fingerprintSha256,
    privateKeyPem, keyObject: crypto.createPrivateKey({ key: privateKeyPem, format: 'pem' }),
    createdAt: meta.createdAt, protection,
  };
}

function keyProtection(secureStorage, sidecarPresent) {
  if (sidecarPresent) return secureStorage ? 'file-0600-fallback' : 'file-0600';
  return secureStorage ? 'os-secure-storage' : 'file-0600';
}
