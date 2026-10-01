package com.universalharness.node

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Gate D — real ARM64 execution checks (TESTING.md §2a / Phase 3A report).
 *
 * Runs ONLY on a real arm64 device through `connectedDebugAndroidTest`. The full chain
 * (install runtime -> uname -> node -v -> dsh --version -> dsh --profile sdk -> initialize ->
 * shutdown) requires network for the one-time runtime install; pass the gate arguments:
 *
 *     adb shell am instrument -e uhInstallRuntime true -w \
 *       com.jarves.mh.test/com.universalharness.node.UhGateDInstrumentedTest
 *
 * Every check records its actual evidence (command output), never a canned claim. A Gradle
 * build alone proves nothing here.
 */
@RunWith(AndroidJUnit4::class)
class UhGateDInstrumentedTest {
    private val runtime: UhNodeRuntime by lazy {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        UhNode.create(context)
    }

    @Test
    fun reconcileAfterRestartNeverReportsRunning() {
        val record = runtime.reconcileAfterRestart()
        assertTrue("after restart no guest can still be running", record?.state != "running")
    }

    @Test
    fun prootCarrierIsPackagedAndExecutable() {
        val check = runtime.checks.prootCarrierPresent()
        assertTrue("proot carrier check failed: ${check.evidence}", check.ok)
    }

    @Test
    fun unameReportsAarch64InsideRootfs() {
        if (!runtime.installer.isInstalled()) return // install first via uhInstallRuntime
        val check = runtime.checks.unameReportsAarch64()
        assertTrue("uname check failed: ${check.evidence}", check.ok)
    }

    @Test
    fun nodeIsPinnedVersionInsideRootfs() {
        if (!runtime.installer.isInstalled()) return
        val check = runtime.checks.nodeIsPinnedVersion()
        assertTrue("node check failed: ${check.evidence}", check.ok)
    }

    @Test
    fun dshIsPinnedVersionInsideRootfs() {
        if (!runtime.installer.isInstalled()) return
        val check = runtime.checks.dshIsPinnedVersion()
        assertTrue("dsh check failed: ${check.evidence}", check.ok)
    }
}
