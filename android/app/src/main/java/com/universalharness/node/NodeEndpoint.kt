package com.universalharness.node

import java.io.File
import org.json.JSONObject

/**
 * Phase 3B: the node's announced endpoint, read from the guest's
 * `node-endpoint.json` (written atomically by `uh serve --listen` once the TLS
 * listener is bound). The port may be ephemeral, so the supervisor must read it
 * rather than assume one.
 */
data class NodeEndpoint(
    val scheme: String,
    val host: String,
    val port: Int,
    val nodeId: String,
    val nodeIdentitySha256: String,
    val certSha256: String?,
    val startedAt: String?,
) {
    /** The endpoint a controller connects to. `0.0.0.0` is not dialable; the caller substitutes. */
    fun endpoint(lanAddress: String): String =
        "${if (scheme == "tls") "https" else "loopback"}://${lanAddress}:$port"

    companion object {
        fun parse(json: String): NodeEndpoint {
            val o = JSONObject(json)
            return NodeEndpoint(
                scheme = o.getString("scheme"),
                host = o.getString("host"),
                port = o.getInt("port"),
                nodeId = o.getString("nodeId"),
                nodeIdentitySha256 = o.getString("nodeIdentitySha256"),
                certSha256 = o.optString("certSha256").takeIf { it.isNotBlank() },
                startedAt = o.optString("startedAt").takeIf { it.isNotBlank() },
            )
        }

        /** Read the announcement the guest wrote, or null if the node has not bound yet. */
        fun readFrom(rootfsDir: File): NodeEndpoint? {
            val file = File(rootfsDir, "root/.universal-harness/identity/node-endpoint.json")
            if (!file.isFile) return null
            return runCatching { parse(file.readText()) }.getOrNull()
        }
    }
}
