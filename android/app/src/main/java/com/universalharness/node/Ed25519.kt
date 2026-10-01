package com.universalharness.node

import java.math.BigInteger
import java.security.MessageDigest
import java.security.SecureRandom

/**
 * Pure-Kotlin Ed25519 (RFC 8032), used for the controller/device key on Android versions whose
 * JCA has no EdDSA (JCA Ed25519 needs API 31; the node's oldest supported device is API 30).
 *
 * The Universal Harness node identity and the paired device key are both Ed25519
 * (core/identity/mod.mjs, core/auth/mod.mjs), and the protocol's challenge-response is a raw
 * Ed25519 signature over the challenge bytes with a null hash. This implementation is validated
 * against the RFC 8032 test vectors in [Ed25519Test], so it is the same curve arithmetic the
 * reference vectors specify — not an approximation.
 *
 * Only what the protocol needs is implemented: key generation, SPKI/public encoding, and
 * sign/verify. Nothing else.
 */
object Ed25519 {
    private val P: BigInteger =
        BigInteger.valueOf(2).pow(255).subtract(BigInteger.valueOf(19))
    private val L: BigInteger =
        BigInteger.valueOf(2).pow(252).add(BigInteger("27742317777372353535851937790883648493"))
    private val D: BigInteger =
        BigInteger.valueOf(-121665).multiply(BigInteger.valueOf(121666).modInverse(P)).mod(P)
    private val I: BigInteger =
        BigInteger.valueOf(2).modPow(P.subtract(BigInteger.ONE).divide(BigInteger.valueOf(4)), P)

    private val B_y: BigInteger =
        BigInteger.valueOf(4).multiply(BigInteger.valueOf(5).modInverse(P)).mod(P)
    private val B_x: BigInteger = recoverX(B_y, 0)

    private const val COORD_SIZE = 32

    data class KeyPair(val privateKey: ByteArray, val publicKey: ByteArray) {
        init {
            require(privateKey.size == COORD_SIZE && publicKey.size == COORD_SIZE)
        }
    }

    /** Generate a fresh keypair. The private key is the 32-byte seed of RFC 8032 §5.1.5. */
    fun generateKeyPair(random: SecureRandom = SecureRandom()): KeyPair {
        val seed = ByteArray(COORD_SIZE).also(random::nextBytes)
        return KeyPair(seed, publicFromSeed(seed))
    }

    /** Derive the 32-byte public key (curve point encoding) from a private seed. */
    fun publicFromSeed(seed: ByteArray): ByteArray {
        require(seed.size == COORD_SIZE)
        val h = sha512(seed)
        val a = clampScalar(h.copyOfRange(0, 32))
        val aScalar = decodeScalar(a)
        val point = scalarMult(aScalar, B)
        return encodePoint(point)
    }

    /** Sign `message` with the private seed, producing the 64-byte detached signature. */
    fun sign(message: ByteArray, privateKey: ByteArray): ByteArray {
        require(privateKey.size == COORD_SIZE)
        val h = sha512(privateKey)
        val a = clampScalar(h.copyOfRange(0, 32))
        val prefix = h.copyOfRange(32, 64)
        val A = encodePoint(scalarMult(decodeScalar(a), B))
        val r = decodeScalarModL(sha512(prefix + message))
        val R = scalarMult(r, B)
        val k = decodeScalarModL(sha512(encodePoint(R) + A + message))
        val s = (r + k * decodeScalar(a)).mod(L)
        return encodePoint(R) + encodeScalar(s)
    }

    /**
     * Verify a 64-byte signature over `message` against a 32-byte public key. Constant-failure:
     * every invalid input returns false with no partial information.
     */
    fun verify(message: ByteArray, signature: ByteArray, publicKey: ByteArray): Boolean {
        if (signature.size != 64 || publicKey.size != COORD_SIZE) return false
        val R = decodePoint(signature.copyOfRange(0, 32)) ?: return false
        val A = decodePoint(publicKey) ?: return false
        val s = decodeSignatureScalar(signature.copyOfRange(32, 64)) ?: return false
        val k = decodeScalarModL(sha512(signature.copyOfRange(0, 32) + publicKey + message))
        val left = scalarMult(s, B)
        val right = edwardsAdd(R, scalarMult(k, A))
        // The two sums are equal as *points*, not as projective tuples: compare
        // cross-multiplied affine coordinates instead of exact (X,Y,Z,T).
        val sameX = left.x.multiply(right.z).mod(P) == right.x.multiply(left.z).mod(P)
        val sameY = left.y.multiply(right.z).mod(P) == right.y.multiply(left.z).mod(P)
        return sameX && sameY
    }

    /**
     * Encode a 32-byte Ed25519 public key as a DER SPKI PEM — the `devicePublicKeyPem` shape the
     * protocol's pairing payload requires (identifiers.schema.json / pairing.schema.json). The
     * Ed25519 algorithm OID is 1.3.101.112; the SPKI public key is the raw point encoding.
     */
    fun publicKeyToPem(publicKey: ByteArray): String {
        require(publicKey.size == COORD_SIZE)
        val spki = derSeq(
            derSeq(derOid(ED25519_OID)) +
                derBitString(publicKey)
        )
        val b64 = java.util.Base64.getEncoder().encodeToString(spki)
        return "-----BEGIN PUBLIC KEY-----\n" +
            b64.chunked(64).joinToString("\n") +
            "\n-----END PUBLIC KEY-----\n"
    }

    // ------------------------------------------------------------------ minimal DER

    private fun derLength(len: Int): ByteArray = when {
        len < 0x80 -> byteArrayOf(len.toByte())
        else -> {
            val limbs = mutableListOf<Int>()
            var n = len
            while (n > 0) { limbs.add(0, n and 0xff); n = n ushr 8 }
            byteArrayOf((0x80 or limbs.size).toByte()) + limbs.map(Int::toByte).toByteArray()
        }
    }

    private fun derTagged(tag: Int, contents: ByteArray): ByteArray =
        byteArrayOf(tag.toByte()) + derLength(contents.size) + contents

    private fun derSeq(contents: ByteArray): ByteArray = derTagged(0x30, contents)

    private fun derBitString(contents: ByteArray): ByteArray = derTagged(0x03, byteArrayOf(0) + contents)

    private fun derOid(oid: String): ByteArray {
        val parts = oid.split(".").map(String::toInt)
        val out = mutableListOf(40 * parts[0] + parts[1])
        for (i in 2 until parts.size) {
            var v = parts[i]
            val stack = mutableListOf(v and 0x7f)
            v = v ushr 7
            while (v > 0) { stack.add(0, 0x80 or (v and 0x7f)); v = v ushr 7 }
            out.addAll(stack)
        }
        return derTagged(0x06, out.map(Int::toByte).toByteArray())
    }

    private const val ED25519_OID = "1.3.101.112"

    // ------------------------------------------------------------------ curve arithmetic

    private data class Point(val x: BigInteger, val y: BigInteger, val z: BigInteger, val t: BigInteger)

    private val B = Point(B_x, B_y, BigInteger.ONE, B_x.multiply(B_y).mod(P))

    private fun edwardsAdd(p: Point, q: Point): Point {
        val a = (p.y.subtract(p.x)).multiply(q.y.subtract(q.x)).mod(P)
        val b = (p.y.add(p.x)).multiply(q.y.add(q.x)).mod(P)
        val c = p.t.multiply(BigInteger.valueOf(2)).multiply(D).multiply(q.t).mod(P)
        val d = p.z.multiply(BigInteger.valueOf(2)).multiply(q.z).mod(P)
        // RFC 8032 §5.1.4: A..D as above; E=B-A, F=D-C, G=D+C, H=B+A;
        // X3=E*F, Y3=G*H, Z3=F*G, T3=E*H. With e=H, f=E, g=G, h=F:
        //   X3 = f*h, Y3 = g*e, Z3 = h*g, T3 = f*e.
        val e = b.add(a)
        val f = b.subtract(a)
        val g = d.add(c)
        val h = d.subtract(c)
        return Point(f.multiply(h).mod(P), g.multiply(e).mod(P), h.multiply(g).mod(P), f.multiply(e).mod(P))
    }

    private fun scalarMult(s: BigInteger, point: Point): Point {
        var result = Point(BigInteger.ZERO, BigInteger.ONE, BigInteger.ONE, BigInteger.ZERO)
        var addend = point
        var remaining = s
        while (remaining.signum() > 0) {
            if (remaining.testBit(0)) result = edwardsAdd(result, addend)
            addend = edwardsAdd(addend, addend)
            remaining = remaining.shiftRight(1)
        }
        return result
    }

    // ------------------------------------------------------------------ encoding

    private fun clampScalar(h: ByteArray): ByteArray {
        val out = h.copyOf()
        out[0] = (out[0].toInt() and 248).toByte()
        out[31] = (out[31].toInt() and 127).toByte()
        out[31] = (out[31].toInt() or 64).toByte()
        return out
    }

    /**
     * The private scalar `a`: the clamped first half of the seed hash, read little-endian. The
     * clamping already cleared bit 255, so the value is positive. No further masking — RFC 8032
     * §5.1.5 tweaks exactly the bits [clampScalar] tweaks.
     */
    private fun decodeScalar(bytes: ByteArray): BigInteger {
        return BigInteger(1, bytes.reversedArray())
    }

    /** Reduce a hash-derived scalar mod L (RFC 8032: r and k are taken mod L, never range-checked). */
    private fun decodeScalarModL(bytes: ByteArray): BigInteger {
        return BigInteger(1, bytes.reversedArray()).mod(L)
    }

    /** Decode a signature scalar; RFC 8032 §5.1.7 requires rejecting s >= L. */
    private fun decodeSignatureScalar(bytes: ByteArray): BigInteger? {
        val s = BigInteger(1, bytes.reversedArray())
        if (s >= L) return null
        return s
    }

    private fun encodeScalar(s: BigInteger): ByteArray {
        val out = ByteArray(COORD_SIZE)
        var v = s
        for (i in 0 until COORD_SIZE) {
            out[i] = (v.and(BigInteger.valueOf(0xff)).toInt()).toByte()
            v = v.shiftRight(8)
        }
        return out
    }

    private fun recoverX(y: BigInteger, sign: Int): BigInteger {
        if (y >= P) throw IllegalArgumentException("y out of range")
        val yy = y.pow(2)
        val xx = (yy.subtract(BigInteger.ONE))
            .multiply(D.multiply(yy).add(BigInteger.ONE).modInverse(P)).mod(P)
        var x = xx.modPow(P.add(BigInteger.valueOf(3)).divide(BigInteger.valueOf(8)), P)
        if (!x.pow(2).mod(P).equals(xx)) {
            x = x.multiply(I).mod(P)
        }
        if (!x.pow(2).mod(P).equals(xx)) throw IllegalArgumentException("not a curve point")
        if (x.testBit(0) != (sign == 1)) x = P.subtract(x)
        return x
    }

    private fun encodePoint(point: Point): ByteArray {
        val zInv = point.z.modInverse(P)
        val x = point.x.multiply(zInv).mod(P)
        val y = point.y.multiply(zInv).mod(P)
        val out = ByteArray(COORD_SIZE)
        var v = y
        for (i in 0 until COORD_SIZE - 1) {
            out[i] = (v.and(BigInteger.valueOf(0xff)).toInt()).toByte()
            v = v.shiftRight(8)
        }
        out[31] = ((v.and(BigInteger.valueOf(0x7f)).toInt()) or (if (x.testBit(0)) 0x80 else 0)).toByte()
        return out
    }

    private fun decodePoint(bytes: ByteArray): Point? {
        if (bytes.size != COORD_SIZE) return null
        val sign = (bytes[31].toInt() ushr 7) and 1
        val yLittle = bytes.copyOf().also { it[31] = (it[31].toInt() and 0x7f).toByte() }
        val y = BigInteger(1, yLittle.reversedArray())
        return try {
            val x = recoverX(y, sign)
            Point(x, y, BigInteger.ONE, x.multiply(y).mod(P))
        } catch (e: IllegalArgumentException) {
            null
        }
    }

    private fun sha512(data: ByteArray): ByteArray =
        MessageDigest.getInstance("SHA-512").digest(data)
}
