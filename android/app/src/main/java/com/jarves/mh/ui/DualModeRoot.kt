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
import androidx.lifecycle.viewmodel.compose.viewModel
import com.jarves.mh.runtime.DualModePreferences
import com.jarves.mh.runtime.LanTarget
import com.jarves.mh.runtime.OperatingMode
import com.universalharness.node.DeviceKey
import com.universalharness.node.NodeServerService
import com.universalharness.node.PairingPayload
import com.universalharness.node.UhNodeClient
import kotlinx.coroutines.Dispatchers
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
        // The full local agent UI always stays available underneath the switcher:
        // in on-device mode it drives the local runtime; in LAN mode it remains the
        // familiar offline surface (its runtime bridges simply cannot reach a remote
        // node, so the remote pane is the controller surface).
        if (mode == OperatingMode.ON_DEVICE_SERVER) {
            appContent()
        }
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
    val endpoint = NodeServerService.endpoint
    var running by remember { mutableStateOf(endpoint != null) }
    // Keep the foreground node alive while this mode is on screen; it is also
    // START_STICKY, so Android restarts it if the process is reclaimed.
    LaunchedEffect(Unit) {
        if (!running) {
            context.startForegroundService(
                Intent(context, NodeServerService::class.java)
                    .setAction(NodeServerService.ACTION_START),
            )
            running = true
        }
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
                        "with it using \`uh pair\` + \`uh connect\` from a desktop, or another phone.",
                    style = MaterialTheme.typography.bodySmall,
                )
                if (endpoint != null) {
                    val clipboard = LocalClipboardManager.current
                    Text(
                        "Endpoint: https://<lan-ip>:${endpoint.port}",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    Text("nodeId: ${endpoint.nodeId}", style = MaterialTheme.typography.bodySmall)
                    Button(onClick = {
                        clipboard.setText(
                            AnnotatedString(
                                "{\"endpoint\":\"https://<lan-ip>:${endpoint.port}\"," +
                                    "\"nodeId\":\"${endpoint.nodeId}\",\"port\":${endpoint.port}}",
                            ),
                        )
                    }) { Text("Copy connection info") }
                } else {
                    Text("Node is starting…", style = MaterialTheme.typography.bodySmall)
                }
                OutlinedButton(onClick = {
                    context.startService(
                        Intent(context, NodeServerService::class.java)
                            .setAction(NodeServerService.ACTION_STOP),
                    )
                    running = false
                }) { Text("Stop node server") }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Mode 1 — LAN Remote Controller
// ---------------------------------------------------------------------------

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
    var prompt by remember { mutableStateOf("") }

    fun log(line: String) { output = output + listOf(line.take(4000)) }

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
                        "(started with \`uh serve --listen tls://0.0.0.0:7437\`). Paste the pairing payload " +
                        "printed by \`uh pair --endpoint https://<host>:<port>\` on that machine once; " +
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
            label = { Text("Certificate fingerprint (SHA-256, 64 hex) — from \`uh pair\`") },
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
                                    val payload = PairingPayload.parse(pairingJson)
                                    val key = DeviceKey.generate()
                                    val reply = c.pair(
                                        key = key,
                                        pairing = payload,
                                        deviceName = "Android (Universal Harness)",
                                        platform = "android",
                                        requestedScopes = listOf("sessions", "tasks", "workspace", "terminal"),
                                    )
                                    t = t.copy(
                                        deviceId = reply.optString("deviceId").takeIf { it.isNotBlank() },
                                        deviceSeedB64 = DualModePreferences.encodeSeed(key.seed),
                                    )
                                    log("paired as device ${t.deviceId}")
                                } else {
                                    val seed = DualModePreferences.decodeSeed(t.deviceSeedB64.orEmpty())
                                    val key = seed?.let(DeviceKey::fromSeed)
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
                            status = "Failed: ${e.message ?: e::class.java.simpleName}"
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
                                    val reply = client!!.request(
                                        "task.start",
                                        buildMap {
                                            sessionId?.let { put("sessionId", it) }
                                            put("prompt", prompt)
                                        },
                                    )
                                    val taskId = reply.optJSONObject("payload")?.optString("taskId")
                                    log("task started: $taskId")
                                    // A bounded observation loop: the node streams durable
                                    // events; the controller re-reads history to follow the task.
                                    repeat(30) {
                                        val history = client!!.request(
                                            "task.history",
                                            mapOf("taskId" to taskId, "limit" to 50),
                                            timeoutMs = 20_000,
                                        )
                                        val events = history.optJSONObject("payload")?.optJSONArray("events")
                                        if (events != null && events.length() > 0) {
                                            for (i in 0 until events.length()) {
                                                log(events.optJSONObject(i)?.optString("kind") ?: "")
                                            }
                                            break
                                        }
                                        Thread.sleep(2000)
                                    }
                                }
                            } catch (e: Exception) {
                                log("error: ${e.message}")
                            }
                        }
                    },
                ) { Text("Start task") }
                OutlinedButton(onClick = {
                    scope.launch {
                        withContext(Dispatchers.IO) {
                            runCatching {
                                sessionId = client!!.request("session.create", emptyMap())
                                    .optJSONObject("payload")?.optString("sessionId")
                                log("session created: $sessionId")
                            }.onFailure { log("error: ${it.message}") }
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
