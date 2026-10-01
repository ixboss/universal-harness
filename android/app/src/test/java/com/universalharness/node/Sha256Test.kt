package com.universalharness.node

import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals

class Sha256Test {
    @Test
    fun `known vectors hash correctly`() {
        assertEquals(
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            Sha256.ofBytes(ByteArray(0)),
        )
        assertEquals(
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            Sha256.ofBytes("abc".toByteArray()),
        )
    }

    @Test
    fun `streaming file digest matches the byte digest`() {
        val file = File.createTempFile("uh-sha", ".bin")
        try {
            file.writeBytes(ByteArray(200_000) { (it % 251).toByte() })
            assertEquals(Sha256.ofBytes(file.readBytes()), Sha256.ofFile(file))
        } finally {
            file.delete()
        }
    }
}
