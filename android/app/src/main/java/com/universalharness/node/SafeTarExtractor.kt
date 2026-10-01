package com.universalharness.node

import java.io.File
import java.io.IOException
import java.io.InputStream
import org.apache.commons.compress.archivers.tar.TarArchiveEntry
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream
import org.apache.commons.compress.compressors.gzip.GzipCompressorInputStream

/**
 * Hardened tar / tar.gz extraction for guest rootfs content.
 *
 * Security rules (a rootfs tarball is untrusted until its checksum has been verified, and the
 * checksum is of the whole archive, not of each member's placement):
 *  - entry names are normalized; absolute paths, `..` segments and NUL bytes are rejected;
 *  - symbolic links are created only when the link target is relative AND resolves inside the
 *    destination root — absolute or escaping links are rejected;
 *  - hard links are rejected (the guest rootfs does not need them and a hard link can point
 *    anywhere the archive says);
 *  - entries may not escape via case/separator tricks because the comparison is done on the
 *    canonicalized path against the destination root prefix.
 *
 * Ubuntu base images contain merged-/usr symlinks (e.g. /bin -> usr/bin), which are relative
 * and contained, so they pass; RuntimeInstaller-style compatibility repairs remain possible
 * afterwards.
 */
object SafeTarExtractor {
    class UnsafeEntryException(message: String) : IOException(message)

    fun extractGzipTar(tarGz: File, destination: File, onEntry: ((String) -> Unit)? = null) {
        destination.mkdirs()
        val canonicalRoot = destination.canonicalFile
        tarGz.inputStream().buffered().use { raw ->
            GzipCompressorInputStream(raw).use { gzip ->
                extract(TarArchiveInputStream(gzip), canonicalRoot, onEntry)
            }
        }
    }

    private fun extract(tar: TarArchiveInputStream, root: File, onEntry: ((String) -> Unit)?) {
        while (true) {
            val entry = tar.nextTarEntry ?: return
            val name = entry.name.replace('\\', '/')
            requireSanitized(name)
            val relative = normalize(name)
            if (relative.isEmpty()) continue
            val target = File(root, relative)
            if (!target.canonicalFile.path.startsWith(root.path + File.separator) &&
                target.canonicalFile.path != root.path
            ) {
                throw UnsafeEntryException("archive entry escapes the destination: $name")
            }
            onEntry?.invoke(relative)
            when {
                entry.isDirectory -> target.mkdirs()
                entry.isSymbolicLink -> createSafeSymlink(entry, root, target, name)
                entry.isLink -> throw UnsafeEntryException("hard links are not permitted: $name")
                entry.isFile -> {
                    target.parentFile?.mkdirs()
                    target.outputStream().use { out -> tar.copyTo(out) }
                    // Preserve the executable bit; the guest needs it for /bin/* and node.
                    if (entry.mode and 0b001_000_000 != 0) target.setExecutable(true, false)
                }
                else -> {
                    // FIFO / device nodes from the archive are never created; the guest
                    // binds the real /dev from the host.
                }
            }
        }
    }

    private fun createSafeSymlink(entry: TarArchiveEntry, root: File, target: File, name: String) {
        val linkName = entry.linkName.replace('\\', '/')
        if (linkName.startsWith("/")) {
            throw UnsafeEntryException("absolute symlink is not permitted: $name -> $linkName")
        }
        if (linkName.contains('\u0000')) throw UnsafeEntryException("NUL byte in symlink target: $name")
        // A relative target may contain ".." as long as it RESOLVES inside the root — e.g.
        // the merged-/usr links an Ubuntu rootfs ships (bin -> usr/bin). Resolve lexically
        // against the link's parent and require containment.
        val resolved = File(target.parentFile, linkName).canonicalFile
        if (!resolved.path.startsWith(root.path + File.separator) && resolved.path != root.path) {
            throw UnsafeEntryException("symlink escapes the destination: $name -> $linkName")
        }
        target.parentFile?.mkdirs()
        target.delete()
        try {
            java.nio.file.Files.createSymbolicLink(
                target.toPath(),
                java.nio.file.Paths.get(linkName),
            )
        } catch (_: java.nio.file.FileAlreadyExistsException) {
            throw IOException("symlink target already exists: $name")
        } catch (e: java.io.IOException) {
            throw IOException("could not create symlink $name -> $linkName: ${e.message}", e)
        }
    }

    private fun requireSanitized(name: String) {
        if (name.isEmpty()) return
        if (name.contains('\u0000')) throw UnsafeEntryException("NUL byte in archive entry: $name")
        val normalized = normalize(name)
        if (normalized.isEmpty()) return
        if (name.startsWith("/")) throw UnsafeEntryException("absolute archive entry: $name")
        for (segment in normalized.split('/')) {
            if (segment == "..") throw UnsafeEntryException("parent traversal in archive entry: $name")
        }
    }

    /** Strips leading "./" repeats and collapses duplicate separators; rejects nothing here. */
    private fun normalize(name: String): String {
        val segments = name.split('/').filter { it.isNotEmpty() && it != "." }
        return segments.joinToString("/")
    }
}
