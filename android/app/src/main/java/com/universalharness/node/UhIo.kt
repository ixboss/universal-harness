package com.universalharness.node

import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/** Streaming SHA-256 of a file (64 KiB chunks; never loads the file into memory). */
object Sha256 {
    fun ofFile(file: File): String {
        val md = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buf = ByteArray(64 * 1024)
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                md.update(buf, 0, n)
            }
        }
        return md.digest().joinToString("") { "%02x".format(it) }
    }

    fun ofBytes(bytes: ByteArray): String {
        val md = MessageDigest.getInstance("SHA-256")
        return md.digest(bytes).joinToString("") { "%02x".format(it) }
    }
}

/**
 * Download a pinned artifact and verify its SHA-256 BEFORE it becomes visible under its final
 * name. The partial download lives at `<final>.part`; a failed or mismatched download never
 * replaces a previous good copy, and a partial file is never mistaken for a complete one.
 *
 * If the final file already exists and hashes correctly, the download is skipped (resumable
 * installs), so an interrupted run can be retried without re-fetching.
 */
object VerifiedFetcher {
    class VerificationException(message: String) : IOException(message)

    /**
     * @param sha256 expected digest of the complete artifact
     * @return the verified file at [destination]
     * @throws VerificationException when the downloaded bytes do not match the pin
     */
    fun fetch(
        url: String,
        destination: File,
        sha256: String,
        connectTimeoutMs: Int = 30_000,
        readTimeoutMs: Int = 120_000,
        onProgress: ((bytesSoFar: Long, totalBytes: Long) -> Unit)? = null,
    ): File {
        destination.parentFile?.mkdirs()
        if (destination.isFile && destination.length() > 0 && Sha256.ofFile(destination) == sha256) {
            return destination
        }
        val partial = File(destination.parentFile, destination.name + ".part")
        partial.delete()
        val connection = URL(url).openConnection() as HttpURLConnection
        try {
            connection.connectTimeout = connectTimeoutMs
            connection.readTimeout = readTimeoutMs
            connection.instanceFollowRedirects = true
            connection.connect()
            val code = connection.responseCode
            if (code !in 200..299) {
                throw IOException("download of $url failed with HTTP $code")
            }
            val total = connection.contentLengthLong
            var written = 0L
            FileOutputStream(partial).use { out ->
                connection.inputStream.use { input ->
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        out.write(buf, 0, n)
                        written += n
                        onProgress?.invoke(written, total)
                    }
                }
            }
            val actual = Sha256.ofFile(partial)
            if (actual != sha256) {
                partial.delete()
                throw VerificationException(
                    "downloaded artifact from $url does not match its pin " +
                        "(expected $sha256, got $actual); partial file deleted",
                )
            }
            destination.delete()
            if (!partial.renameTo(destination)) {
                partial.copyTo(destination, overwrite = true)
                partial.delete()
            }
            return destination
        } finally {
            connection.disconnect()
        }
    }
}
