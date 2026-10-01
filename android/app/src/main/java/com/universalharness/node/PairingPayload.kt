package com.universalharness.node

import org.json.JSONObject

/**
 * Phase 3B: the single-use pairing payload minted by `uh pair --endpoint ...`, as parsed from the
 * CLI's JSON output. This is the object a pairing UI encodes as a QR code: it binds a short-lived
 * token to this node's persistent identity fingerprint AND its TLS certificate fingerprint, so a
 * controller verifies both out of band before it trusts the node. The token alone authorises
 * nothing (ADR-007: discovery is never authorization).
 *
 * The private node identity key and the TLS private key never appear here or anywhere else on the
 * wire; only their SHA-256 fingerprints travel.
 */
data class PairingPayload(
    val v: Int,
    val nodeId: String,
    val endpoint: String,
    val nodeName: String?,
    /** Short-lived, single-use. Authorises exactly one device.pair request. */
    val token: String,
    val expiresAt: String,
    /** SHA-256 of the node identity public key; the client pins this to prevent node substitution. */
    val nodeIdentitySha256: String,
    /** SHA-256 of the node TLS certificate (DER); the client pins this for the TLS channel. */
    val nodeCertSha256: String,
    val nodePublicKeyPem: String?,
) {
    init {
        require(nodeIdentitySha256.matches(HEX64)) { "nodeIdentitySha256 must be 64 hex chars" }
        require(nodeCertSha256.matches(HEX64)) { "nodeCertSha256 must be 64 hex chars" }
        require(token.isNotBlank()) { "pairing token is empty" }
    }

    companion object {
        private val HEX64 = Regex("^[0-9a-f]{64}$")

        fun parse(json: String): PairingPayload {
            val o = JSONObject(json)
            return PairingPayload(
                v = o.getInt("v"),
                nodeId = o.getString("nodeId"),
                endpoint = o.getString("endpoint"),
                nodeName = o.optString("nodeName").takeIf { it.isNotBlank() },
                token = o.getString("token"),
                expiresAt = o.getString("expiresAt"),
                nodeIdentitySha256 = o.getString("nodeIdentitySha256"),
                nodeCertSha256 = o.getString("nodeCertSha256"),
                nodePublicKeyPem = o.optString("nodePublicKeyPem").takeIf { it.isNotBlank() },
            )
        }
    }
}
