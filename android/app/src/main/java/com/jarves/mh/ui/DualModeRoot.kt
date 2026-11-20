package com.jarves.mh.ui

import android.content.Intent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CloudSync
import androidx.compose.material.icons.filled.PhoneAndroid
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.jarves.mh.runtime.DualModePreferences
import com.jarves.mh.runtime.LanTarget
import com.jarves.mh.runtime.OperatingMode
import com.universalharness.node.DeviceKey
import com.universalharness.node.NodeServerService
import com.universalharness.node.PairingPayload
import com.universalharness.node.UhNodeClient
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Dual-Mode root (Universal Harness v1.0.0).
 *
 * The switcher picks between:
 *   - LAN Remote Controller mode: drive a Universal Harness node on a PC/LAN machine
 *     ([LanRemotePane], backed by the real [UhNodeClient] TLS + Ed25519 pairing path).
 *   - On-Device Server mode: run the embedded Node.js/PRoot node on this phone
 *     ([OnDeviceServerPane] around [NodeServerService]) plus the full local agent UI.
 *
 * The full local agent UI stays mounted in BOTH modes: in on-device mode it
 * drives the local runtime; in LAN remote mode it remains the familiar offline
 * surface while the remote pane is the controller surface.
 */
@Composable
fun DualModeRoot(appContent: @Composable () -> Unit) {
    val context = LocalContext.current
    val prefs = remember { DualModePreferences(context) }
    var mode by remember { mutableStateOf(prefs.mode) }

    Column(modifier = Modifier.fillMaxSize()) {
        DualModeSwitcher(
            selected = mode,
            onSelect = {
                mode = it
                prefs.mode = it
            },
        )
        when (mode) {
            OperatingMode.LAN_REMOTE -> LanRemotePane(prefs)
            OperatingMode.ON_DEVICE_SERVER -> OnDeviceServerPane()
        }
        appContent()
    }
}

@Composable
private fun DualModeSwitcher(selected: OperatingMode, onSelect: (OperatingMode) -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        FilterChip(
            selected = selected == OperatingMode.LAN_REMOTE,
            onClick = { onSelect(OperatingMode.LAN_REMOTE) },
            label = { Text("LAN Remote") },
            leadingIcon = { Icon(Icons.Filled.CloudSync, contentDescription = null) },
        )
        FilterChip(
            selected = selected == OperatingMode.ON_DEVICE_SERVER,
            onClick = { onSelect(OperatingMode.ON_DEVICE_SERVER) },
            label = { Text("On-Device Server") },
            leadingIcon = { Icon(Icons.Filled.PhoneAndroid, contentDescription = null) },
        )
    }
}

// ---------------------------------------------------------------------------
// Mode 2 — Standalone On-Device Runtime
// ---------------------------------------------------------------------------

@Composable
private fun OnDeviceServerPane() {
    val context = LocalContext.current
    // The service exposes its endpoint as a StateFlow (null until bound, null
    // again after stop/failure), so this pane tracks reality instead of a
    // stale static snapshot.
    val endpoint by NodeServerService.endpointState.collectAsStateWithLifecycle()

    LaunchedEffect(Unit) {
        // Always (re)assert start: the service is idempotent while running and
        // START_STICKY across process death. Sending it unconditionally fixes
        // the case where the node was stopped from the notification and this
        // pane suppressed the restart.
        context.startForegroundService(
            Intent(context, NodeServerService::class.java)
                .setAction(NodeServerService.ACTION_START),
        )
    }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(),
        ) {
            Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("Mode 2 — Standalone On-Device Server", style = MaterialTheme.typography.titleMedium)
                Text(
                    "This phone runs the embedded Node.js/PRoot harness runtime and serves the " +
                        "Universal Protocol v1 endpoint over TLS. Other machines on the LAN can pair " +
                        "with it using `uh pair` + `uh connect` from a desktop, or another phone.",
                    style = MaterialTheme.typography.bodySmall,
                )
                if (endpoint != null) {
                    val clipboard = LocalClipboardManager.current
                    Text(
                        "Endpoint: https://<lan-ip>:${endpoint!!.port}",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    Text("nodeId: ${endpoint!!.nodeId}", style = MaterialTheme.typography.bodySmall)
                    Button(onClick = {
                        clipboard.setText(
                            AnnotatedString(
                                "{\"endpoint\":\"https://<lan-ip>:${endpoint!!.port}\"," +
                                    "\"nodeId\":\"${endpoint!!.nodeId}\",\"port\":${endpoint!!.port}}",
                            ),
                        )
                    }) { Text("Copy connection info") }
                } else {
                    Text("Node is starting… (runtime staging can take a minute on first run)", style = MaterialTheme.typography.bodySmall)
                }
                OutlinedButton(onClick = {
                    context.startService(
                        Intent(context, NodeServerService::class.java)
                            .setAction(NodeServerService.ACTION_STOP),
                    )
                }) { Text("Stop node server") }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Mode 1 — LAN Remote Controller
// ---------------------------------------------------------------------------

/** Map raw connection failures to short, actionable strings. */
fun lanFailureHint(e: Exception): String = when {
    e.message?.contains("NODE_CERTIFICATE_MISMATCH") == true ->
        "The certificate fingerprint does not match — re-check the pin printed by `uh pair` on the node machine."
    e.message?.contains("not paired yet") == true ->
        "First connection needs the pairing payload JSON from `uh pair --endpoint …` on the node machine."
    e is java.net.SocketTimeoutException ->
        "The node did not answer in time — is it on the same Wi-Fi, and is the port correct?"
    e is java.net.ConnectException ->
        "Connection refused — is the node running with `uh serve --listen tls://0.0.0.0:7437`?"
    else -> e.message ?: e::class.java.simpleName
}

@Composable
private fun LanRemotePane(prefs: DualModePreferences) {
    val scope = rememberCoroutineScope()
    val clipboard = LocalClipboardManager.current
    var target by remember { mutableStateOf(prefs.loadTarget()) }
    var host by remember { mutableStateOf(target?.host ?: "") }
    var port by remember { mutableStateOf(target?.port?.toString() ?: "7437") }
    var pin by remember { mutableStateOf(target?.pinnedCertSha256 ?: "") }
    var pairingJson by remember { mutableStateOf("") }
    var status by remember { mutableStateOf("Not connected") }
    var output by remember { mutableStateOf(listOf<String>()) }
    var client by remember { mutableStateOf<UhNodeClient?>(null) }
    var nodeId by remember { mutableStateOf<String?>(null) }
    var sessionId by remember { mutableStateOf<String?>(null) }
    // Stays set until task.start succeeds, so a retry after a timeout resends the
    // SAME id and the node never creates a duplicate task (protocol idempotency).
    var clientRequestId by remember { mutableStateOf<String?>(null) }
    var prompt by remember { mutableStateOf("") }

    fun log(line: String) { output = output + listOf(line.take(4000)) }

    // The client owns a TLS socket + reader thread: close it when this pane
    // leaves the composition (mode switch, app exit), not just on manual
    // disconnect.
    DisposableEffect(Unit) {
        onDispose { runCatching { client?.close() } }
    }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp)
            .verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Card(modifier = Modifier.fillMaxWidth()) {
            Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("Mode 1 — LAN Remote Controller", style = MaterialTheme.typography.titleMedium)
                Text(
                    "Connect to a Universal Harness server running on your PC, laptop or USB stick " +
                        "(started with `uh serve --listen tls://0.0.0.0:7437`). Paste the pairing payload " +
                        "printed by `uh pair --endpoint https://<host>:<port>` on that machine once; " +
                        "afterwards this device authenticates with its own key. No local rootfs needed.",
                    style = MaterialTheme.typography.bodySmall,
                )
            }
        }

        OutlinedTextField(
            value = host, onValueChange = { host = it.trim() },
            label = { Text("Node host (LAN IP or hostname)") }, modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = port, onValueChange = { port = it.filter(Char::isDigit).take(5) },
            label = { Text("TLS port") }, modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = pin, onValueChange = { pin = it.trim().lowercase() },
            label = { Text("Certificate fingerprint (SHA-256, 64 hex) — from `uh pair`") },
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = pairingJson, onValueChange = { pairingJson = it },
            label = { Text("Pairing payload JSON (first connection only)") },
            modifier = Modifier.fillMaxWidth(), minLines = 2,
        )

        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(
                onClick = {
                    scope.launch {
                        try {
                            status = "Connecting…"
                            val parsedPort = port.toIntOrNull()?.takeIf { it in 1..65535 } ?: 7437
                            withContext(Dispatchers.IO) {
                                val c = UhNodeClient.connect(host, parsedPort, pin)
                                client = c
                                nodeId = c.nodeId
                                var t = target ?: LanTarget(host, parsedPort, pin)
                                if (pairingJson.isNotBlank()) {
                                    // Validate the payload BEFORE consuming anything.
                                    val payload = try {
                                        PairingPayload.parse(pairingJson)
                                    } catch (e: Exception) {
                                        throw IllegalStateException(
                                            "pairing payload is not valid: ${e.message?.take(160)} — " +
                                                "copy the whole JSON printed by `uh pair`", e,
                                        )
                                    }
                                    val key = DeviceKey.generate()
                                    val reply = c.pair(
                                        key = key,
                                        pairing = payload,
                                        deviceName = "Android (Universal Harness)",
                                        platform = "android",
                                        requestedScopes = listOf("sessions", "tasks", "workspace", "terminal"),
                                    )
                                    // The payload binds the node's identity fingerprint; verifying
                                    // the node's signature over our challenge proves we are talking to
                                    // the node the token was minted for, not an imposter with a
                                    // different certificate that happens to hold a stolen pin.
                                    if (!c.verifyNodeIdentity(
                                            reply.optString("nodeSigB64"),
                                            reply.optString("nodePublicKeyPem"),
                                            payload.nodeIdentitySha256,
                                        )
                                    ) {
                                        throw IllegalStateException(
                                            "the node failed its identity verification — refusing to pair " +
                                                "(NODE_IDENTITY_MISMATCH)",
                                        )
                                    }
                                    prefs.saveSeedSealed(key.seed)
                                    t = t.copy(
                                        deviceId = reply.optString("deviceId").takeIf { it.isNotBlank() },
                                        deviceSeedB64 = null, // the seed now lives sealed in the keystore
                                    )
                                    log("paired as device ${t.deviceId}")
                                } else {
                                    val key = prefs.loadSeededKey()
                                        ?: throw IllegalStateException("not paired yet: paste the pairing payload once")
                                    val deviceId = t.deviceId ?: throw IllegalStateException("not paired yet")
                                    c.authenticate(key, deviceId)
                                    log("authenticated as device $deviceId")
                                }
                                target = t
                                prefs.saveTarget(t)
                                val sessions = c.request("session.list", emptyMap())
                                log("node $nodeId ready; session.list → ${sessions.toString().take(600)}")
                            }
                            status = "Connected to $host:$port (node $nodeId)"
                        } catch (e: Exception) {
                            status = "Failed: ${lanFailureHint(e)}"
                        }
                    }
                },
            ) { Text("Connect") }
            OutlinedButton(onClick = {
                runCatching { client?.close() }
                client = null
                status = "Disconnected"
            }) { Text("Disconnect") }
            OutlinedButton(onClick = {
                clipboard.setText(AnnotatedString(status))
            }) { Text("Copy status") }
        }
        Text(status, style = MaterialTheme.typography.bodyMedium)

        if (client != null) {
            OutlinedTextField(
                value = prompt, onValueChange = { prompt = it },
                label = { Text("Prompt for task.start") }, modifier = Modifier.fillMaxWidth(), minLines = 2,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(
                    colors = ButtonDefaults.buttonColors(),
                    onClick = {
                        scope.launch {
                            try {
                                withContext(Dispatchers.IO) {
                                    val c = client ?: throw IllegalStateException("not connected")
                                    val reqId = clientRequestId
                                        ?: java.util.UUID.randomUUID().toString().also { clientRequestId = it }
                                    val reply = c.request(
                                        "task.start",
                                        buildMap {
                                            sessionId?.let { put("sessionId", it) }
                                            put("prompt", prompt)
                                            put("clientRequestId", reqId)
                                        },
                                    )
                                    val taskId = reply.optJSONObject("payload")?.optString("taskId")
                                    clientRequestId = null // settled; the next submit is a new logical task
                                    log("task started: $taskId")
                                    // A bounded observation loop: the node streams durable
                                    // events; the controller re-reads history to follow the task.
                                    // delay() (not Thread.sleep) so the shared IO thread stays free.
                                    for (poll in 0 until 30) {
                                        // Follow cursor pagination: a task with more than one
                                        // page of events must not lose the rest of its history.
                                        var cursor: String? = null
                                        var sawAny = false
                                        while (true) {
                                            val history = c.request(
                                                "task.history",
                                                buildMap {
                                                    put("taskId", taskId)
                                                    put("limit", 50)
                                                    cursor?.let { put("cursor", it) }
                                                },
                                                timeoutMs = 20_000,
                                            )
                                            val payload = history.optJSONObject("payload")
                                            val events = payload?.optJSONArray("events")
                                            if (events != null) {
                                                for (i in 0 until events.length()) {
                                                    log(events.optJSONObject(i)?.optString("kind") ?: "")
                                                }
                                                sawAny = sawAny || events.length() > 0
                                            }
                                            val next = if (payload?.optBoolean("truncated") == true) {
                                                payload?.optString("nextCursor") ?: ""
                                            } else ""
                                            if (next.isNullOrEmpty()) break
                                            cursor = next
                                        }
                                        if (sawAny) break
                                        if (poll == 29) break
                                        delay(2000)
                                    }
                                }
                            } catch (e: Exception) {
                                log("error: ${lanFailureHint(e)}")
                            }
                        }
                    },
                ) { Text("Start task") }
                OutlinedButton(onClick = {
                    scope.launch {
                        withContext(Dispatchers.IO) {
                            runCatching {
                                val c = client ?: throw IllegalStateException("not connected")
                                sessionId = c.request("session.create", emptyMap())
                                    .optJSONObject("payload")?.optString("sessionId")
                                log("session created: $sessionId")
                            }.onFailure { log("error: ${lanFailureHint(it as? Exception ?: RuntimeException(it.message))}") }
                        }
                    }
                }) { Text("New session") }
            }
        }

        if (output.isNotEmpty()) {
            Card(modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.padding(12.dp)) {
                    output.takeLast(40).forEach { line ->
                        Text(line, style = MaterialTheme.typography.bodySmall)
                    }
                }
            }
        }
    }
}
