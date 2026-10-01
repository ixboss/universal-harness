package com.universalharness.node

import java.io.File

/**
 * Builds the PRoot invocation for the Universal Harness Android runtime.
 *
 * The argv/env shape mirrors Mobile-Harness RuntimeInstaller.process() (audited, device-proven
 * for a sibling CLI): carrier-executed `libproot.so` from nativeLibraryDir, `-0` (fake root),
 * the rootfs, host binds for /dev /proc /sys and the read-only Android system trees, the
 * workspace bind, and the PRoot env (PROOT_NO_SECCOMP=1, PROOT_LOADER, GLIBC rseq disabled).
 * Deliberately omitted: the Android-SDK/Gradle guest tooling and the pocket-bridge mount,
 * which are Mobile-Harness agent features, not Universal Harness node features.
 *
 * `emulateHardLinks=false` is the default here because dsh saves through atomic temp-file
 * renames and PRoot's link2symlink emulation turns those into dangling .l2s links
 * (the same reason Mobile-Harness's DshRuntimeBridge disables it).
 */
class UhPRootCommand(
    private val paths: UhPaths,
    private val nativeLibraryDir: String,
) : GuestCommandSource {
    data class Command(val argv: List<String>, val environment: Map<String, String>, val cwd: String)

    override fun guestReady(): Boolean {
        val node = File(paths.rootfsDir, paths.guestNodePath.removePrefix("/"))
        val dsh = File(paths.rootfsDir, paths.guestDshPath.removePrefix("/"))
        return node.canExecute() && dsh.exists()
    }

    override fun buildDshSdkCommand(): Command =
        build(
            guestCommand = listOf(paths.guestDshPath, "--profile", "sdk"),
            environment = emptyMap(),
            emulateHardLinks = false,
        )

    fun build(
        guestCommand: List<String>,
        environment: Map<String, String> = emptyMap(),
        emulateHardLinks: Boolean = false,
        extraBinds: List<Pair<String, String>> = emptyList(),
    ): Command {
        val rootfs = paths.rootfsDir
        val proot = File(nativeLibraryDir, "libproot.so")
        val prootLoader = File(nativeLibraryDir, "libprootloader.so")
        check(proot.exists() && proot.canExecute()) {
            "libproot.so (carrier-executed PRoot) is missing from nativeLibraryDir"
        }
        check(prootLoader.exists()) { "libprootloader.so is missing from nativeLibraryDir" }

        val workspace = paths.workspaceDir
        workspace.mkdirs()
        File(rootfs, paths.guestWorkspace.removePrefix("/")).mkdirs()

        val args = buildList {
            add(proot.absolutePath)
            if (emulateHardLinks) add("--link2symlink")
            add("-0")
            add("-r")
            add(rootfs.absolutePath)
            add("-b"); add("/dev")
            add("-b"); add("/proc")
            add("-b"); add("/sys")
            listOf("/system", "/apex", "/vendor", "/product").forEach { hostPath ->
                if (File(hostPath).exists()) {
                    File(rootfs, hostPath.removePrefix("/")).mkdirs()
                    add("-b"); add(hostPath)
                }
            }
            add("-b"); add("${workspace.absolutePath}:${paths.guestWorkspace}")
            // Phase 3B: extra host→guest binds. The staged JS node is mounted
            // read-only so the guest runs the exact bytes the APK shipped.
            for ((hostPath, guestPath) in extraBinds) {
                add("-b"); add("$hostPath:$guestPath")
            }
            add("-w"); add(paths.guestWorkspace)
            addAll(guestCommand)
        }

        val prootTmp = File(paths.tmpDir, "proot-tmp").apply { mkdirs() }
        val env = buildMap {
            put("HOME", "/root")
            put("PATH", "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin")
            put("LANG", "C.UTF-8")
            put("LD_LIBRARY_PATH", nativeLibraryDir)
            put("PROOT_NO_SECCOMP", "1")
            put("PROOT_TMP_DIR", prootTmp.absolutePath)
            put("PROOT_LOADER", prootLoader.absolutePath)
            put("GLIBC_TUNABLES", "glibc.pthread.rseq=0")
            putAll(environment)
        }
        return Command(args, env, paths.rootfsDir.absolutePath)
    }
}
