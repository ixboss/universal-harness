package com.universalharness.node

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import org.junit.Assert.assertTrue
import org.junit.FixMethodOrder
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.MethodSorters

/**
 * Gate D — real ARM64 execution checks (TESTING.md §2a / R-01).
 *
 * Run on a real arm64 device:
 *
 *     adb shell am instrument -w -e uhInstallRuntime true \
 *       com.jarves.mh.test/com.universalharness.node.UhGateDInstrumentedTest
 *
 * `uhInstallRuntime true` runs the full on-device runtime install (downloads + extraction +
 * guest bootstrap + npm dsh install). Without it, only checks that do not need the install
 * run. Every check prints `UH-GATE-D:` evidence lines to the instrumentation stream and
 * appends to files/uh-state/gate-d-evidence.txt — no canned claims.
 */
@RunWith(AndroidJUnit4::class)
@FixMethodOrder(MethodSorters.NAME_ASCENDING)
class UhGateDInstrumentedTest {
    private val args = InstrumentationRegistry.getArguments()
    private val runtime: UhNodeRuntime by lazy {
        UhNode.create(InstrumentationRegistry.getInstrumentation().targetContext)
    }
    private val evidenceFile: File by lazy {
        File(runtime.paths.stateDir, "gate-d-evidence.txt")
    }

    private fun evidence(line: String) {
        println("UH-GATE-D: $line")
        evidenceFile.appendText(line + "\n")
    }

    /** 01 — restart reconciliation must never resurrect a running session. */
    @Test
    fun a01_reconcileAfterRestart() {
        val previous = runtime.reconcileAfterRestart()
        evidence("reconcile: previous=${previous?.state ?: "none"} pid=${previous?.pid}")
        assertTrue(
            "a restarted app must never report a running guest",
            previous?.state != "running",
        )
    }

    /** 02 — the PRoot carrier binaries are packaged and executable. */
    @Test
    fun a02_prootCarrierPackaged() {
        val check = runtime.checks.prootCarrierPresent()
        evidence("proot-carrier: ok=${check.ok} evidence=${check.evidence}")
        assertTrue(check.evidence, check.ok)
    }

    /** 03 — optional full install (downloads on device; idempotent and resumable). */
    @Test
    fun a03_installRuntimeIfRequested() {
        val requested = args.getString("uhInstallRuntime", "false").toBoolean()
        if (!requested) {
            evidence("install: skipped (pass -e uhInstallRuntime true to run)")
            return
        }
        evidence("install: requested — running staged install (rootfs/node/bootstrap/dsh/verify)")
        val statuses = mutableListOf<String>()
        kotlinx.coroutines.runBlocking {
            runtime.installer.installAll { p ->
                val line = "install ${p.stage}: ${(p.fraction * 100).toInt()}% ${p.message}"
                println("UH-GATE-D: $line")
                statuses.add(line)
            }
        }
        evidence("install: completed; ${statuses.size} progress events")
        assertTrue("runtime must be installed after installAll", runtime.installer.isInstalled())
    }

    /** 04 — uname -m inside PRoot must report aarch64. */
    @Test
    fun b04_unameReportsAarch64() {
        assumeInstalled()
        val check = runtime.checks.unameReportsAarch64()
        evidence("uname: ok=${check.ok} output=${check.evidence}")
        assertTrue("uname -m ${check.evidence}", check.ok)
    }

    /** 05 — the bundled Node must be exactly the pinned version. */
    @Test
    fun b05_nodeVersion() {
        assumeInstalled()
        val check = runtime.checks.nodeIsPinnedVersion()
        evidence("node-version: ok=${check.ok} output=${check.evidence}")
        assertTrue("node -v ${check.evidence}", check.ok)
    }

    /** 06 — the Node process must report an arm64 architecture. */
    @Test
    fun b06_nodeArchitecture() {
        assumeInstalled()
        val output = runtime.installer.runGuest(
            listOf("/usr/local/bin/node", "-p", "process.arch"),
            timeoutMs = 60_000,
            failureHint = "node -p process.arch failed",
        ).trim()
        evidence("node-arch: output=$output")
        assertTrue("process.arch must be arm64, got: $output", output == "arm64")
    }

    /** 07 — the pinned dsh must be installed and executable. */
    @Test
    fun b07_dshVersion() {
        assumeInstalled()
        val check = runtime.checks.dshIsPinnedVersion()
        evidence("dsh-version: ok=${check.ok} output=${check.evidence}")
        assertTrue("dsh --version ${check.evidence}", check.ok)
    }

    /** 08 — the SDK seam: dsh --profile sdk + JSON-RPC initialize + clean shutdown. */
    @Test
    fun c08_sdkInitializeRoundTrip() = kotlinx.coroutines.runBlocking {
        assumeInstalled()
        val check = runtime.checks.sdkInitializeRoundTrip()
        evidence("sdk-initialize: ok=${check.ok} evidence=${check.evidence}")
        assertTrue("SDK initialize round trip: ${check.evidence}", check.ok)
    }

    private fun assumeInstalled() {
        if (!runtime.installer.isInstalled()) {
            evidence("SKIPPED: runtime not installed yet (run with -e uhInstallRuntime true first)")
            org.junit.Assume.assumeTrue(false)
        }
    }
}
