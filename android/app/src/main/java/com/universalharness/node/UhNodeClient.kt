package com.universalharness.node

import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStream
import java.net.InetSocketAddress
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocket
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager
import org.json.JSONObject

/**
 * Phase 3B: the controller-side protocol client used by the on-device verification suite.
 *
 * It is a deliberate, minimal reimplementation of the controller half of the wire contract from
 * the *schema*, not a port of the JS fixtures: connect with the pinned certificate fingerprint
 * (ALPN `uh-ndjson`), read the node's greeting, complete the challenge-response, and speak
 * newline-delimited JSON envelopes. Every security rule the JS suite asserts is asserted here on
 * the real socket too — the pin is mandatory, TLS is mandatory, and no plaintext path is used.
 *
 * Used by [UhGateEInstrumentedTest] against the real node server running on this device.
 */
class UhNodeClient private constructor(
    private val socket: SSLSocket,
    private val input: BufferedReader,
    private val output: OutputStream,
) : AutoCloseable {

    private val envelopes = LinkedBlockingQueue<JSONObject>()
    private val pending = ConcurrentHashMap<String, LinkedBlockingQueue<JSONObject>>()
    @Volatile private var closed = false

    val nodeId: String
    val challengeB64: String
    val operations: List<String>
    val nodeKind: String?
    val platform: String?

    init {
        // The pin was verified on the established session before this constructor ran, so the
        // greeting is the first envelope trusted *after* the trust decision. The reader must be
        // running before the greeting is awaited — it is what fills the queue.
        val reader = Thread({ readLoop() }, "uh-node-client-reader").apply { isDaemon = true }
        reader.start()

        val greeting = next { it.optJSONObject("payload")?.optString("kind") == "node.hello" }
            ?: throw IllegalStateException("the node never greeted; refusing to continue")
        val payload = greeting.getJSONObject("payload")
        nodeId = payload.getString("nodeId")
        challengeB64 = payload.getString("challengeB64")
        operations = payload.getJSONArray("operations").let { arr ->
            (0 until arr.length()).map { arr.optString(it) }
        }
        nodeKind = payload.optString("nodeKind").takeIf { it.isNotBlank() }
        platform = payload.optString("platform").takeIf { it.isNotBlank() }
    }

    private fun readLoop() {
        try {
            while (!closed) {
                val line = input.readLine() ?: break
                if (line.isBlank()) continue
                val env = JSONObject(line)
                envelopes.offer(env)
                val requestId = env.optString("requestId").takeIf { it.isNotBlank() }
                if (requestId != null) pending.get(requestId)?.offer(env)
            }
        } catch (_: Throwable) {
            // A torn-down socket ends the read loop; [request] reports the failure.
        } finally {
            closed = true
        }
    }

    /** Send a request envelope and await its reply (response or error). */
    fun request(kind: String, payload: Map<String, Any?>, timeoutMs: Long = 10_000): JSONObject {
        val requestId = "req_" + UUID.randomUUID().toString().replace("-", "").take(20)
        val queue = LinkedBlockingQueue<JSONObject>()
        pending[requestId] = queue
        send(buildEnvelope("request", kind, payload, requestId))
        try {
            val reply = queue.poll(timeoutMs, TimeUnit.MILLISECONDS)
                ?: throw IllegalStateException("no reply to $kind within ${timeoutMs}ms")
            return reply
        } finally {
            pending.remove(requestId)
        }
    }

    /** Send an envelope without awaiting a reply (e.g. to inject a hostile frame). */
    fun sendRaw(envelope: JSONObject) = send(envelope)

    /**
     * Authenticate this connection as a previously paired device: sign the node.hello challenge
     * with the device seed exactly as the wire contract defines it — Ed25519 over the UTF-8 bytes
     * of the base64 challenge string — and send `auth.connect`. Returns the reply payload.
     */
    fun authenticate(key: DeviceKey, deviceId: String): JSONObject {
        val reply = request(
            "auth.connect",
            mapOf("deviceId" to deviceId, "sigB64" to signatureOverChallenge(key.seed)),
        )
        return requireOk(reply, "auth.connect")
    }

    /**
     * Complete `device.pair` on this connection: consume the pairing token, register [key]'s
     * public key, and bind the node identity fingerprint from the payload before the node trusts
     * us (the server verifies it against its own identity). Returns the reply payload, which
     * carries the assigned deviceId, the granted scopes, and the node's identity signature over
     * this connection's challenge (verify it with [verifyNodeIdentity]).
     */
    fun pair(
        key: DeviceKey,
        pairing: PairingPayload,
        deviceName: String,
        platform: String,
        requestedScopes: List<String>,
        clientChallengeB64: String? = null,
    ): JSONObject {
        val reply = request(
            "device.pair",
            mapOf(
                "deviceName" to deviceName,
                "platform" to platform,
                "devicePublicKeyPem" to key.publicKeyPem,
                "expectedNodeIdentitySha256" to pairing.nodeIdentitySha256,
                "sigB64" to signatureOverChallenge(key.seed),
                "requestedScopes" to requestedScopes,
                "pairingToken" to pairing.token,
                "clientChallengeB64" to clientChallengeB64,
            ),
        )
        return requireOk(reply, "device.pair")
    }

    /**
     * The signature the device sends for auth.connect/device.pair over the current connection's
     * challenge. Public so tests can assert tampered signatures are refused.
     */
    fun signatureOverChallenge(seed: ByteArray): String =
        java.util.Base64.getEncoder().encodeToString(Ed25519.sign(challengeB64.toByteArray(Charsets.UTF_8), seed))

    /**
     * Verify the node's proof of identity from a device.pair reply: the SHA-256 of the node
     * public key's SPKI DER must equal the fingerprint the pairing payload was bound to, and the
     * signature must verify over this connection's challenge with exactly that key. This is what
     * stops a substitute node from accepting a token minted for the real one.
     */
    fun verifyNodeIdentity(nodeSigB64: String, nodePublicKeyPem: String, expectedNodeIdentitySha256: String): Boolean {
        val der = spkiDer(nodePublicKeyPem) ?: return false
        if (sha256Hex(der) != expectedNodeIdentitySha256.lowercase()) return false
        val raw = der.copyOfRange(der.size - 32, der.size)
        return runCatching {
            Ed25519.verify(
                challengeB64.toByteArray(Charsets.UTF_8),
                java.util.Base64.getDecoder().decode(nodeSigB64),
                raw,
            )
        }.getOrDefault(false)
    }

    /** The reply payload, or throws carrying the node's error code — never silently swallowed. */
    fun requireOk(reply: JSONObject, forKind: String): JSONObject {
        if (reply.optString("type") == "error") {
            val p = reply.optJSONObject("payload") ?: JSONObject()
            throw NodeRequestException("node refused $forKind: ${p.optString("code")}: ${p.optString("message")}")
        }
        return reply.getJSONObject("payload")
    }

    class NodeRequestException(message: String) : IllegalStateException(message)

    /** Next envelope matching [predicate], or null on timeout. */
    fun next(timeoutMs: Long = 10_000, predicate: (JSONObject) -> Boolean): JSONObject? {
        val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs)
        while (System.nanoTime() < deadline) {
            val remaining = deadline - System.nanoTime()
            val env = envelopes.poll(remaining, TimeUnit.NANOSECONDS) ?: return null
            if (predicate(env)) return env
        }
        return null
    }

    /** Next event of [kind] (durable events carry a payload.kind). */
    fun nextEvent(kind: String, timeoutMs: Long = 10_000): JSONObject? =
        next(timeoutMs) { it.optString("type") == "event" && it.optJSONObject("payload")?.optString("kind") == kind }

    private fun send(envelope: JSONObject) {
        synchronized(output) {
            output.write(envelope.toString().toByteArray(Charsets.UTF_8))
            output.write('\n'.code)
            output.flush()
        }
    }

    private fun buildEnvelope(type: String, kind: String, payload: Map<String, Any?>, requestId: String? = null): JSONObject {
        val env = JSONObject()
        env.put("protocolVersion", 1)
        env.put("type", type)
        env.put("timestamp", java.time.Instant.now().toString())
        val p = JSONObject()
        p.put("kind", kind)
        for ((k, v) in payload) {
            val jv = jsonValue(v)
            if (jv != null) p.put(k, jv)
        }
        env.put("payload", p)
        if (requestId != null) env.put("requestId", requestId)
        return env
    }

    /**
     * Android's org.json does NOT wrap Kotlin/Java collections when stringifying — a List would
     * reach the node as its `toString()` string. Convert lists and maps to JSON types explicitly.
     */
    private fun jsonValue(v: Any?): Any? = when (v) {
        null -> null
        is JSONObject, is org.json.JSONArray, is String, is Boolean, is Int, is Long, is Double -> v
        is List<*> -> org.json.JSONArray().apply { for (item in v) put(jsonValue(item)) }
        is Map<*, *> -> JSONObject().apply { for ((k, item) in v) put(k.toString(), jsonValue(item)) }
        else -> throw IllegalArgumentException("cannot serialize ${v.javaClass} into a protocol envelope")
    }

    /** True once the underlying socket has torn down. */
    val isClosed: Boolean get() = closed

    override fun close() {
        closed = true
        runCatching { socket.close() }
    }

    companion object {
        private const val ALPN_NDJSON = "uh-ndjson"

        /**
         * Connect to the node, pinning the certificate fingerprint. TLS is mandatory and the pin
         * is mandatory: no variant of this method connects without one.
         */
        fun connect(host: String, port: Int, pinnedCertSha256: String, timeoutMs: Int = 15_000): UhNodeClient {
            require(pinnedCertSha256.matches(Regex("^[0-9a-f]{64}$"))) {
                "a 256-bit pinned certificate fingerprint is required to connect"
            }
            // The peer is self-signed: the CA chain cannot validate it, so the chain is accepted
            // only so the *pin* can be checked on the established socket. Without the pin check
            // this would be unsafe; the check below is the actual trust decision.
            val context = SSLContext.getInstance("TLSv1.2").apply {
                init(null, arrayOf<TrustManager>(AcceptAllTrustManager), java.security.SecureRandom())
            }
            val raw = java.net.Socket().apply {
                connect(InetSocketAddress(host, port), timeoutMs)
            }
            val socket = context.socketFactory.createSocket(raw, host, port, true) as SSLSocket
            // Offer ALPN so the node picks the full-duplex NDJSON framing deterministically
            // (SSLParameters.applicationProtocols is API 29+). Without an offered protocol the
            // server still serves the NDJSON stream path, so older devices stay correct.
            if (android.os.Build.VERSION.SDK_INT >= 29) {
                val params = socket.sslParameters
                params.applicationProtocols = arrayOf(ALPN_NDJSON)
                socket.sslParameters = params
            }
            socket.startHandshake()

            val certs = socket.session.peerCertificates
            check(certs.isNotEmpty()) { "the node presented no certificate" }
            val der = certs.first().encoded
            val actual = sha256Hex(der)
            check(actual == pinnedCertSha256.lowercase()) {
                "NODE_CERTIFICATE_MISMATCH: the node certificate does not match the pinned fingerprint"
            }
            return UhNodeClient(
                socket,
                BufferedReader(InputStreamReader(socket.getInputStream(), Charsets.UTF_8)),
                socket.getOutputStream(),
            )
        }

        fun sha256Hex(bytes: ByteArray): String =
            MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

        /** Decode a PEM-encoded SPKI public key to its DER bytes, or null if malformed. */
        private fun spkiDer(pem: String): ByteArray? = runCatching {
            java.util.Base64.getMimeDecoder().decode(
                pem.lines().filterNot { it.startsWith("-----") }.joinToString("")
            )
        }.getOrNull()

        private object AcceptAllTrustManager : X509TrustManager {
            override fun checkClientTrusted(chain: Array<out java.security.cert.X509Certificate>?, authType: String?) {}
            override fun checkServerTrusted(chain: Array<out java.security.cert.X509Certificate>?, authType: String?) {}
            override fun getAcceptedIssuers(): Array<java.security.cert.X509Certificate> = emptyArray()
        }
    }
}
