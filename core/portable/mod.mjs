// Portable filesystem primitives for Universal Harness (ARCHITECTURE §10).
//
// Every durable metadata write in this codebase needs the same two things, and
// they live here so there is one implementation instead of a dozen copies:
//
//   - an **atomic write**: write a same-directory temp file, fsync it, then
//     rename over the target. A crash, a power loss, or a yanked USB stick can
//     therefore never leave a half-written registry/manifest behind — the
//     target is either the old bytes or the new bytes, never a mixture;
//   - a **best-effort directory fsync**, so the rename itself survives a power
//     loss (POSIX only; Windows has no directory fsync and returns silently).
//
// No dsh knowledge; no protocol knowledge.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Temp-file infix. Deliberately *not* a `.tmp` suffix: `tests/protocol/validate-repo.mjs`
 * flags committed `*.tmp` artifacts, and a stray temp file must never be
 * mistakable for one.
 */
const TEMP_INFIX = '.uh-tmp-';

/** A unique, same-directory temp path for `file` (same filesystem ⇒ atomic rename). */
function tempPathFor(file) {
  const dir = path.dirname(file);
  const base = path.basename(file);
  const unique = `${process.pid.toString(36)}-${crypto.randomBytes(6).toString('hex')}`;
  return path.join(dir, `${base}${TEMP_INFIX}${unique}`);
}

function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  return Buffer.from(typeof data === 'string' ? data : String(data), 'utf8');
}

/**
 * fsync a directory so a rename inside it is durable. POSIX only — on Windows
 * opening a directory fails, and NTFS already journals the metadata; the
 * failure is swallowed on purpose rather than turned into a spurious error.
 *
 * @param {string} dir
 */
export function fsyncDirSync(dir) {
  let fd;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch {
    // Not supported (Windows) or not permitted — best effort by design.
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

/**
 * Atomically write `data` to `file`.
 *
 * The parent directory must already exist — this helper does not create it, so
 * a mistyped path fails loudly instead of silently building a tree somewhere
 * unexpected.
 *
 * Permissions: `mode` is applied to the temp file that becomes the target, and
 * it is applied *before* the rename so the replacement is never briefly more
 * permissive than requested. Note that this makes `mode` authoritative on every
 * write — unlike a plain `writeFileSync`, an existing target's mode is not
 * preserved, because `rename` replaces the inode. On Windows the mode argument
 * is accepted but has no effect (there are no POSIX permission bits), which is
 * the platform's behaviour, not a silent failure of this helper.
 *
 * @param {string} file target path
 * @param {string|Buffer} data
 * @param {{mode?:number}} [opts] file mode for the target (POSIX; ignored on Windows)
 * @returns {string} the target path
 */
export function writeFileAtomicSync(file, data, { mode } = {}) {
  const tmp = tempPathFor(file);
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', mode === undefined ? 0o666 : mode);
    fs.writeSync(fd, toBuffer(data));
    // Re-apply the mode after writing: the create-mode is masked by the process
    // umask, so without this a caller asking for 0o600 would silently get a
    // wider file whenever the umask permits it. chmod is a no-op on Windows.
    if (mode !== undefined && process.platform !== 'win32') {
      try { fs.fchmodSync(fd, mode); } catch { /* best effort: not all filesystems support it */ }
    }
    fs.fsyncSync(fd);        // contents durable before the rename publishes them
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, file); // atomic within one filesystem
    fsyncDirSync(path.dirname(file));
  } catch (err) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
    try { fs.unlinkSync(tmp); } catch { /* temp may never have been created */ }
    throw err;
  }
  return file;
}

/**
 * Async form of {@link writeFileAtomicSync}, for callers already on the async
 * path. Same guarantees.
 *
 * @param {string} file
 * @param {string|Buffer} data
 * @param {{mode?:number}} [opts]
 * @returns {Promise<string>}
 */
export async function writeFileAtomic(file, data, opts = {}) {
  return writeFileAtomicSync(file, data, opts);
}

/** True when `p` is one of this module's temp files (used by tests/diagnostics). */
export function isAtomicTempPath(p) {
  return path.basename(String(p)).includes(TEMP_INFIX);
}
