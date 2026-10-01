package com.universalharness.node

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Device-bound cryptographic foundation for the future node identity and pairing secrets
 * (ADR-004/ADR-007: device-local secrets live in Android Keystore, never in plaintext files
 * and never in the portable tree).
 *
 * Phase 3A scope: an AES-256-GCM key held by the Android Keystore hardware-backed keystore
 * when the device provides one, plus authenticated encrypt/decrypt helpers. Key generation is
 * idempotent. Wire format: [12-byte IV | ciphertext+tag]. No key material ever leaves the
 * Keystore; nothing here touches the filesystem.
 */
object KeystoreCipher {
    private const val ANDROID_KEYSTORE = "AndroidKeyStore"
    private const val KEY_ALIAS = "uh_node_master"
    private const val GCM_TAG_BITS = 128
    private const val IV_BYTES = 12

    fun ensureKey(): SecretKey {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setRandomizedEncryptionRequired(true)
                .build(),
        )
        return generator.generateKey()
    }

    /** @return [12-byte IV | ciphertext+tag] for storage or transport. */
    fun encrypt(plain: ByteArray): ByteArray {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, ensureKey())
        val iv = cipher.iv
        require(iv.size == IV_BYTES) { "unexpected GCM IV length ${iv.size}" }
        val ciphertext = cipher.doFinal(plain)
        return iv + ciphertext
    }

    fun decrypt(sealed: ByteArray): ByteArray {
        require(sealed.size > IV_BYTES) { "sealed payload too short" }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(
            Cipher.DECRYPT_MODE,
            ensureKey(),
            GCMParameterSpec(GCM_TAG_BITS, sealed, 0, IV_BYTES),
        )
        return cipher.doFinal(sealed, IV_BYTES, sealed.size - IV_BYTES)
    }
}
