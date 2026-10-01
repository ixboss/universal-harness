package com.universalharness.node

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class UhPinsTest {
    @Test
    fun `every pin is a well-formed sha256 digest`() {
        for ((name, hash) in mapOf(
            "ubuntu-base" to UhPins.UBUNTU_BASE_SHA256,
            "node" to UhPins.NODE_SHA256,
        )) {
            assertTrue(Regex("^[0-9a-f]{64}$").matches(hash), "$name pin must be a 64-hex sha256")
        }
    }

    @Test
    fun `dsh integrity is a well-formed sha512 npm pin`() {
        assertTrue(UhPins.DSH_TARBALL_SHA512.startsWith("sha512-"))
        val digest = UhPins.DSH_TARBALL_SHA512.removePrefix("sha512-")
        assertTrue(Regex("^[A-Za-z0-9+/]{86}==$").matches(digest))
    }

    @Test
    fun `pinned versions match the repository manifest`() {
        assertEquals("v24.21.0", UhPins.NODE_VERSION)
        assertEquals("0.2.0-rc.2", UhPins.DSH_VERSION)
        assertEquals("https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-arm64.tar.gz", UhPins.NODE_URL)
    }
}
