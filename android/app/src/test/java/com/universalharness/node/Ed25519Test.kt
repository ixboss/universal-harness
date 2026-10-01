package com.universalharness.node

import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The pure-Kotlin Ed25519 is held to the RFC 8032 §7.1 test vectors (verified against the RFC
 * text itself) and to a long-message vector cross-signed by Node's OpenSSL-backed crypto, so the
 * controller's challenge-response signatures are bit-identical to what the JS node verifies.
 */
class Ed25519Test {
    private fun hex(s: String): ByteArray = s.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
    private fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it) }

    // RFC 8032 §7.1 TEST 1 — empty message.
    private val t1Seed = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"
    private val t1Pub = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a"
    private val t1Sig = "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555f" +
        "b8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b"

    // RFC 8032 §7.1 TEST 2 — one byte 0x72.
    private val t2Seed = "4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb"
    private val t2Pub = "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c"
    private val t2Msg = "72"
    private val t2Sig = "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da" +
        "085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00"

    // RFC 8032 §7.1 TEST 3 — two bytes 0xaf82.
    private val t3Seed = "c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7"
    private val t3Pub = "fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025"
    private val t3Msg = "af82"
    private val t3Sig = "6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac" +
        "18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a"

    // Long-message vector produced with Node's Ed25519 (OpenSSL), deterministically: the same
    // seed and message MUST yield this signature under any RFC 8032 implementation.
    private val longSeed = "c8aace7cf0d5e1f2d9c4a5b6374c8f1e0d2b3a4c5d6e7f8091a2b3c4d5e6f708"
    private val longPub = "a5ea9873e5ea37adcfb8d80c875604956cb85e23cebd71ae1b15c086e1126df5"
    private val longMessage =
        "Universal Harness Phase 3B challenge-response line.\n".repeat(40).toByteArray(Charsets.UTF_8)
    private val longSig = "d62a3d427dc6a335c4e4e883acc9b580e0a5d8a620b6d9bc0c3ba1d4104f1080" +
        "6041c240a985b2fbdd4dc8ffa55b540e70fbff6360a1a29792db83be943e5e0f"

    @Test
    fun `public keys match RFC 8032 vectors`() {
        assertContentEquals(hex(t1Pub), Ed25519.publicFromSeed(hex(t1Seed)), "vector 1 public key")
        assertContentEquals(hex(t2Pub), Ed25519.publicFromSeed(hex(t2Seed)), "vector 2 public key")
        assertContentEquals(hex(t3Pub), Ed25519.publicFromSeed(hex(t3Seed)), "vector 3 public key")
        assertContentEquals(hex(longPub), Ed25519.publicFromSeed(hex(longSeed)), "long-vector public key")
    }

    @Test
    fun `signatures match RFC 8032 vectors`() {
        assertContentEquals(hex(t1Sig), Ed25519.sign(ByteArray(0), hex(t1Seed)), "vector 1 signature")
        assertContentEquals(hex(t2Sig), Ed25519.sign(hex(t2Msg), hex(t2Seed)), "vector 2 signature")
        assertContentEquals(hex(t3Sig), Ed25519.sign(hex(t3Msg), hex(t3Seed)), "vector 3 signature")
        assertContentEquals(hex(longSig), Ed25519.sign(longMessage, hex(longSeed)), "long-vector signature")
    }

    @Test
    fun `signing is deterministic`() {
        val seed = hex(t2Seed)
        val message = "auth.connect challenge".toByteArray(Charsets.UTF_8)
        assertContentEquals(Ed25519.sign(message, seed), Ed25519.sign(message, seed))
    }

    @Test
    fun `valid signatures verify`() {
        assertTrue(Ed25519.verify(ByteArray(0), hex(t1Sig), hex(t1Pub)))
        assertTrue(Ed25519.verify(hex(t2Msg), hex(t2Sig), hex(t2Pub)))
        assertTrue(Ed25519.verify(hex(t3Msg), hex(t3Sig), hex(t3Pub)))
        assertTrue(Ed25519.verify(longMessage, hex(longSig), hex(longPub)))
    }

    @Test
    fun `tampered inputs fail verification`() {
        val message = hex(t2Msg)
        val signature = hex(t2Sig)
        val publicKey = hex(t2Pub)

        val flippedMessage = message.copyOf().also { it[0] = 0x73 }
        assertFalse(Ed25519.verify(flippedMessage, signature, publicKey), "modified message")

        val flippedSig = signature.copyOf().also { it[10] = (it[10].toInt() xor 1).toByte() }
        assertFalse(Ed25519.verify(message, flippedSig, publicKey), "modified signature")

        val wrongPub = Ed25519.publicFromSeed(hex(t1Seed))
        assertFalse(Ed25519.verify(message, signature, wrongPub), "wrong public key")
    }

    @Test
    fun `a signature scalar at or above L is rejected`() {
        // RFC 8032 §5.1.7: reject s >= L. 0xff…ff is far above L; the constant-failure path
        // must return false, not throw or wrap.
        val forged = hex(t1Sig).copyOf()
        for (i in 32 until 64) forged[i] = 0xff.toByte()
        assertFalse(Ed25519.verify(ByteArray(0), forged, hex(t1Pub)))
    }

    @Test
    fun `malformed sizes fail verification without throwing`() {
        assertFalse(Ed25519.verify(ByteArray(0), ByteArray(63), hex(t1Pub)))
        assertFalse(Ed25519.verify(ByteArray(0), hex(t1Sig), ByteArray(31)))
    }

    @Test
    fun `a generated keypair signs and verifies its own messages`() {
        val pair = Ed25519.generateKeyPair()
        assertEquals(32, pair.privateKey.size)
        assertEquals(32, pair.publicKey.size)
        val message = "device key round trip".toByteArray(Charsets.UTF_8)
        val signature = Ed25519.sign(message, pair.privateKey)
        assertTrue(Ed25519.verify(message, signature, pair.publicKey))
        assertContentEquals(Ed25519.publicFromSeed(pair.privateKey), pair.publicKey)
    }

    @Test
    fun `two generated keypairs differ`() {
        val a = Ed25519.generateKeyPair()
        val b = Ed25519.generateKeyPair()
        assertFalse(a.privateKey.contentEquals(b.privateKey))
    }

    @Test
    fun `public key PEM is the standard 44-byte Ed25519 SPKI`() {
        val pem = Ed25519.publicKeyToPem(hex(t1Pub))
        val base64 = pem.lines().filterNot { it.startsWith("-----") }.joinToString("")
        val der = java.util.Base64.getMimeDecoder().decode(base64)
        val header = java.util.Base64.getMimeDecoder().decode("MCowBQYDK2VwAyEA")
        // MCowBQYDK2VwAyEA is the fixed SPKI header: SEQ{ SEQ{OID 1.3.101.112} BITSTRING }.
        val expected = header + hex(t1Pub)
        assertContentEquals(expected, der, "SPKI DER must equal the standard Ed25519 encoding")
        assertEquals(44, der.size, "the Ed25519 SPKI is exactly 44 bytes")
        assertTrue(pem.startsWith("-----BEGIN PUBLIC KEY-----"))
        assertTrue(pem.trimEnd().endsWith("-----END PUBLIC KEY-----"))
    }

    @Test
    fun `a wrong-size seed or key is rejected`() {
        assertFailsWith<IllegalArgumentException> { Ed25519.publicFromSeed(ByteArray(31)) }
        assertFailsWith<IllegalArgumentException> { Ed25519.sign(ByteArray(0), ByteArray(16)) }
        assertFailsWith<IllegalArgumentException> { Ed25519.publicKeyToPem(ByteArray(33)) }
    }
}
