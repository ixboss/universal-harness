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
 *  - symbolic links are created only when the link target resolves inside the destination
 *    root — escaping links are rejected (absolute targets without traversal are legitimate
 *    Debian alternatives and are allowed);
 *  - hard links are resolved against the archive root, required to stay inside the
 *    destination, and materialized once their target file exists; when the OS refuses the
 *    hard link (Android denies linkat(2) to apps) the entry degrades to a byte copy;
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
        val deferredLinks = mutableListOf<TarArchiveEntry>()
        val deferredTargets = mutableListOf<File>()
        tarGz.inputStream().buffered().use { raw ->
            GzipCompressorInputStream(raw).use { gzip ->
                extract(TarArchiveInputStream(gzip), canonicalRoot, onEntry, deferredLinks, deferredTargets)
            }
        }
        // Second pass: Debian rootfs archives list hard links BEFORE their targets and chain
        // them (bzcat -> bunzip2 -> bzip2), so links are materialized in rounds: each round
        // creates every link whose target file now exists; a full round with no progress
        // means the archive references a file it never shipped.
        var pendingLinks = deferredLinks
        var pendingTargets = deferredTargets
        while (pendingLinks.isNotEmpty()) {
            val roundLinks = mutableListOf<TarArchiveEntry>()
            val roundTargets = mutableListOf<File>()
            for (i in pendingLinks.indices) {
                val link = pendingLinks[i]
                val target = pendingTargets[i]
                val source = hardLinkSource(canonicalRoot, link, link.name)
                if (source != null) {
                    materializeHardLink(target, source, link, link.name)
                } else {
                    roundLinks.add(link)
                    roundTargets.add(target)
                }
            }
            if (roundLinks.size == pendingLinks.size) {
                // No progress this round: the first unresolved link is genuinely dangling.
                createSafeHardLink(canonicalRoot, pendingLinks.first(), pendingTargets.first(), pendingLinks.first().name)
            }
            pendingLinks = roundLinks
            pendingTargets = roundTargets
        }
    }

    private fun extract(
        tar: TarArchiveInputStream,
        root: File,
        onEntry: ((String) -> Unit)?,
        deferredLinks: MutableList<TarArchiveEntry>,
        deferredTargets: MutableList<File>,
    ) {
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
                entry.isLink -> {
                    // Deferred: the target file may appear later in the archive.
                    deferredLinks.add(entry)
                    deferredTargets.add(target)
                }
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
        if (linkName.contains('\u0000')) throw UnsafeEntryException("NUL byte in symlink target: $name")
        if (linkName.startsWith("/")) {
            // Absolute targets are legitimate in a Debian rootfs (etc/alternatives/* ->
            // /usr/bin/*, found on the real device). They resolve INSIDE the guest root by
            // construction; the only hostile form is one that traverses (e.g. "/../x"),
            // so reject traversal segments and allow the rest.
            if (linkName.split('/').any { it == ".." }) {
                throw UnsafeEntryException("traversing absolute symlink is not permitted: $name -> $linkName")
            }
        } else {
            // A relative target may contain ".." as long as it RESOLVES inside the root — e.g.
            // the merged-/usr links an Ubuntu rootfs ships (bin -> usr/bin). Resolve lexically
            // against the link's parent and require containment.
            val resolved = File(target.parentFile, linkName).canonicalFile
            if (!resolved.path.startsWith(root.path + File.separator) && resolved.path != root.path) {
                throw UnsafeEntryException("symlink escapes the destination: $name -> $linkName")
            }
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

    /**
     * Hard links are legitimate in a Debian rootfs (e.g. usr/bin/bzcat shares bunzip2's
     * inode, found on the real device). Per the tar format, a hard link's target is relative
     * to the ARCHIVE ROOT (not the entry's parent like a symlink), so resolve against the
     * extraction root, require containment, and hard-link to the file once it exists.
     * Returns null (with no side effects) when the target is not extracted yet.
     */
    private fun hardLinkSource(root: File, entry: TarArchiveEntry, name: String): File? {
        val linkName = entry.linkName.replace('\\', '/').trimStart('.', '/')
        if (linkName.contains('\u0000')) throw UnsafeEntryException("NUL byte in hard link target: $name")
        if (entry.linkName.startsWith("/")) {
            throw UnsafeEntryException("absolute hard link is not permitted: $name -> ${entry.linkName}")
        }
        for (segment in linkName.split('/')) {
            if (segment == "..") throw UnsafeEntryException("hard link traverses the destination: $name -> $linkName")
        }
        val source = File(root, linkName).canonicalFile
        if (!source.path.startsWith(root.path + File.separator) && source.path != root.path) {
            throw UnsafeEntryException("hard link escapes the destination: $name -> $linkName")
        }
        return source.takeIf { it.isFile }
    }

    private fun createSafeHardLink(root: File, entry: TarArchiveEntry, target: File, name: String) {
        val source = hardLinkSource(root, entry, name)
            ?: throw UnsafeEntryException("hard link target not yet extracted: $name -> ${entry.linkName}")
        materializeHardLink(target, source, entry, name)
    }

    /**
     * Android denies hard link creation to unprivileged apps — linkat(2) returns EACCES even
     * in the app's own private storage (confirmed on the real device with `ln`, and via
     * AccessDeniedException from Files.createLink during the Gate D rootfs extraction). A tar
     * hard link is semantically "this entry is another name for an already-extracted file",
     * so when the kernel refuses the link the entry degrades to a byte copy of the target.
     * The guest sees identical bytes at the same path; the only cost is disk space, and a
     * Debian base rootfs carries only a handful of small hard-linked binaries.
     */
    private fun materializeHardLink(target: File, source: File, entry: TarArchiveEntry, name: String) {
        target.parentFile?.mkdirs()
        target.delete()
        try {
            java.nio.file.Files.createLink(target.toPath(), source.toPath())
            return
        } catch (_: java.nio.file.AccessDeniedException) {
            // The OS refuses hard links here; fall back to copying the bytes below.
        }
        source.inputStream().use { input ->
            target.outputStream().use { output -> input.copyTo(output) }
        }
        if (entry.mode and 0b001_000_000 != 0) target.setExecutable(true, false)
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
