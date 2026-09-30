// Secret storage bound to the device (spec §5/§15).
//
// Secrets (provider API keys, future pairing keys) must never be written as
// plaintext into the portable tree. On Windows this implements real OS secure
// storage: values are sealed with DPAPI through a PowerShell child process and
// the resulting blob is kept under the OS user directory. On every other
// platform the store fails *explicitly* (SECURE_STORAGE_UNAVAILABLE) rather
// than silently degrading to plaintext — per the hard rule in the brief.
//
// The secret is fed to PowerShell over stdin (never on the command line), and
// all logging goes through the redactor. Nothing here ever touches data/.

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { UhError, ERR } from '../errors/mod.mjs';
import { devicePaths } from '../paths/mod.mjs';
import { isWindows } from '../platform/mod.mjs';

const SUPPORTED = isWindows;
const ENV_NAME = 'UH_SECRET_BACKEND';

/**
 * @param {Object} opts { root, p }
 */
export function createSecureStorage({ root, p }) {
  const dp = devicePaths(p);
  const storeDir = path.join(dp.secure, 'secrets');
  const backend = process.env[ENV_NAME] || (SUPPORTED ? 'dpapi' : 'unavailable');

  function fileFor(name) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) {
      throw new UhError(ERR.UH_INTERNAL, 'secret name must match [A-Za-z0-9._-]{1,64}', { name });
    }
    return path.join(storeDir, name + '.blob');
  }

  /**
   * Run a PowerShell snippet, piping `input` over stdin and capturing stdout.
   * Any failure becomes SECURE_STORAGE_UNAVAILABLE with the PowerShell-free
   * reason — never a trace of the secret itself.
   */
  function runPowerShell(script, input) {
    return new Promise((resolve, reject) => {
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let out = '';
      child.stdout.on('data', (c) => { out += c; });
      child.on('error', (e) => reject(new UhError(ERR.SECURE_STORAGE_UNAVAILABLE,
        'Windows secure storage backend (PowerShell) could not start', { detail: e.message },
        'PowerShell is required for DPAPI-backed secret storage on Windows.')));
      let errText = '';
      child.stderr.on('data', (c) => { errText += c; });
      child.on('exit', (code) => {
        if (code !== 0) reject(new UhError(ERR.SECURE_STORAGE_UNAVAILABLE,
          `Windows secure storage backend exited ${code}`, { detail: redact(errText).slice(0, 200) },
          'Verify PowerShell is available and not blocked by policy.'));
        else resolve(out.trim());
      });
      child.stdin.end(input);
    });
  }

  async function set(name, value) {
    assertAvailable(backend);
    fs.mkdirSync(storeDir, { recursive: true });
    // DPAPI seal (CurrentUser scope): the blob is only reversible by this
    // Windows user on this machine. Base64 keeps the transport binary-safe.
    if (backend === 'dpapi') {
      const tmp = path.join(storeDir, `${randomUUID()}.tmp`);
      const input = Buffer.from(value, 'utf8').toString('base64');
      // DPAPI seal (CurrentUser scope): the blob is only reversible by this
      // Windows user on this machine.
      const dpapiScript = `$ErrorActionPreference='Stop'; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $plain=[Text.Encoding]::UTF8.GetString($b); $s=ConvertTo-SecureString $plain -AsPlainText -Force; ConvertFrom-SecureString $s | Out-File -FilePath '${tmp}' -Encoding ASCII -NoNewline`;
      await runPowerShell(dpapiScript, input).catch((e) => { fs.rmSync(tmp, { force: true }); throw e; });
      fs.renameSync(tmp, fileFor(name));
    } else {
      throw new UhError(ERR.SECURE_STORAGE_UNAVAILABLE, `secret backend '${backend}' cannot store secrets`, {},
        'Secrets are only stored in OS secure storage; refusing to fall back to plaintext.');
    }
    return { name, backend };
  }

  async function get(name) {
    assertAvailable(backend);
    const file = fileFor(name);
    if (!fs.existsSync(file)) return null;
    if (backend === 'dpapi') {
      const blob = fs.readFileSync(file, 'utf8').trim();
      const script = `$ErrorActionPreference='Stop'; $s=ConvertTo-SecureString -String ([Console]::In.ReadToEnd()) ; [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))`;
      const plain = await runPowerShell(script, blob);
      return plain;
    }
    return null;
  }

  async function remove(name) {
    const file = fileFor(name);
    if (fs.existsSync(file)) { fs.rmSync(file); return { name, deleted: true }; }
    return { name, deleted: false };
  }

  function describe() {
    return {
      backend,
      supported: SUPPORTED,
      storeDir,
      note: backend === 'dpapi'
        ? 'Windows DPAPI (CurrentUser scope); blobs live under the OS user directory and never travel with the portable drive.'
        : 'No OS secure storage implemented for this platform; setSecret fails explicitly instead of storing plaintext.',
    };
  }

  function locationDescription() {
    return backend === 'dpapi' ? 'device-bound DPAPI blob store' : 'none';
  }

  return { set, get, remove, describe, locationDescription };
}

function assertAvailable(backend) {
  if (!SUPPORTED || backend === 'unavailable') {
    throw new UhError(ERR.SECURE_STORAGE_UNAVAILABLE,
      'OS secure storage is not available on this platform',
      { platform: process.platform },
      'Store the provider key in your OS credential store (recommended) or set it via DEEPSEEK_API_KEY / the dsh credentials file. Universal Harness will not write plaintext secrets into the portable workspace.');
  }
}
