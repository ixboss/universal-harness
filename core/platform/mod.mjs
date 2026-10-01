// Platform detection and normalization.
//
// Phase 1 scope: Windows x64 (primary) and Linux x64. macOS Apple Silicon is
// supported in the runtime manifest and code paths but is NOT verified (see
// COMPATIBILITY.md) — no real Apple-Silicon hardware has run this.

import os from 'node:os';
import path from 'node:path';

/** Normalized platform id used everywhere in Universal Harness. */
export const PLATFORM = (() => {
  switch (process.platform) {
    case 'win32': return 'win';
    case 'darwin': return 'macos';
    default: return process.platform; // linux, etc.
  }
})();

/** Normalized architecture id. */
export const ARCH = process.arch === 'ia32' ? 'x64' : process.arch;

/** Runtime target string used by the manifest: `win-x64`, `linux-x64`, `macos-arm64`. */
export const RUNTIME_TARGET = `${PLATFORM}-${ARCH}`;

export const isWindows = PLATFORM === 'win';
export const isLinux = PLATFORM === 'linux';
export const isMacos = PLATFORM === 'macos';

/** Name of the node executable on the current platform. */
export const nodeExeName = isWindows ? 'node.exe' : 'node';

/**
 * Relative path of the npm CLI inside a stock Node distribution.
 *
 * The layout differs between distribution formats: the Windows zip ships npm
 * at `node_modules/npm`, while the POSIX tarballs ship it under
 * `lib/node_modules/npm`.
 */
export const npmCliRelPath = isWindows
  ? 'node_modules/npm/bin/npm-cli.js'
  : 'lib/node_modules/npm/bin/npm-cli.js';

/**
 * Every supported runtime target. Manifest entries must exist for all of them
 * so that a portable drive prepared on one OS can be verified on another.
 * `linux-arm64` exists for the Phase 3 Android execution node (bundled arm64
 * Node under the PRoot Ubuntu rootfs); it is a declared runtime target, NOT a
 * verification claim — R-01 remains unresolved until the real-device gate.
 */
export const SUPPORTED_TARGETS = ['win-x64', 'linux-x64', 'macos-arm64', 'linux-arm64'];

/**
 * Report platform facts used by diagnostics. Nothing here is secret.
 *
 * @returns {{platform:string, arch:string, target:string, nodeVersion:string,
 *   osType:string, osRelease:string, osVersion:string, hostname:string,
 *   cpus:number, totalMemBytes:number, endianness:string}}
 */
export function platformInfo() {
  return {
    platform: PLATFORM,
    arch: ARCH,
    target: RUNTIME_TARGET,
    nodeVersion: process.version,
    osType: os.type(),
    osRelease: os.release(),
    osVersion: os.version(),
    hostname: os.hostname(),
    cpus: os.cpus().length,
    totalMemBytes: os.totalmem(),
    endianness: os.endianness(),
  };
}

/**
 * Locate the device-bound state directory for this machine.
 *
 * Device-bound state (secure secrets, device identity, caches) must never
 * travel with the portable drive, so it lives under the OS user directory
 * rather than inside the Universal Harness root.
 *
 * @returns {string} absolute path to the device-bound state directory
 */
export function deviceStateDir() {
  const base = isWindows
    ? (process.env.LOCALAPPDATA || os.homedir())
    : os.homedir();
  return path.join(base, isWindows ? 'UniversalHarness' : '.universal-harness');
}


