package com.universalharness.node

import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class RuntimeReconcilerTest {
    private fun tempState(): File {
        val dir = File(System.getProperty("java.io.tmpdir"), "uh-reconcile-${System.nanoTime()}").apply { mkdirs() }
        return File(dir, "runtime-state.json")
    }

    @Test
    fun `an app restart reconciles a recorded running session to its true outcome`() {
        val file = tempState()
        val firstBoot = RuntimeReconciler(file)
        firstBoot.markRunning(pid = 9876, startedAt = "2026-10-01T10:00:00Z")
        assertEquals("running", firstBoot.current()!!.state)

        // The app process died and restarted: the guest cannot still be alive.
        val secondBoot = RuntimeReconciler(file)
        val record = secondBoot.reconcile()
        assertTrue(record != null && record.state == "reconciled-after-restart")
        assertEquals(9876, record!!.pid)
        assertEquals("reconciled-after-restart", secondBoot.current()!!.state)
    }

    @Test
    fun `reconcile is idempotent and never resurrects a running state`() {
        val file = tempState()
        val r = RuntimeReconciler(file)
        r.markRunning(1, "t")
        r.reconcile()
        r.reconcile()
        assertEquals("reconciled-after-restart", r.current()!!.state)
    }

    @Test
    fun `a clean stop needs no reconciliation`() {
        val file = tempState()
        val r = RuntimeReconciler(file)
        r.markRunning(2, "t")
        r.markStopped()
        val secondBoot = RuntimeReconciler(file)
        assertEquals("stopped", secondBoot.reconcile()!!.state)
    }

    @Test
    fun `no state at all reconciles to nothing`() {
        assertNull(RuntimeReconciler(tempState()).reconcile())
    }

    @Test
    fun `a corrupt state file is treated as no state`() {
        val file = tempState()
        file.writeText("garbage{")
        assertNull(RuntimeReconciler(file).reconcile())
    }
}
