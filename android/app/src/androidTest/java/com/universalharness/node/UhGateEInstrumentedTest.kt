package com.universalharness.node

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.net.InetAddress
import java.net.NetworkInterface
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.AfterClass
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume
import org.junit.FixMethodOrder
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.MethodSorters

/**
 * Gate E — Phase 3B real-device verification: TLS transport, discovery, secure pairing,
 * authentication, deny-by-default authorization, durable replay, and task survival — all against
 * the real guest node server (`uh serve --listen tls://0.0.0.0:7437`) running under PRoot on this
 * device, driven by the real Kotlin controller client over a pinned TLS socket.
 *
 * Run on a real device:
 *
 *     adb shell am instrument -w -e uhInstallRuntime true \
 *       com.jarves.mh.test/com.universalharness.node.UhGateEInstrumentedTest
 *
 * `-e uhInstallRuntime true` performs the on-device runtime install first (skip when already
 * installed from Gate D). Every check prints `UH-GATE-E:` evidence lines and appends to
 * files/uh-state/gate-e-evidence.txt. Nothing here weakens TLS, pairing, authentication, or
 * authorization: the client refuses to connect without the pin, and every denial asserted below
 * is a denial the *server* produced.
 */
@RunWith(AndroidJUnit4::class)
@FixMethodOrder(MethodSorters.NAME_ASCENDING)
class UhGateEInstrumentedTest {
    private val args = InstrumentationRegistry.getArguments()

    private fun evidence(line: String) = Companion.evidence(line)

    // ------------------------------------------------------------------ e01/e02: runtime + node

    /** e01 — optional runtime install (idempotent; skip when Gate D already installed it). */
    @Test
    fun e01_installRuntimeIfRequested() {
        val requested = args.getString("uhInstallRuntime", "false").toBoolean()
        if (!requested) {
            evidence("install: skipped (pass -e uhInstallRuntime true to run)")
            return
        }
        evidence("install: requested — running staged install (rootfs/node/bootstrap/dsh/verify)")
        runBlocking {
            runtime.installer.installAll { p ->
                val line = "install ${p.stage}: ${(p.fraction * 100).toInt()}% ${p.message}"
                println("UH-GATE-E: $line")
            }
        }
        evidence("install: completed")
        assertTrue("runtime must be installed after installAll", runtime.installer.isInstalled())
    }

    /** e02 — start the node server: TLS listener binds and announces its endpoint + fingerprints. */
    @Test
    fun e02_startNodeTlsListener() {
        assumeInstalled()
        runBlocking {
            val endpoint = startNode()
            evidence(
                "node: nodeId=${endpoint.nodeId} endpoint=${endpoint.endpoint(lanAddress() ?: "127.0.0.1")} " +
                    "identitySha256=${endpoint.nodeIdentitySha256.take(16)}… " +
                    "certSha256=${endpoint.certSha256?.take(16)}… startedAt=${endpoint.startedAt}"
            )
            assertEquals("the node listener must be TLS", "tls", endpoint.scheme)
            assertTrue("the node must announce a real port, got ${endpoint.port}", endpoint.port in 1..65535)
            assertTrue("nodeId format", endpoint.nodeId.startsWith("node_"))
            assertTrue(
                "the announcement must carry a SHA-256 identity fingerprint",
                endpoint.nodeIdentitySha256.matches(Regex("^[0-9a-f]{64}$")),
            )
            assertTrue(
                "the announcement must carry a SHA-256 certificate fingerprint",
                endpoint.certSha256?.matches(Regex("^[0-9a-f]{64}$")) == true,
            )
        }
    }

    /** e03 — the node is discoverable over mDNS/NSD, advertising public metadata only. */
    @Test
    fun e03_nsdAdvertisement() {
        assumeInstalled()
        runBlocking {
            val endpoint = startNode()
            val nsd = NsdNodeAdvertisement(context)
            val name = NsdNodeAdvertisement.serviceName(endpoint.nodeId)
            val registered = nsd.register(name, endpoint.port)
            evidence("nsd: register=$registered type=${NsdNodeAdvertisement.SERVICE_TYPE} name=$name port=${endpoint.port}")
            assertTrue("NSD registration must be accepted", registered)
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(20)
            while (nsd.state != NsdNodeAdvertisement.State.REGISTERED && System.nanoTime() < deadline) {
                Thread.sleep(200)
            }
            evidence("nsd: state=${nsd.state} failure=${nsd.failure}")
            assertEquals(
                "the service must be registered as ${NsdNodeAdvertisement.SERVICE_TYPE}",
                NsdNodeAdvertisement.State.REGISTERED, nsd.state,
            )
            // The advertisement carries no token and no fingerprints: service info is public.
            nsd.unregister()
        }
    }

    /** e04 — connect over TLS with the pinned certificate fingerprint and read the greeting. */
    @Test
    fun e04_tlsConnectAndGreeting() {
        assumeInstalled()
        runBlocking {
            val endpoint = startNode()
            val host = lanAddress() ?: "127.0.0.1"
            evidence("connect: host=$host port=${endpoint.port} pinned=${endpoint.certSha256?.take(16)}…")
            UhNodeClient.connect(host, endpoint.port, endpoint.certSha256!!).use { client ->
                evidence(
                    "greeting: nodeId=${client.nodeId} nodeKind=${client.nodeKind} platform=${client.platform} " +
                        "operations=${client.operations.size} challenge=${client.challengeB64.take(12)}…"
                )
                assertEquals("the greeting must name the announced node", endpoint.nodeId, client.nodeId)
                assertTrue("the greeting must carry a challenge nonce", client.challengeB64.isNotBlank())
                assertTrue("the node advertises task.start", client.operations.contains("task.start"))
                assertTrue("the node advertises session.replay", client.operations.contains("session.replay"))
                assertEquals("the node reports its kind as android", "android", client.nodeKind)
                assertEquals("the node reports its platform as android", "android", client.platform)
            }
            evidence("connect: closed cleanly")
        }
    }

    /** e05 — pairing: a wrong token is refused, a correct token pairs and proves node identity. */
    @Test
    fun e05_pairingAndNodeIdentity() {
        assumeInstalled()
        runBlocking {
            val endpoint = startNode()
            val host = lanAddress() ?: "127.0.0.1"
            val payload = server!!.mintPairingPayload(endpoint, host)
            evidence(
                "pairing-payload: nodeId=${payload.nodeId} token=${payload.token.take(6)}… " +
                    "identitySha256=${payload.nodeIdentitySha256.take(16)}… certSha256=${payload.nodeCertSha256.take(16)}…"
            )
            assertEquals("the payload must bind this node", endpoint.nodeId, payload.nodeId)
            assertEquals(
                "the pairing payload and the announcement must pin the SAME certificate",
                endpoint.certSha256, payload.nodeCertSha256,
            )

            // The announcement and the payload agree; now refuse a tampered token.
            val forgedJson = JSONObject().apply {
                put("v", payload.v)
                put("nodeId", payload.nodeId)
                put("endpoint", payload.endpoint)
                put("token", "definitely-not-the-token")
                put("expiresAt", payload.expiresAt)
                put("nodeIdentitySha256", payload.nodeIdentitySha256)
                put("nodeCertSha256", payload.nodeCertSha256)
            }
            forgedJson.put("token", "definitely-not-the-token")
            UhNodeClient.connect(host, endpoint.port, payload.nodeCertSha256).use { attacker ->
                val forged = PairingPayload.parse(forgedJson.toString())
                val err = runCatching {
                    attacker.pair(DeviceKey.generate(), forged, "attacker", "android", listOf("task-control"))
                }.exceptionOrNull()
                evidence("pair-wrong-token: refused=${err != null} message=${err?.message?.take(120)}")
                assertTrue(
                    "a wrong token must be refused (PAIRING_EXPIRED), got: ${err?.message}",
                    err?.message?.contains("PAIRING_EXPIRED") == true,
                )
                val probe = attacker.request("task.list", emptyMap<String, Any?>())
                assertEquals(
                    "an unauthenticated connection must be refused outright",
                    "error", probe.optString("type"),
                )
                assertEquals(
                    "the refusal must be AUTH_REQUIRED",
                    "AUTH_REQUIRED", probe.optJSONObject("payload")?.optString("code"),
                )
                evidence("unauthenticated-probe: code=AUTH_REQUIRED")
            }

            // Now the real pairing, on a fresh connection with the genuine token.
            val device = DeviceKey.generate()
            UhNodeClient.connect(host, endpoint.port, payload.nodeCertSha256).use { client ->
                val reply = client.pair(
                    device, payload, "gate-e-device", "android",
                    listOf("read-only", "project-session-control", "task-control", "file-modify"))
                pairedDeviceId = reply.getString("deviceId")
                deviceKey = device
                val granted = reply.getJSONArray("grantedScopes").let { arr -> (0 until arr.length()).map { arr.optString(it) } }
                evidence("pair: deviceId=$pairedDeviceId grantedScopes=$granted")
                assertTrue("pairing must assign a deviceId", pairedDeviceId!!.isNotBlank())
                assertFalse(
                    "terminal/node-admin must never be auto-granted from pairing",
                    granted.contains("terminal") || granted.contains("node-admin"),
                )
                // The node proves it holds the identity key the token was bound to.
                val nodeSig = reply.getString("sigB64")
                val identityOk = client.verifyNodeIdentity(nodeSig, payload.nodePublicKeyPem!!, payload.nodeIdentitySha256)
                evidence("node-identity: verified=$identityOk (sig over challenge, key sha256 == payload fingerprint)")
                assertTrue("the node's identity signature must verify against the pairing payload's key", identityOk)
            }
        }
    }

    /** e06 — deny-by-default: a read-only device cannot start tasks; scopes are not upgradeable. */
    @Test
    fun e06_denyByDefault() {
        assumeInstalled()
        runBlocking {
            val endpoint = startNode()
            val host = lanAddress() ?: "127.0.0.1"
            val payload = server!!.mintPairingPayload(endpoint, host)
            val device = DeviceKey.generate()
            UhNodeClient.connect(host, endpoint.port, payload.nodeCertSha256).use { client ->
                val reply = client.pair(device, payload, "gate-e-readonly", "android", listOf("read-only"))
                val granted = reply.getJSONArray("grantedScopes").let { arr -> (0 until arr.length()).map { arr.optString(it) } }
                evidence("readonly-pair: grantedScopes=$granted")
                assertTrue("read-only must be granted when requested", granted.contains("read-only"))
                val denied = client.request(
                    "task.start",
                    mapOf("prompt" to "nope", "sessionId" to "sess_gate_e_ro_${System.currentTimeMillis()}"),
                )
                val code = denied.optJSONObject("payload")?.optString("code")
                evidence("readonly-task.start: code=$code")
                assertEquals(
                    "a read-only device must be denied task.start by the scope gate",
                    "SCOPE_DENIED", code,
                )
            }
        }
    }

    /** e07 — authentication: a paired device authenticates a new connection and makes requests. */
    @Test
    fun e07_authenticatedRequestAndReconnect() {
        assumeInstalled()
        runBlocking {
            val endpoint = startNode()
            val host = lanAddress() ?: "127.0.0.1"
            val deviceId = pairedDeviceId ?: failAssume("e05 must pair a device first")
            val key = deviceKey ?: failAssume("e05 must hold the device key")
            UhNodeClient.connect(host, endpoint.port, endpoint.certSha256!!).use { client ->
                val reply = client.authenticate(key, deviceId)
                val granted = reply.getJSONArray("grantedScopes").let { arr -> (0 until arr.length()).map { arr.optString(it) } }
                evidence("auth.connect: deviceId=${reply.getString("deviceId")} grantedScopes=$granted")
                assertEquals(reply.getString("deviceId"), deviceId)

                val tasks = client.request("task.list", emptyMap<String, Any?>())
                assertEquals(
                    "an authenticated device may call task.list, got ${tasks}",
                    "response", tasks.optString("type"),
                )
                evidence("task.list: ok=true type=${tasks.optString("type")}")

                // A wrong signature on a fresh connection is refused before any request runs.
                UhNodeClient.connect(host, endpoint.port, endpoint.certSha256!!).use { impostor ->
                    val badSig = java.util.Base64.getEncoder().encodeToString(
                        Ed25519.sign(impostor.challengeB64.toByteArray(Charsets.UTF_8), Ed25519.generateKeyPair().privateKey)
                    )
                    val refused = impostor.request(
                        "auth.connect",
                        mapOf("deviceId" to deviceId, "sigB64" to badSig),
                    )
                    assertEquals(
                        "a signature by a different key must not authenticate the device",
                        "error", refused.optString("type"),
                    )
                    evidence("auth-wrong-key: code=${refused.optJSONObject("payload")?.optString("code")}")
                }
            }
        }
    }

    /** e08 — a running task survives controller disconnect; durable events replay after reconnect. */
    @Test
    fun e08_replayAndTaskSurvival() {
        assumeInstalled()
        runBlocking {
            val endpoint = startNode()
            val host = lanAddress() ?: "127.0.0.1"
            val deviceId = pairedDeviceId ?: failAssume("e05 must pair a device first")
            val key = deviceKey ?: failAssume("e05 must hold the device key")

            var taskId: String? = null
            UhNodeClient.connect(host, endpoint.port, endpoint.certSha256!!).use { client ->
                client.authenticate(key, deviceId)
                val proj = client.requireOk(
                    client.request("project.create", mapOf("name" to "gate-e-replay")), "project.create")
                val started = client.requireOk(
                    client.request(
                        "task.start",
                        mapOf(
                            "projectId" to proj.getString("projectId"),
                            "prompt" to "gate e replay",
                            "sessionId" to "sess_" + "0123456789abcdef0123456789abcdef",
                        ),
                    ), "task.start")
                taskId = started.getString("taskId")
                evidence("task.start: taskId=$taskId")

                val queued = client.nextEvent("task.queued")
                assertNotNull("task.queued must arrive", queued)
                evidence("event: task.queued eventId=${queued!!.optString("eventId")}")
                val running = client.nextEvent("task.started")
                assertNotNull("task.started must arrive", running)
                evidence("event: task.started eventId=${running!!.optString("eventId")}")
                // The controller goes away while the node stays authoritative.
            }
            evidence("disconnect: controller closed; waiting 3s for node-side progress")
            Thread.sleep(3_000)

            UhNodeClient.connect(host, endpoint.port, endpoint.certSha256!!).use { reconnected ->
                reconnected.authenticate(key, deviceId)
                val replay = reconnected.requireOk(
                    reconnected.request("session.replay", mapOf("lastEventId" to 0, "deviceId" to deviceId)),
                    "session.replay",
                )
                val events = replay.getJSONArray("events")
                val kinds = (0 until events.length()).map { i ->
                    events.getJSONObject(i).optJSONObject("payload")?.optString("kind").orEmpty()
                }
                val eventIds = (0 until events.length()).map { i -> events.getJSONObject(i).optInt("eventId") }
                evidence("replay: events=${events.length()} kinds=${kinds.filter { it.startsWith("task.") }}")
                assertTrue("replay includes task.queued", kinds.contains("task.queued"))
                assertTrue("replay includes task.started", kinds.contains("task.started"))
                assertTrue(
                    "event ids must be monotonic across the replay",
                    eventIds.zipWithNext().all { (a, b) -> b > a },
                )

                val list = reconnected.requireOk(reconnected.request("task.list", emptyMap<String, Any?>()), "task.list")
                val tasks = list.getJSONArray("tasks")
                val tracked = (0 until tasks.length()).map { tasks.getJSONObject(it) }
                    .firstOrNull { it.optString("taskId") == taskId }
                evidence(
                    "task.list: tracked=${tracked != null} state=${tracked?.optString("state")} " +
                        "(the node kept the task without its controller)"
                )
                assertTrue("the task must still be tracked by the node after the disconnect", tracked != null)
                assertTrue(
                    "the task must have progressed past queued while no controller was connected",
                    tracked?.optString("state") != "queued",
                )
            }
        }
    }

    /**
     * e09 — mint a fresh pairing payload for the host-side (workstation) LAN verification.
     *
     * With `-e uhKeepNode true` the node is started through the production foreground service
     * ([NodeServerService]), so it stays alive after this instrumentation process finishes and
     * the workstation can connect over the real LAN.
     */
    @Test
    fun e09_mintPayloadForHostVerification() {
        val requested = args.getString("uhMintPayload", "false").toBoolean()
        if (!requested) {
            evidence("mint: skipped (pass -e uhMintPayload true when the workstation needs a payload)")
            return
        }
        assumeInstalled()
        runBlocking {
            val keep = args.getString("uhKeepNode", "false").toBoolean()
            var endpoint: NodeEndpoint
            if (keep) {
                context.startForegroundService(
                    android.content.Intent(context, NodeServerService::class.java)
                        .setAction(NodeServerService.ACTION_START),
                )
                evidence("mint: node owned by the foreground service (stays alive after instrumentation)")
                val rootfs = runtime.paths.rootfsDir
                val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(90)
                endpoint = NodeEndpoint.readFrom(rootfs) ?: run {
                    while (System.nanoTime() < deadline) {
                        Thread.sleep(300)
                        NodeEndpoint.readFrom(rootfs)?.let { return@run it }
                    }
                    throw IllegalStateException("the service's node never announced its endpoint")
                }
            } else {
                endpoint = startNode()
            }
            val host = endpoint.host.takeIf { it != "0.0.0.0" } ?: (lanAddress() ?: "127.0.0.1")
            val payload = UhNodeServer.mintPairingPayloadFor(
                runtime.paths, runtime.prootCommand, UhJsStage(context, runtime.paths), endpoint, host,
            )
            // Written to app-private storage; the workstation pulls it over `adb run-as` —
            // the same out-of-band role an operator's QR scan plays.
            val json = JSONObject().apply {
                put("v", payload.v)
                put("nodeId", payload.nodeId)
                put("endpoint", payload.endpoint)
                put("nodeName", payload.nodeName ?: JSONObject.NULL)
                put("token", payload.token)
                put("expiresAt", payload.expiresAt)
                put("nodeIdentitySha256", payload.nodeIdentitySha256)
                put("nodeCertSha256", payload.nodeCertSha256)
                put("nodePublicKeyPem", payload.nodePublicKeyPem ?: JSONObject.NULL)
            }
            val file = File(stateDir, "pairing-payload-host.json")
            file.writeText(json.toString(2) + System.lineSeparator())
            evidence("mint: payload written for the workstation (endpoint=${payload.endpoint} token expires ${payload.expiresAt})")
            assertTrue("the payload file must exist for the run-as pull", file.isFile)

            // `am instrument` force-stops the app when it returns, killing the guest node with
            // it. With -e uhHoldSeconds N the test holds the process open so the workstation can
            // run tests/manual/gate-e-host.mjs against the live node before that teardown.
            val holdSeconds = args.getString("uhHoldSeconds", "0").toLongOrNull() ?: 0
            if (holdSeconds > 0) {
                evidence("hold: keeping the node alive for ${holdSeconds}s for host-side verification")
                Thread.sleep(holdSeconds * 1000)
            }
        }
    }

    /** e10 — stop the foreground service's node (cleanup after host-side verification). */
    @Test
    fun e10_stopNodeServiceIfRequested() {
        val requested = args.getString("uhStopNode", "false").toBoolean()
        if (!requested) {
            evidence("service-stop: skipped (pass -e uhStopNode true)")
            return
        }
        context.stopService(android.content.Intent(context, NodeServerService::class.java))
        evidence("service-stop: NodeServerService stopped")
    }

    // ------------------------------------------------------------------ plumbing

    private fun assumeInstalled() {
        if (!runtime.installer.isInstalled()) {
            evidence("SKIPPED: runtime not installed yet (run with -e uhInstallRuntime true first)")
            Assume.assumeTrue(false)
        }
    }

    private fun failAssume(message: String): Nothing {
        evidence("SKIPPED: $message")
        Assume.assumeTrue(false)
        throw IllegalStateException(message)
    }

    private val context get() = Companion.context
    private val runtime by lazy { UhNode.create(context) }

    /** A dialable LAN address of this device (site-local IPv4), or null if not on Wi-Fi. */
    private fun lanAddress(): String? = runCatching {
        val out = mutableListOf<String>()
        val en = NetworkInterface.getNetworkInterfaces() ?: return null
        while (en.hasMoreElements()) {
            val ni = en.nextElement()
            if (!ni.isUp || ni.isLoopback) continue
            for (addr in ni.inetAddresses) {
                if (!addr.isLoopbackAddress && addr is InetAddress && addr.hostAddress?.contains(':') == false &&
                    addr.isSiteLocalAddress
                ) {
                    out.add(addr.hostAddress!!)
                }
            }
        }
        out.firstOrNull().also { if (out.size > 1) evidence("lan: candidates=$out using=${out.firstOrNull()}") }
    }.getOrNull()

    companion object {
        @Volatile private var server: UhNodeServer? = null
        @Volatile private var pairedDeviceId: String? = null
        @Volatile private var deviceKey: DeviceKey? = null
        private var evidenceFile: File? = null

        private val context
            get() = InstrumentationRegistry.getInstrumentation().targetContext

        private val stateDir: File
            get() = UhNode.create(context).paths.stateDir

        private fun evidence(line: String) {
            println("UH-GATE-E: $line")
            val file = evidenceFile ?: File(stateDir, "gate-e-evidence.txt").also { evidenceFile = it }
            runCatching { file.appendText(line + "\n") }
        }

        /** Start the node once for the whole class; later tests reuse the running instance. */
        private suspend fun startNode(): NodeEndpoint {
            server?.let { return it.currentEndpoint() ?: error("node started but announced no endpoint") }
            val runtime = UhNode.create(context)
            val node = UhNodeServer(
                context = context,
                paths = runtime.paths,
                prootCommand = runtime.prootCommand,
                jsStage = UhJsStage(context, runtime.paths),
            ) { line -> println("UH-GATE-E: node: $line") }
            val endpoint = node.start()
            server = node
            return endpoint
        }

        @AfterClass
        @JvmStatic
        fun stopNode() {
            // -e uhKeepNode true leaves the node running after instrumentation exits, so the
            // workstation-side script (tests/manual/gate-e-host.mjs) can verify it over the LAN.
            val keep = InstrumentationRegistry.getArguments().getString("uhKeepNode", "false").toBoolean()
            if (keep) {
                evidence("node: left running (uhKeepNode) for host-side verification")
                return
            }
            runCatching { server?.stop() }
            server = null
            evidence("node: stopped")
        }
    }
}
