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
class DualModePreferences(private val context: Context) {
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
            deviceSeedB64 = null, // the seed lives sealed in the keystore, never in prefs
        )
    }

    /**
     * Persist the Ed25519 device seed sealed with the hardware-backed
     * KeystoreCipher (AES-256-GCM), the same pattern [ApiKeyVault] uses.
     * ADR-004: device-local secrets never sit in plaintext preferences —
     * the old base64-in-SharedPreferences storage was trivially extractable
     * on a rooted device and granted permanent node access. A one-time
     * migration seals a legacy plaintext seed and deletes it.
     */
    fun saveSeedSealed(seed: ByteArray) {
        val sealed = com.universalharness.node.KeystoreCipher.encrypt(seed)
        prefs.edit()
            .putString(KEY_SEED, Base64.encodeToString(sealed, Base64.NO_WRAP))
            .remove(KEY_SEED_LEGACY)
            .apply()
    }

    /** The device key restored from keystore-sealed material, or null. */
    fun loadSeededKey(): com.universalharness.node.DeviceKey? {
        // One-time migration: a seed stored plaintext by an older build is
        // sealed now and the plaintext entry removed.
        val legacy = prefs.getString(KEY_SEED_LEGACY, null)
        if (legacy != null) {
            decodeSeed(legacy)?.let { saveSeedSealed(it) }
        }
        val sealedB64 = prefs.getString(KEY_SEED, null) ?: return null
        val sealed = decodeSeed(sealedB64) ?: return null
        val seed = runCatching { com.universalharness.node.KeystoreCipher.decrypt(sealed) }.getOrNull() ?: return null
        return com.universalharness.node.DeviceKey.fromSeed(seed)
    }

    companion object {
        private const val KEY_MODE = "operating_mode"
        private const val KEY_HOST = "lan_host"
        private const val KEY_PORT = "lan_port"
        private const val KEY_PIN = "lan_cert_pin"
        private const val KEY_DEVICE_ID = "lan_device_id"
        private const val KEY_SEED = "lan_device_seed_sealed"
        private const val KEY_SEED_LEGACY = "lan_device_seed_b64"

        fun decodeSeed(b64: String): ByteArray? =
            runCatching { Base64.decode(b64, Base64.NO_WRAP) }.getOrNull()
    }
}
