package com.universalharness.node

import java.io.File

/**
 * Filesystem layout for the Universal Harness Android node.
 *
 * Ownership split (ADR-004, adapted for Android per ADR-003 — everything lives in the app
 * sandbox; "portable" means exportable via SAF, never executable-from-USB):
 *  - `runtimeDir`   — the PRoot Ubuntu rootfs + downloaded artifacts (re-acquirable, never
 *                     authoritative);
 *  - `stateDir`     — install state and runtime reconciliation records (device-local);
 *  - `workspaceDir` — the portable project workspace (guest bind target `/workspace`);
 *  - secrets are NOT stored here: device-bound key material lives in Android Keystore
 *    (see [KeystoreCipher]); no credential ever hits the filesystem in plaintext.
 */
class UhPaths(filesDir: File, cacheDir: File) {
    val runtimeDir: File = File(filesDir, "uh-runtime")
    val downloadsDir: File = File(runtimeDir, "downloads")
    val stagingDir: File = File(runtimeDir, "staging")
    val rootfsDir: File = File(runtimeDir, "rootfs")
    val stateDir: File = File(filesDir, "uh-state")
    val installStateFile: File = File(stateDir, "install-state.json")
    val runtimeStateFile: File = File(stateDir, "runtime-state.json")
    val workspaceDir: File = File(filesDir, "uh-workspace")
    val tmpDir: File = File(cacheDir, "uh-tmp")

    init {
        runtimeDir.mkdirs(); downloadsDir.mkdirs(); stagingDir.mkdirs()
        rootfsDir.mkdirs(); stateDir.mkdirs(); workspaceDir.mkdirs(); tmpDir.mkdirs()
    }

    /** The guest-visible workspace mount point inside the PRoot rootfs. */
    val guestWorkspace: String = "/workspace"

    /** The guest path of the pinned dsh entry installed by npm -g. */
    val guestDshPath: String = "/usr/local/bin/dsh"

    val guestNodePath: String = "/usr/local/bin/node"
}
