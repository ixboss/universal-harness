package com.jarves.mh.runtime

import android.content.Context
import android.content.SharedPreferences
import android.util.Base64

/**
 * Dual-Mode operation (Universal Harness v1.0.0).
 *
 *  LAN_REMOTE        the phone is a *controller*: it connects over Wi-Fi/LAN to a
 *                    Universal Harness node running on a PC/laptop/USB stick and
 *                    drives sessions, adapters and task streams remotely. No local
 *                    rootfs or runtime is required in this mode.
 *
 *  ON_DEVICE_SERVER  the phone *is* the node: the embedded Node.js/PRoot runtime
 *                    runs locally ([com.universalharness.node.NodeServerService]),
 *                    the device acts as a self-contained portable server, and other
 *                    LAN machines can pair with it and control it.
 *
 * The selected mode and the LAN target are persisted device-locally.
 */
enum class OperatingMode(val label: String, val description: String) {
    LAN_REMOTE(
        "LAN Remote Controller",
        "Connect to a Universal Harness server on your PC, laptop or USB stick over Wi-Fi/LAN and control it remotely.",
    ),
    ON_DEVICE_SERVER(
        "On-Device Server",
        "Run the embedded Node.js harness runtime on this phone so it becomes a self-contained portable server on the LAN.",
    );

    companion object {
        val DEFAULT = ON_DEVICE_SERVER
    }
}

/** A LAN node the app knows how to reach (host, TLS pin, paired identity). */
data class LanTarget(
    val host: String,
    val port: Int,
    val pinnedCertSha256: String,
    val deviceId: String? = null,
    val deviceSeedB64: String? = null,
) {
    val isPaired: Boolean get() = deviceId != null && deviceSeedB64 != null
}

/** Device-local persistence for the dual-mode switcher (never synced, never exported). */
class DualModePreferences(context: Context) {
    private val prefs: SharedPreferences =
        context.getSharedPreferences("uh_dual_mode", Context.MODE_PRIVATE)

    var mode: OperatingMode
        get() = runCatching { OperatingMode.valueOf(prefs.getString(KEY_MODE, null) ?: OperatingMode.DEFAULT.name) }
            .getOrDefault(OperatingMode.DEFAULT)
        set(value) { prefs.edit().putString(KEY_MODE, value.name).apply() }

    fun saveTarget(target: LanTarget) {
        prefs.edit()
            .putString(KEY_HOST, target.host)
            .putInt(KEY_PORT, target.port)
            .putString(KEY_PIN, target.pinnedCertSha256)
            .putString(KEY_DEVICE_ID, target.deviceId)
            .putString(KEY_SEED, target.deviceSeedB64)
            .apply()
    }

    fun loadTarget(): LanTarget? {
        val host = prefs.getString(KEY_HOST, null) ?: return null
        val pin = prefs.getString(KEY_PIN, null) ?: return null
        return LanTarget(
            host = host,
            port = prefs.getInt(KEY_PORT, 7437),
            pinnedCertSha256 = pin,
            deviceId = prefs.getString(KEY_DEVICE_ID, null),
            deviceSeedB64 = prefs.getString(KEY_SEED, null),
        )
    }

    companion object {
        private const val KEY_MODE = "operating_mode"
        private const val KEY_HOST = "lan_host"
        private const val KEY_PORT = "lan_port"
        private const val KEY_PIN = "lan_cert_pin"
        private const val KEY_DEVICE_ID = "lan_device_id"
        private const val KEY_SEED = "lan_device_seed_b64"

        fun encodeSeed(seed: ByteArray): String =
            Base64.encodeToString(seed, Base64.NO_WRAP)

        fun decodeSeed(b64: String): ByteArray? =
            runCatching { Base64.decode(b64, Base64.NO_WRAP) }.getOrNull()
    }
}
