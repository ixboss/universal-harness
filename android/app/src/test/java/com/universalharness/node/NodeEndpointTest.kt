package com.universalharness.node

import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The node's endpoint announcement is the supervisor's only source of the bound port (it may be
 * ephemeral). Parsing must tolerate the optional fields and never throw on a half-written file —
 * `readFrom` runs on a poll loop while the guest is starting.
 */
class NodeEndpointTest {
    private fun tempRoot(): File =
        File(System.getProperty("java.io.tmpdir"), "uh-endpoint-test-${System.nanoTime()}").apply { mkdirs() }

    private val sample = """
        {
          "v": 1,
          "scheme": "tls",
          "host": "0.0.0.0",
          "port": 7437,
          "endpoint": "https://0.0.0.0:7437",
          "nodeId": "node_0f1e2d3c4b5a69788796a5b4c3d2e1f0",
          "nodeIdentitySha256": "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
          "certSha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          "startedAt": "2026-09-30T10:00:00.000Z"
        }
    """.trimIndent()

    @Test
    fun `a complete announcement parses`() {
        val e = NodeEndpoint.parse(sample)
        assertEquals("tls", e.scheme)
        assertEquals("0.0.0.0", e.host)
        assertEquals(7437, e.port)
        assertEquals("node_0f1e2d3c4b5a69788796a5b4c3d2e1f0", e.nodeId)
        assertEquals("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", e.certSha256)
        assertEquals("2026-09-30T10:00:00.000Z", e.startedAt)
    }

    @Test
    fun `the dialable endpoint substitutes the LAN address for 0_0_0_0`() {
        val e = NodeEndpoint.parse(sample)
        assertEquals("https://192.168.1.23:7437", e.endpoint("192.168.1.23"))
    }

    @Test
    fun `a loopback announcement maps to the loopback scheme`() {
        val e = NodeEndpoint.parse(sample.replace("\"scheme\": \"tls\"", "\"scheme\": \"loopback\""))
        assertEquals("loopback://127.0.0.1:7437", e.endpoint("127.0.0.1"))
    }

    @Test
    fun `readFrom returns null before the node has bound`() {
        val root = tempRoot()
        assertNull(NodeEndpoint.readFrom(root), "no announcement file yet")
    }

    @Test
    fun `readFrom parses the announcement from the guest identity directory`() {
        val root = tempRoot()
        val file = File(root, "root/.universal-harness/identity/node-endpoint.json")
        file.parentFile!!.mkdirs()
        file.writeText(sample)
        val e = NodeEndpoint.readFrom(root)
        assertTrue(e != null, "the announcement must be read from the guest's HOME identity dir")
        assertEquals(7437, e.port)
    }

    @Test
    fun `a corrupt announcement reads as null, never throws`() {
        val root = tempRoot()
        val file = File(root, "root/.universal-harness/identity/node-endpoint.json")
        file.parentFile!!.mkdirs()
        file.writeText("{ half written")
        assertNull(NodeEndpoint.readFrom(root))
    }

    @Test
    fun `optional fields default to null`() {
        val minimal = """
            {
              "v": 1,
              "scheme": "tls",
              "host": "0.0.0.0",
              "port": 0,
              "endpoint": "https://0.0.0.0:0",
              "nodeId": "node_0f1e2d3c4b5a69788796a5b4c3d2e1f0",
              "nodeIdentitySha256": "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
              "certSha256": null,
              "startedAt": null
            }
        """.trimIndent()
        val e = NodeEndpoint.parse(minimal)
        assertNull(e.certSha256)
        assertNull(e.startedAt)
        assertEquals(0, e.port)
    }
}
