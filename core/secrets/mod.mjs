// Secret storage bound to the device (spec §5/§15).
//
// Secrets (provider API keys, future pairing keys) must never be written as
// plaintext into the portable tree. OS secure storage per platform:
//   Windows  DPAPI (CurrentUser scope) through a PowerShell child
//   macOS    Keychain through the `security` CLI
//   Linux    libsecret through `secret-tool`
// On every other platform (or when the platform's tool is missing) the store
// fails *explicitly* (SECURE_STORAGE_UNAVAILABLE) rather than silently
// degrading to plaintext — per the hard rule in the brief.
//
// The secret is fed to the backend over stdin (libsecret, PowerShell) or, on
// macOS only, as the `-w` argument the `security` CLI requires (visible to a
// same-user process listing for the lifetime of the call — an accepted,
// documented limitation). All logging goes through the redactor. Nothing here
// ever touches data/.

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { UhError, ERR } from '../errors/mod.mjs';
import { devicePaths } from '../paths/mod.mjs';
import { isWindows } from '../platform/mod.mjs';

const ENV_NAME = 'UH_SECRET_BACKEND';
const KEYCHAIN_SERVICE = 'com.universal-harness.secrets';

const PLATFORM_BACKENDS = {
  win32: 'dpapi',
  darwin: 'keychain',
  linux: 'libsecret',
};

/** A tool is "present" when it can be found and executed on PATH. */
function toolAvailable(command, args = ['--help']) {
  try {
    const r = spawnSync(command, args, { stdio: 'ignore', windowsHide: true });
    // status null + error ENOENT ⇒ not found; any exit code ⇒ present.
    return r.error == null;
  } catch {
    return false;
  }
}

/**
 * @param {Object} opts { root, p }
 */
export function createSecureStorage({ root, p }) {
  const dp = devicePaths(p);
  const storeDir = path.join(dp.secure, 'secrets');
  const platformBackend = PLATFORM_BACKENDS[process.platform] || null;
  const toolMissing = platformBackend === 'keychain' && !toolAvailable('security')
    || platformBackend === 'libsecret' && !toolAvailable('secret-tool');
  const backend = process.env[ENV_NAME] || (platformBackend && !toolMissing ? platformBackend : 'unavailable');
  const SUPPORTED = isWindows || platformBackend != null;

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
  function runPowerShell(script, input, { env = {} } = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        // Audit 1.5: values the script needs (file paths) arrive through the
        // environment, never interpolated into the script text — a path with
        // an apostrophe (e.g. C:\Users\O'Brien\…) would break the quoting.
        env: { ...process.env, ...env },
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

  /** Run a CLI tool with `input` on stdin; resolve stdout on exit 0. */
  function runTool(command, args, input, what) {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (c) => { out += c; });
      let errText = '';
      child.stderr.on('data', (c) => { errText += c; });
      child.on('error', (e) => reject(new UhError(ERR.SECURE_STORAGE_UNAVAILABLE,
        `${what} (${command}) could not start`, { detail: e.message },
        'Install the OS secure-storage tooling for this platform.')));
      child.on('exit', (code) => {
        if (code !== 0) reject(new UhError(ERR.SECURE_STORAGE_UNAVAILABLE,
          `${what} exited ${code}`, { detail: redact(errText).slice(0, 200) }));
        else resolve(out);
      });
      if (input != null) child.stdin.end(input);
    });
  }

  async function set(name, value) {
    assertAvailable(backend);
    fs.mkdirSync(storeDir, { recursive: true });
    if (backend === 'dpapi') {
      const tmp = path.join(storeDir, `${randomUUID()}.tmp`);
      const input = Buffer.from(value, 'utf8').toString('base64');
      // DPAPI seal (CurrentUser scope): the blob is only reversible by this
      // Windows user on this machine.
      // Audit 1.5: the temp path is passed through the environment, not
      // interpolated into the script (single-quoted PowerShell strings cannot
      // contain a literal ' — an apostrophe in the user profile path would
      // break the command).
      const dpapiScript = `$ErrorActionPreference='Stop'; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $plain=[Text.Encoding]::UTF8.GetString($b); $s=ConvertTo-SecureString $plain -AsPlainText -Force; ConvertFrom-SecureString $s | Out-File -FilePath $env:UH_DPAPI_TMP -Encoding ASCII -NoNewline`;
      await runPowerShell(dpapiScript, input, { env: { UH_DPAPI_TMP: tmp } }).catch((e) => { fs.rmSync(tmp, { force: true }); throw e; });
      fs.renameSync(tmp, fileFor(name));
    } else if (backend === 'keychain') {
      // The value must ride as the -w argument (the CLI has no stdin mode);
      // it is visible to a same-user `ps` for the lifetime of the call.
      await runTool('security', ['add-generic-password', '-a', name, '-s', KEYCHAIN_SERVICE, '-U', '-w', value], null,
        'macOS Keychain secure storage');
    } else if (backend === 'libsecret') {
      // secret-tool reads the secret from stdin — never a command line.
      await runTool('secret-tool', ['store', '--label=Universal Harness secret', 'uh-secret', name], value,
        'Linux libsecret secure storage');
    } else {
      throw new UhError(ERR.SECURE_STORAGE_UNAVAILABLE, `secret backend '${backend}' cannot store secrets`, {},
        'Secrets are only stored in OS secure storage; refusing to fall back to plaintext.');
    }
    return { name, backend };
  }

  async function get(name) {
    assertAvailable(backend);
    if (backend === 'dpapi') {
      const file = fileFor(name);
      if (!fs.existsSync(file)) return null;
      const blob = fs.readFileSync(file, 'utf8').trim();
      const script = `$ErrorActionPreference='Stop'; $s=ConvertTo-SecureString -String ([Console]::In.ReadToEnd()) ; [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))`;
      const plain = await runPowerShell(script, blob);
      return plain;
    }
    if (backend === 'keychain') {
      return await runTool('security', ['find-generic-password', '-a', name, '-s', KEYCHAIN_SERVICE, '-w'], null,
        'macOS Keychain secure storage').then((out) => out.replace(/\n$/, ''), (e) => {
        if (/could not be found|The specified item could not be found/i.test(e.message + String(e.details?.detail || ''))) return null;
        throw e;
      });
    }
    if (backend === 'libsecret') {
      return await runTool('secret-tool', ['lookup', 'uh-secret', name], null, 'Linux libsecret secure storage')
        .then((out) => (out === '' ? null : out.replace(/\n$/, '')), () => null); // lookup exits 1 when absent
    }
    return null;
  }

  async function remove(name) {
    assertAvailable(backend);
    if (backend === 'dpapi') {
      const file = fileFor(name);
      if (fs.existsSync(file)) { fs.rmSync(file); return { name, deleted: true }; }
      return { name, deleted: false };
    }
    if (backend === 'keychain') {
      try {
        await runTool('security', ['delete-generic-password', '-a', name, '-s', KEYCHAIN_SERVICE], null, 'macOS Keychain secure storage');
        return { name, deleted: true };
      } catch { return { name, deleted: false }; }
    }
    if (backend === 'libsecret') {
      try {
        await runTool('secret-tool', ['clear', 'uh-secret', name], null, 'Linux libsecret secure storage');
        return { name, deleted: true };
      } catch { return { name, deleted: false }; }
    }
    return { name, deleted: false };
  }

  function describe() {
    return {
      backend,
      supported: SUPPORTED,
      storeDir,
      note: backend === 'dpapi'
        ? 'Windows DPAPI (CurrentUser scope); blobs live under the OS user directory and never travel with the portable drive.'
        : backend === 'keychain'
          ? 'macOS Keychain via the `security` CLI; items live under the login keychain, service ' + KEYCHAIN_SERVICE + '.'
          : backend === 'libsecret'
            ? 'Linux libsecret via `secret-tool`; items live in the default secret collection, attributes uh-secret=<name>.'
            : 'No OS secure storage available; setSecret fails explicitly instead of storing plaintext.',
    };
  }

  function locationDescription() {
    return backend === 'dpapi' ? 'device-bound DPAPI blob store'
      : backend === 'keychain' ? 'login Keychain (security CLI)'
      : backend === 'libsecret' ? 'default secret collection (secret-tool)'
      : 'none';
  }

  return { set, get, remove, describe, locationDescription };
}

function assertAvailable(backend) {
  if (backend === 'unavailable') {
    throw new UhError(ERR.SECURE_STORAGE_UNAVAILABLE,
      'OS secure storage is not available on this platform',
      { platform: process.platform },
      'Store the provider key in your OS credential store (recommended) or set it via DEEPSEEK_API_KEY / the dsh credentials file. Universal Harness will not write plaintext secrets into the portable workspace.');
  }
}
