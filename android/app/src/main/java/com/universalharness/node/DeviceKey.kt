package com.universalharness.node

/**
 * The controller's long-lived device key: the Ed25519 seed (RFC 8032 §5.1.5) plus the same
 * public key in the SPKI PEM form the wire contract requires for device.pair
 * (identifiers.schema.json). The seed never leaves this process; only the PEM travels.
 */
class DeviceKey private constructor(val seed: ByteArray, val publicKeyPem: String) {
    companion object {
        fun generate(): DeviceKey {
            val pair = Ed25519.generateKeyPair()
            return DeviceKey(pair.privateKey, Ed25519.publicKeyToPem(pair.publicKey))
        }

        fun fromSeed(seed: ByteArray): DeviceKey =
            DeviceKey(seed.copyOf(), Ed25519.publicKeyToPem(Ed25519.publicFromSeed(seed)))
    }
}
