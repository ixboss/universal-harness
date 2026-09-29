// Runtime integrity verification.
//
// Spec §3: every bundled runtime is pinned with an exact version + SHA-256,
// verified before execution, and a mismatch fails safely — a corrupted or
// unexpected runtime is never silently executed.

import crypto from 'node:crypto';
import fs from 'node:fs';

/**
 * Compute the SHA-256 of a file as a lowercase hex string (streaming, so a
 * multi-hundred-MB runtime does not need to be buffered).
 *
 * @param {string} file path
 * @returns {Promise<string>} hex digest
 */
export async function sha256File(file) {
  const h = crypto.createHash('sha256');
  const stream = fs.createReadStream(file, { highWaterMark: 1 << 20 });
  for await (const chunk of stream) h.update(chunk);
  return h.digest('hex');
}

/** Synchronous SHA-256 of a Buffer/string. */
export function sha256Bytes(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Verify a file against an expected SHA-256, in constant time.
 *
 * @param {string} file path
 * @param {string} expected lowercase hex SHA-256
 * @returns {Promise<{ok:boolean, actual:string|null, expected:string, error?:string}>}
 */
export async function verifyFileSha256(file, expected) {
  const wanted = String(expected || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(wanted)) {
    return { ok: false, actual: null, expected: wanted, error: 'EXPECTED_HASH_MALFORMED' };
  }
  if (!fs.existsSync(file)) {
    return { ok: false, actual: null, expected: wanted, error: 'FILE_MISSING' };
  }
  try {
    const actual = await sha256File(file);
    // timingSafeEqual over equal-length hex strings
    const ok = crypto.timingSafeEqual(Buffer.from(actual, 'utf8'), Buffer.from(wanted, 'utf8'));
    return { ok, actual, expected: wanted, error: ok ? null : 'HASH_MISMATCH' };
  } catch (err) {
    return { ok: false, actual: null, expected: wanted, error: `READ_FAILED:${err.code || err.message}` };
  }
}

/**
 * Verify a manifest entry's archive on disk.
 *
 * @param {Object} entry manifest archive entry (needs `sha256`)
 * @param {string} file local archive path
 */
export async function verifyArchive(entry, file) {
  return verifyFileSha256(file, entry.sha256);
}

/**
 * Format a hash mismatch into the actionable diagnostic string required by the
 * doctor format (spec §11).
 */
export function mismatchMessage(label, expected, actual, action) {
  return [
    `FAIL: ${label} hash mismatch`,
    `Expected: ${expected}`,
    `Actual:   ${actual}`,
    `Action: ${action}`,
  ].join('\n');
}
