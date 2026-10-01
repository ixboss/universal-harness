package com.universalharness.node

import java.io.File
import org.json.JSONObject

/**
 * The R-01 / TESTING.md §2a gate checks, as runnable functions. Each check returns evidence
 * (actual command output), never a hardcoded claim. These are the functions the instrumented
 * device test (Gate D) and future doctor integration call.
 */
class UhRuntimeChecks(
    private val paths: UhPaths,
    private val prootCommand: UhPRootCommand,
    private val installer: UhRuntimeInstaller,
) {
    data class Check(val name: String, val ok: Boolean, val evidence: String)

    fun prootCarrierPresent(): Check {
        val proot = File(prootNativeLibraryDir, "libproot.so")
        val loader = File(prootNativeLibraryDir, "libprootloader.so")
        return Check(
            "proot-carrier",
            proot.exists() && proot.canExecute() && loader.exists(),
            "libproot.so exists=${proot.exists()} canExecute=${proot.canExecute()}; " +
                "libprootloader.so exists=${loader.exists()}",
        )
    }

    fun unameReportsAarch64(): Check = runGuestCheck(
        "uname-aarch64",
        listOf("/bin/uname", "-m"),
        expected = { it == "aarch64" },
        expectedHint = "aarch64",
    )

    fun nodeIsPinnedVersion(): Check = runGuestCheck(
        "node-version",
        listOf("/usr/local/bin/node", "-v"),
        expected = { it == UhPins.NODE_VERSION },
        expectedHint = UhPins.NODE_VERSION,
    )

    fun dshIsPinnedVersion(): Check = runGuestCheck(
        "dsh-version",
        listOf("/usr/local/bin/dsh", "--version"),
        expected = { it.contains(UhPins.DSH_VERSION) },
        expectedHint = UhPins.DSH_VERSION,
    )

    /**
     * Starts `dsh --profile sdk`, performs a JSON-RPC initialize, verifies the response, and
     * shuts the process down with the bounded escalation. This is the Gate D stages
     * "SDK starts / initialize / shutdown" in one check.
     */
    suspend fun sdkInitializeRoundTrip(cwd: String = "/workspace"): Check {
        return try {
            val client = DshSdkClient(prootCommand)
            client.start(cwd)
            val result = client.initialize(cwd = cwd)
            val status = client.shutdown()
            Check(
                "sdk-initialize",
                !client.wasProtocolError(result) && status in 0..128,
                "initialize result keys=${result.keys().asSequence().toList().sorted()} shutdownStatus=$status",
            )
        } catch (e: Exception) {
            Check("sdk-initialize", false, e.message ?: e.javaClass.simpleName)
        }
    }

    private var prootNativeLibraryDir: String = ""
    fun withNativeLibraryDir(dir: String): UhRuntimeChecks = apply { prootNativeLibraryDir = dir }

    private fun runGuestCheck(
        name: String,
        guestCommand: List<String>,
        expected: (String) -> Boolean,
        expectedHint: String,
    ): Check = try {
        val output = installer.runGuest(guestCommand, timeoutMs = 60_000, failureHint = "guest execution failed")
            .lineSequence().firstOrNull { it.isNotBlank() }?.trim() ?: ""
        Check(name, expected(output), output)
    } catch (e: Exception) {
        Check(name, false, e.message ?: e.javaClass.simpleName)
    }
}

private fun DshSdkClient.wasProtocolError(result: JSONObject): Boolean =
    result.length() == 0 // an empty result means we could not confirm anything meaningful
