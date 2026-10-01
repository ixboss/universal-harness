package com.universalharness.node

import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class InstallStateStoreTest {
    private fun tempStore(): Pair<InstallStateStore, File> {
        val dir = createTempDirectory()
        val file = File(dir, "install-state.json")
        return InstallStateStore(file) to file
    }

    private fun createTempDirectory(): File =
        File(System.getProperty("java.io.tmpdir"), "uh-state-test-${System.nanoTime()}").apply { mkdirs() }

    @Test
    fun `a missing state file reports nothing done`() {
        val (store, file) = tempStore()
        assertFalse(store.isStageDone("rootfs", "abc"))
        assertTrue(store.allStages().isEmpty())
        assertFalse(file.exists())
    }

    @Test
    fun `a marked stage is done only for the matching pin`() {
        val (store, file) = tempStore()
        store.markDone("rootfs", "a".repeat(64), "2026-10-01T00:00:00Z")
        assertTrue(store.isStageDone("rootfs", "a".repeat(64)))
        assertTrue(file.isFile, "state must be persisted")
        assertFalse(store.isStageDone("rootfs", "b".repeat(64)), "a different pin must invalidate the stage")
        assertFalse(store.isStageDone("node", "a".repeat(64)), "other stages stay undone")
    }

    @Test
    fun `a null pin stage matches any rerun`() {
        val (store, _) = tempStore()
        store.markDone("bootstrap", null, "2026-10-01T00:00:00Z")
        assertTrue(store.isStageDone("bootstrap", null))
        assertTrue(store.isStageDone("bootstrap", "whatever"))
    }

    @Test
    fun `state survives a store restart`() {
        val (store, file) = tempStore()
        store.markDone("rootfs", "a".repeat(64), "2026-10-01T00:00:00Z")
        val reloaded = InstallStateStore(file)
        assertTrue(reloaded.isStageDone("rootfs", "a".repeat(64)))
    }

    @Test
    fun `a corrupt state file reads as empty, never as installed`() {
        val dir = createTempDirectory()
        val file = File(dir, "install-state.json")
        file.writeText("{ this is not json")
        val store = InstallStateStore(file)
        assertFalse(store.isStageDone("rootfs", null))
        assertEquals(0, store.allStages().size)
    }

    @Test
    fun `no temporary file remains after a persist`() {
        val (store, file) = tempStore()
        store.markDone("rootfs", "a".repeat(64), "2026-10-01T00:00:00Z")
        assertEquals(listOf("install-state.json"), file.parentFile!!.list()!!.sorted())
    }
}
