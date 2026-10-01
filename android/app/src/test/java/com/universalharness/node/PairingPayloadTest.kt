package com.universalharness.node

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull

/**
 * The pairing payload is what a QR code carries: it binds a single-use token to this node's
 * identity fingerprint AND TLS certificate fingerprint. The parser must refuse payloads whose
 * fingerprints are not exact SHA-256 hex or whose token is blank — those are the two fields the
 * controller's trust decision is built on.
 */
class PairingPayloadTest {
    private val valid = """
        {
          "v": 1,
          "nodeId": "node_0f1e2d3c4b5a69788796a5b4c3d2e1f0",
          "endpoint": "https://192.168.1.23:7437",
          "nodeName": "moto-g-5g-plus",
          "token": "hKqTw5vYp2mX8sLbR1dZqA",
          "expiresAt": "2026-09-30T12:34:56.789Z",
          "nodeIdentitySha256": "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
          "nodeCertSha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          "nodePublicKeyPem": "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA\n-----END PUBLIC KEY-----\n"
        }
    """.trimIndent()

    @Test
    fun `a complete payload parses`() {
        val p = PairingPayload.parse(valid)
        assertEquals(1, p.v)
        assertEquals("node_0f1e2d3c4b5a69788796a5b4c3d2e1f0", p.nodeId)
        assertEquals("https://192.168.1.23:7437", p.endpoint)
        assertEquals("moto-g-5g-plus", p.nodeName)
        assertEquals("hKqTw5vYp2mX8sLbR1dZqA", p.token)
        assertEquals("a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90", p.nodeIdentitySha256)
        assertEquals("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", p.nodeCertSha256)
    }

    @Test
    fun `optional fields default to null when absent or blank`() {
        fun variant(mutate: (org.json.JSONObject) -> Unit = {}): String {
            val o = org.json.JSONObject()
            o.put("v", 1)
            o.put("nodeId", "node_0f1e2d3c4b5a69788796a5b4c3d2e1f0")
            o.put("endpoint", "https://192.168.1.23:7437")
            o.put("token", "hKqTw5vYp2mX8sLbR1dZqA")
            o.put("expiresAt", "2026-09-30T12:34:56.789Z")
            o.put("nodeIdentitySha256", "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90")
            o.put("nodeCertSha256", "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")
            mutate(o)
            return o.toString()
        }
        val absent = PairingPayload.parse(variant())
        assertNull(absent.nodeName)
        assertNull(absent.nodePublicKeyPem)
        val blankName = PairingPayload.parse(variant { it.put("nodeName", "   ") })
        assertNull(blankName.nodeName)
    }

    @Test
    fun `a non-hex identity fingerprint is refused`() {
        val bad = valid.replace("a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90", "not-hex-at-all")
        assertFailsWith<IllegalArgumentException> { PairingPayload.parse(bad) }
    }

    @Test
    fun `a short certificate fingerprint is refused`() {
        val bad = valid.replace("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", "0123456789abcdef")
        assertFailsWith<IllegalArgumentException> { PairingPayload.parse(bad) }
    }

    @Test
    fun `an uppercase fingerprint is refused - fingerprints are lowercase hex`() {
        val bad = valid.replace("nodeCertSha256\": \"0123", "nodeCertSha256\": \"012A")
        assertFailsWith<IllegalArgumentException> { PairingPayload.parse(bad) }
    }

    @Test
    fun `a blank pairing token is refused`() {
        val bad = valid.replace("hKqTw5vYp2mX8sLbR1dZqA", "")
        assertFailsWith<IllegalArgumentException> { PairingPayload.parse(bad) }
    }

    @Test
    fun `malformed json is refused`() {
        assertFailsWith<Exception> { PairingPayload.parse("{ not json") }
    }
}
