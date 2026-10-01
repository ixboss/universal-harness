package com.universalharness.node

import java.io.File
import org.json.JSONObject

/**
 * Installs and verifies the Universal Harness Android runtime, stage by stage:
 *
 *   rootfs    — Ubuntu 20.04.5 arm64 base (SHA-256 verified), safely extracted;
 *   node      — official Node.js v24.21.0 linux-arm64 (SHA-256 verified) into /usr/local;
 *   bootstrap — guest network basics (resolv.conf, ca-certificates via apt) so npm works;
 *   dsh       — pinned @deepseek-ai/dsh@0.2.0-rc.2 installed with the guest's npm;
 *   verify    — uname/node/dsh version checks run inside PRoot; only now is the runtime
 *               "installed", and the recorded pins must match on every later start.
 *
 * Every stage is idempotent and resumable: state survives interruption via
 * [InstallStateStore], and a stage whose recorded pin differs from the requested pin is
 * redone. A partial install is never reported complete.
 */
class UhRuntimeInstaller(
    private val paths: UhPaths,
    private val prootCommandFactory: UhPRootCommand,
    private val state: InstallStateStore = InstallStateStore(paths.installStateFile),
    private val clock: () -> String = { java.time.Instant.now().toString() },
) {
    data class Progress(val stage: String, val message: String, val fraction: Float)

    class InstallException(message: String) : Exception(message)

    suspend fun installAll(onProgress: suspend (Progress) -> Unit = {}) {
        installRootfs(onProgress)
        installNode(onProgress)
        bootstrapGuest(onProgress)
        installDsh(onProgress)
        verifyRuntime(onProgress)
    }

    fun isInstalled(): Boolean =
        state.allStages().keys.containsAll(listOf(STAGE_ROOTFS, STAGE_NODE, STAGE_BOOTSTRAP, STAGE_DSH, STAGE_VERIFY))

    suspend fun installRootfs(onProgress: suspend (Progress) -> Unit) {
        if (state.isStageDone(STAGE_ROOTFS, UhPins.UBUNTU_BASE_SHA256)) return
        onProgress(Progress(STAGE_ROOTFS, "downloading Ubuntu 20.04.5 arm64 base (SHA-256 pinned)", 0.05f))
        val archive = VerifiedFetcher.fetch(
            UhPins.UBUNTU_BASE_URL,
            File(paths.downloadsDir, "ubuntu-base-20.04.5-base-arm64.tar.gz"),
            UhPins.UBUNTU_BASE_SHA256,
        )
        onProgress(Progress(STAGE_ROOTFS, "extracting into staging", 0.35f))
        val staging = File(paths.stagingDir, "rootfs").apply { deleteRecursively(); mkdirs() }
        SafeTarExtractor.extractGzipTar(archive, staging)
        onProgress(Progress(STAGE_ROOTFS, "activating rootfs", 0.8f))
        swapIntoPlace(staging, paths.rootfsDir)
        writeResolvConf()
        state.markDone(STAGE_ROOTFS, UhPins.UBUNTU_BASE_SHA256, clock())
        onProgress(Progress(STAGE_ROOTFS, "rootfs installed and pinned", 1f))
    }

    suspend fun installNode(onProgress: suspend (Progress) -> Unit) {
        // The done-pin alone is not enough: an install completed by an older build may lack the
        // npm/npx links (see linkGuestBins). Re-running is cheap — the download is cached and
        // verified — and it repairs such a runtime instead of leaving npm unreachable.
        if (state.isStageDone(STAGE_NODE, UhPins.NODE_SHA256) && guestBinsLinked()) return
        require(state.isStageDone(STAGE_ROOTFS, UhPins.UBUNTU_BASE_SHA256)) { "rootfs stage is not complete" }
        onProgress(Progress(STAGE_NODE, "downloading Node.js ${UhPins.NODE_VERSION} linux-arm64 (SHA-256 pinned)", 0.1f))
        val archive = VerifiedFetcher.fetch(
            UhPins.NODE_URL,
            File(paths.downloadsDir, "node-${UhPins.NODE_VERSION}-linux-arm64.tar.gz"),
            UhPins.NODE_SHA256,
        )
        onProgress(Progress(STAGE_NODE, "extracting Node into staging", 0.5f))
        val staging = File(paths.stagingDir, "node").apply { deleteRecursively(); mkdirs() }
        SafeTarExtractor.extractGzipTar(archive, staging)
        val extracted = File(staging, UhPins.NODE_ARCHIVE_ROOT)
        val nodeBin = File(extracted, "bin/node")
        if (!nodeBin.canExecute()) {
            throw InstallException("extracted Node distribution is missing bin/node")
        }
        onProgress(Progress(STAGE_NODE, "activating Node under /usr/local", 0.85f))
        val libNodejs = File(paths.rootfsDir, "usr/local/lib/nodejs").apply { mkdirs() }
        val target = File(libNodejs, UhPins.NODE_ARCHIVE_ROOT).apply { deleteRecursively() }
        if (!extracted.renameTo(target)) {
            extracted.copyRecursively(target, overwrite = true)
        }
        staging.deleteRecursively()
        val localBin = File(paths.rootfsDir, "usr/local/bin").apply { mkdirs() }
        linkGuestBins(localBin)
        state.markDone(STAGE_NODE, UhPins.NODE_SHA256, clock())
        onProgress(Progress(STAGE_NODE, "Node installed and pinned", 1f))
    }

    /** Guest needs DNS + TLS trust before npm can reach the registry. */
    suspend fun bootstrapGuest(onProgress: suspend (Progress) -> Unit) {
        if (state.isStageDone(STAGE_BOOTSTRAP, null)) return
        onProgress(Progress(STAGE_BOOTSTRAP, "installing guest ca-certificates (apt)", 0.4f))
        writeResolvConf()
        // An interrupted bootstrap (app killed, OOM) leaves dpkg with unpacked-but-unconfigured
        // packages, and apt then refuses to proceed until the database is reconciled. This is
        // an idempotent no-op on a clean rootfs, so it runs unconditionally before apt.
        runGuest(
            listOf("/usr/bin/dpkg", "--configure", "-a"),
            timeoutMs = 300_000,
            failureHint = "dpkg --configure -a failed; the guest package database is inconsistent",
            emulateHardLinks = true,
        )
        // dpkg backs up its status database with a hard link (status -> status-old), and
        // Android denies linkat(2) to apps — confirmed on the real device as
        // "error creating new backup file '/var/lib/dpkg/status-old': Permission denied".
        // PRoot's --link2symlink emulation is what makes apt usable here, so it is on for
        // the bootstrap only. The dsh SDK path keeps it off: dsh saves through atomic
        // temp-file renames and the emulation would turn those into dangling .l2s links.
        runGuest(
            listOf("/usr/bin/apt-get", "update"),
            timeoutMs = 180_000,
            failureHint = "apt-get update failed; the device needs working network access for the one-time guest bootstrap",
            emulateHardLinks = true,
        )
        runGuest(
            listOf("/usr/bin/apt-get", "install", "-y", "--no-install-recommends", "ca-certificates"),
            timeoutMs = 300_000,
            failureHint = "apt-get install ca-certificates failed",
            emulateHardLinks = true,
        )
        state.markDone(STAGE_BOOTSTRAP, null, clock())
        onProgress(Progress(STAGE_BOOTSTRAP, "guest bootstrap complete", 1f))
    }

    suspend fun installDsh(onProgress: suspend (Progress) -> Unit) {
        // As with the Node stage, the done-pin alone does not prove the binary is on the guest
        // PATH: npm's default global prefix is derived from node's location, which puts dsh
        // under the distribution prefix instead of /usr/local/bin. Re-running repairs it.
        if (state.isStageDone(STAGE_DSH, UhPins.DSH_TARBALL_SHA512) && guestDshPresent()) return
        require(state.isStageDone(STAGE_NODE, UhPins.NODE_SHA256)) { "node stage is not complete" }
        onProgress(Progress(STAGE_DSH, "installing ${UhPins.DSH_PACKAGE}@${UhPins.DSH_VERSION} with the guest npm", 0.3f))
        runGuest(
            listOf(
                "/usr/local/bin/npm", "install", "-g",
                "--prefix", "/usr/local",
                "--omit=dev", "--no-audit", "--no-fund", "--exact",
                "${UhPins.DSH_PACKAGE}@${UhPins.DSH_VERSION}",
            ),
            timeoutMs = 600_000,
            failureHint = "npm install of the pinned dsh failed (network or registry problem)",
        )
        state.markDone(STAGE_DSH, UhPins.DSH_TARBALL_SHA512, clock())
        onProgress(Progress(STAGE_DSH, "dsh installed and pinned", 1f))
    }

    /** The R-01 core checks: real execution of the guest kernel identity, Node, and dsh. */
    suspend fun verifyRuntime(onProgress: suspend (Progress) -> Unit): Map<String, String> {
        onProgress(Progress(STAGE_VERIFY, "executing uname -m inside PRoot", 0.2f))
        val uname = runGuest(listOf("/bin/uname", "-m"), timeoutMs = 60_000, failureHint = "uname failed")
            .firstLine()
        if (uname != "aarch64") {
            throw InstallException("uname -m reported '$uname', expected aarch64")
        }
        onProgress(Progress(STAGE_VERIFY, "executing the bundled Node", 0.5f))
        val nodeVersion = runGuest(listOf("/usr/local/bin/node", "-v"), timeoutMs = 60_000, failureHint = "node -v failed")
            .firstLine()
        if (nodeVersion != UhPins.NODE_VERSION) {
            throw InstallException("node -v reported '$nodeVersion', expected ${UhPins.NODE_VERSION}")
        }
        onProgress(Progress(STAGE_VERIFY, "verifying the pinned dsh", 0.8f))
        val dshVersion = runGuest(listOf("/usr/local/bin/dsh", "--version"), timeoutMs = 120_000, failureHint = "dsh --version failed")
            .firstLine()
        if (!dshVersion.contains(UhPins.DSH_VERSION)) {
            throw InstallException("dsh --version reported '$dshVersion', expected ${UhPins.DSH_VERSION}")
        }
        state.markDone(STAGE_VERIFY, UhPins.DSH_TARBALL_SHA512, clock())
        onProgress(Progress(STAGE_VERIFY, "runtime verified: aarch64 / ${UhPins.NODE_VERSION} / ${UhPins.DSH_VERSION}", 1f))
        return mapOf(
            "uname" to uname,
            "node" to nodeVersion,
            "dsh" to dshVersion,
        )
    }

    /** Runs a guest command through PRoot to completion, returning trimmed stdout. */
    fun runGuest(
        guestCommand: List<String>,
        timeoutMs: Long,
        failureHint: String,
        emulateHardLinks: Boolean = false,
    ): String {
        val cmd = prootCommandFactory.build(guestCommand, emulateHardLinks = emulateHardLinks)
        val process = UhNativeProcess.start(cmd.argv, cmd.environment, cmd.cwd)
        val stdout = process.stdoutStream().bufferedReader().readText()
        val stderrTail = process.stderrStream().bufferedReader().readLines().takeLast(20)
        val status = process.waitFor(timeoutMs)
        if (status == UhNativeProcess.STILL_RUNNING) {
            process.destroyForcibly()
            throw InstallException("guest command timed out after ${timeoutMs}ms: ${guestCommand.first()}; $failureHint")
        }
        if (status != 0) {
            throw InstallException(
                "guest command failed (status $status): ${guestCommand.joinToString(" ")}; " +
                    "$failureHint; stderr: ${stderrTail.joinToString(" | ").take(500)}",
            )
        }
        return stdout
    }

    private fun swapIntoPlace(staging: File, target: File) {
        val previous = File(target.parentFile, target.name + ".previous")
        previous.deleteRecursively()
        if (target.exists() && !target.renameTo(previous)) {
            throw InstallException("could not move the previous rootfs aside")
        }
        if (!staging.renameTo(target)) {
            previous.renameTo(target) // restore
            throw InstallException("could not activate the staged rootfs")
        }
        previous.deleteRecursively()
    }

    private fun writeResolvConf() {
        val etc = File(paths.rootfsDir, "etc").apply { mkdirs() }
        // Android's netd DNS is not visible inside PRoot; use public resolvers for the
        // one-time npm/apt bootstrap, matching Mobile-Harness's bootstrap script.
        File(etc, "resolv.conf").writeText("nameserver 1.1.1.1\nnameserver 8.8.8.8\n")
    }

    /**
     * The Node distribution ships node/npm/npx in its own bin/ — npm and npx are symlinks into
     * lib/node_modules carrying a `#!/usr/bin/env node` shebang. Expose all three on the guest
     * PATH so `npm` is reachable; the shebang resolves through /usr/local/bin/node.
     */
    private fun linkGuestBins(localBin: File) {
        listOf("node", "npm", "npx").forEach { name ->
            val link = File(localBin, name)
            link.delete()
            createGuestSymlink(link, "../lib/nodejs/${UhPins.NODE_ARCHIVE_ROOT}/bin/$name")
        }
    }

    private fun guestBinsLinked(): Boolean =
        listOf("node", "npm", "npx").all { File(paths.rootfsDir, "usr/local/bin/$it").exists() }

    private fun guestDshPresent(): Boolean =
        File(paths.rootfsDir, paths.guestDshPath.removePrefix("/")).exists()

    private fun createGuestSymlink(link: File, target: String) {
        try {
            java.nio.file.Files.createSymbolicLink(link.toPath(), java.nio.file.Paths.get(target))
        } catch (_: java.nio.file.FileAlreadyExistsException) {
            // already linked from a previous run
        }
    }

    private fun String.firstLine(): String = lineSequence().firstOrNull { it.isNotBlank() }?.trim() ?: ""

    companion object {
        const val STAGE_ROOTFS = "rootfs"
        const val STAGE_NODE = "node"
        const val STAGE_BOOTSTRAP = "bootstrap"
        const val STAGE_DSH = "dsh"
        const val STAGE_VERIFY = "verify"
    }
}
