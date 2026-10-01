package com.universalharness.node

import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue
import org.apache.commons.compress.archivers.tar.TarArchiveEntry
import org.apache.commons.compress.archivers.tar.TarConstants
import org.apache.commons.compress.archivers.tar.TarArchiveOutputStream
import org.apache.commons.compress.compressors.gzip.GzipCompressorOutputStream

class SafeTarExtractorTest {
    private fun tempDir(name: String): File =
        File(System.getProperty("java.io.tmpdir"), "uh-tar-test-$name-${System.nanoTime()}").apply { mkdirs() }

    private fun writeTarGz(dest: File, configure: (TarArchiveOutputStream) -> Unit) {
        TarArchiveOutputStream(GzipCompressorOutputStream(FileOutputStream(dest))).use { tar -> configure(tar) }
    }

    private fun entry(tar: TarArchiveOutputStream, name: String, content: String, mode: Int = 420) {
        val bytes = content.toByteArray()
        val e = TarArchiveEntry(name)
        e.size = bytes.size.toLong()
        e.mode = mode
        tar.putArchiveEntry(e)
        tar.write(bytes)
        tar.closeArchiveEntry()
    }

    @Test
    fun `regular files and nested directories extract with executable bits`() {
        val tarGz = File(tempDir("src"), "a.tar.gz")
        writeTarGz(tarGz) { tar ->
            entry(tar, "./etc/os-release", "ID=ubuntu\n")
            entry(tar, "./usr/local/bin/tool", "#!/bin/sh\necho hi\n", mode = 493)
            entry(tar, "./usr/lib/file.txt", "x")
        }
        val dest = tempDir("dest")
        SafeTarExtractor.extractGzipTar(tarGz, dest)
        assertEquals("ID=ubuntu\n", File(dest, "etc/os-release").readText())
        val tool = File(dest, "usr/local/bin/tool")
        assertTrue(tool.canExecute(), "the executable bit must be preserved")
        assertEquals("#!/bin/sh\necho hi\n", tool.readText())
    }

    @Test
    fun `parent traversal is rejected`() {
        val tarGz = File(tempDir("src2"), "a.tar.gz")
        writeTarGz(tarGz) { tar -> entry(tar, "../escape.txt", "nope") }
        val dest = tempDir("dest2")
        assertFailsWith<SafeTarExtractor.UnsafeEntryException> {
            SafeTarExtractor.extractGzipTar(tarGz, dest)
        }
        assertTrue(File(dest.parentFile.parentFile, "escape.txt").exists().not())
    }

    // Note: an ABSOLUTE entry name (e.g. "/etc/passwd") cannot be constructed through
    // commons-compress's TarArchiveEntry - it strips leading slashes unless
    // preserveAbsolutePath is set - so the extractor's absolute-name guard is
    // defense-in-depth for a hostile writer and has no constructible test here.

    @Test
    fun `a contained relative symlink is created`() {
        // Windows requires elevated privileges to create symlinks; the guest target (Linux)
        // does not. The security VALIDATION paths are exercised on every platform above.
        org.junit.Assume.assumeFalse(System.getProperty("os.name").contains("win", ignoreCase = true))
        val tarGz = File(tempDir("src4"), "a.tar.gz")
        writeTarGz(tarGz) { tar ->
            entry(tar, "./usr/bin/real", "payload")
            val link = TarArchiveEntry("./bin/usr-bin-link", TarConstants.LF_SYMLINK)
            link.linkName = "../usr/bin/real"
            tar.putArchiveEntry(link)
            tar.closeArchiveEntry()
        }
        val dest = tempDir("dest4")
        SafeTarExtractor.extractGzipTar(tarGz, dest)
        val link = File(dest, "bin/usr-bin-link")
        assertTrue(link.exists(), "contained symlink must resolve")
        assertEquals("payload", link.readText())
    }

    @Test
    fun `an escaping symlink is rejected`() {
        val tarGz = File(tempDir("src5"), "a.tar.gz")
        writeTarGz(tarGz) { tar ->
            val link = TarArchiveEntry("./bin/escape", TarConstants.LF_SYMLINK)
            link.linkName = "../../../../etc/passwd"
            tar.putArchiveEntry(link)
            tar.closeArchiveEntry()
        }
        assertFailsWith<SafeTarExtractor.UnsafeEntryException> {
            SafeTarExtractor.extractGzipTar(tarGz, tempDir("dest5"))
        }
    }

    @Test
    fun `absolute symlink targets inside the guest root are allowed (Debian alternatives)`() {
        // Found on the real device: ubuntu-base ships etc/alternatives/* -> /usr/bin/*.
        org.junit.Assume.assumeFalse(System.getProperty("os.name").contains("win", ignoreCase = true))
        val tarGz = File(tempDir("src7"), "a.tar.gz")
        writeTarGz(tarGz) { tar ->
            val link = TarArchiveEntry("./etc/alternatives/awk", TarConstants.LF_SYMLINK)
            link.linkName = "/usr/bin/mawk"
            tar.putArchiveEntry(link)
            tar.closeArchiveEntry()
        }
        val dest = tempDir("dest7")
        SafeTarExtractor.extractGzipTar(tarGz, dest)
        assertTrue(File(dest, "etc/alternatives/awk").exists(), "absolute in-guest symlink must be created")
    }

    @Test
    fun `a traversing absolute symlink is rejected`() {
        val tarGz = File(tempDir("src8"), "a.tar.gz")
        writeTarGz(tarGz) { tar ->
            val link = TarArchiveEntry("./etc/evil", TarConstants.LF_SYMLINK)
            link.linkName = "/../evil"
            tar.putArchiveEntry(link)
            tar.closeArchiveEntry()
        }
        assertFailsWith<SafeTarExtractor.UnsafeEntryException> {
            SafeTarExtractor.extractGzipTar(tarGz, tempDir("dest8"))
        }
    }

    @Test
    fun `a contained hard link to an extracted file is created (Debian bzcat pattern)`() {
        val tarGz = File(tempDir("src6"), "a.tar.gz")
        writeTarGz(tarGz) { tar ->
            entry(tar, "./usr/bin/bzip2", "payload", mode = 493)
            val link = TarArchiveEntry("./usr/bin/bzcat", TarConstants.LF_LINK)
            link.linkName = "usr/bin/bzip2"
            tar.putArchiveEntry(link)
            tar.closeArchiveEntry()
        }
        val dest = tempDir("dest6")
        SafeTarExtractor.extractGzipTar(tarGz, dest)
        val bzcat = File(dest, "usr/bin/bzcat")
        val bzip2 = File(dest, "usr/bin/bzip2")
        // The contract the guest depends on: the linked name exposes the target's bytes.
        // Android denies linkat(2) to apps, so the extractor degrades to a copy there and the
        // two paths are NOT the same inode — hence content is asserted unconditionally and
        // inode sharing only where the OS actually allows hard links.
        assertEquals("payload", bzcat.readText())
        assertEquals(bzip2.readBytes().toList(), bzcat.readBytes().toList())
        if (!System.getProperty("os.name").contains("win", ignoreCase = true)) {
            assertTrue(java.nio.file.Files.isSameFile(bzcat.toPath(), bzip2.toPath()),
                "bzcat must share bzip2's inode where the OS allows hard links")
        }
    }

    @Test
    fun `a hard link to a not-yet-extracted target is rejected`() {
        val tarGz = File(tempDir("src6b"), "a.tar.gz")
        writeTarGz(tarGz) { tar ->
            val link = TarArchiveEntry("./usr/bin/bzcat", TarConstants.LF_LINK)
            link.linkName = "usr/bin/later-file"
            tar.putArchiveEntry(link)
            tar.closeArchiveEntry()
        }
        assertFailsWith<SafeTarExtractor.UnsafeEntryException> {
            SafeTarExtractor.extractGzipTar(tarGz, tempDir("dest6b"))
        }
    }
}
