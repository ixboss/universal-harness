package com.universalharness.node

import android.content.Context
import java.io.File
import java.security.MessageDigest

/**
 * Phase 3B: stages the bundled Universal Harness JS node from the APK's assets into app-private
 * storage, so PRoot can bind-mount it into the guest.
 *
 * The node has zero runtime dependencies (pure ESM), so the guest runs exactly the same source
 * as desktop — there is no second, ported implementation of the protocol. [stageIfNeeded] is
 * content-addressed: a manifest records the SHA-256 of every staged file, so a new APK is
 * re-staged and an unchanged one is a no-op. The staged tree is never executable-from-USB and
 * never leaves the app sandbox.
 */
class UhJsStage(
    private val context: Context,
    private val paths: UhPaths,
) {
    val stagedDir: File = File(paths.stateDir, "uh-js")
    private val manifestFile = File(paths.stateDir, "uh-js-manifest.json")

    /** The guest-visible mount point for the staged tree. */
    val guestMount: String = "/opt/universal-harness"

    /** The guest-visible entry point. */
    val guestEntryPoint: String = "$guestMount/bin/uh.mjs"

    data class StageResult(val staged: File, val fileCount: Int, val changed: Boolean)

    /**
     * Ensure the staged tree matches the APK's assets, returning the staged directory. Safe to
     * call on every start; it only rewrites files whose bytes differ.
     */
    fun stageIfNeeded(): StageResult {
        stagedDir.mkdirs()
        val assets = context.assets.list(ASSET_ROOT) ?: emptyArray()
        check(assets.isNotEmpty()) {
            "the bundled JS node is absent from the APK assets ($ASSET_ROOT); the build's " +
                "prepareUhJsAssets task did not run"
        }
        val previous = readManifest()
        val current = mutableMapOf<String, String>()
        var changed = false
        var count = 0
        for (relative in assets.sorted()) {
            val target = File(stagedDir, relative)
            val digest = stageOne(ASSET_ROOT, relative, target, previous)
            current[relative] = digest
            if (digest != previous[relative]) changed = true
            count++
        }
        // Remove files that a previous APK staged but this one no longer ships.
        for ((relative, _) in previous) {
            if (relative !in current) {
                File(stagedDir, relative).delete()
                changed = true
            }
        }
        if (changed) writeManifest(current)
        return StageResult(stagedDir, count, changed)
    }

    /** Recursively copy one asset entry, returning its SHA-256, rewriting only on difference. */
    private fun stageOne(assetParent: String, relative: String, target: File, previous: Map<String, String>): String {
        val children = context.assets.list("$assetParent/$relative")
        return if (children != null && children.isNotEmpty()) {
            target.mkdirs()
            // Always descend, and make the directory digest a Merkle hash of child
            // names AND their digests: a name-only digest would stay identical when a
            // file's *contents* change, and the descent would never reach it.
            val entries = children.sorted().map { child ->
                child to stageOne("$assetParent/$relative", child, File(target, child), previous)
            }
            val digest = MessageDigest.getInstance("SHA-256")
                .digest(entries.joinToString("\n") { (name, hex) -> "$name:$hex" }.toByteArray())
            digest.toHex()
        } else {
            target.parentFile?.mkdirs()
            val bytes = context.assets.open("$assetParent/$relative").use { it.readBytes() }
            val hex = MessageDigest.getInstance("SHA-256").digest(bytes).toHex()
            if (hex != previous[relative] || !target.isFile) {
                target.writeBytes(bytes)
            }
            hex
        }
    }

    private fun readManifest(): Map<String, String> = runCatching {
        if (!manifestFile.isFile) return@runCatching emptyMap()
        val o = org.json.JSONObject(manifestFile.readText())
        val out = mutableMapOf<String, String>()
        for (key in o.keys()) out[key] = o.getString(key)
        out
    }.getOrDefault(emptyMap())

    private fun writeManifest(entries: Map<String, String>) {
        val json = org.json.JSONObject(entries as Map<String, Any?>)
        manifestFile.writeText(json.toString())
    }

    private fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it) }

    companion object {
        /** Asset root the Gradle `prepareUhJsAssets` Sync task stages into. */
        const val ASSET_ROOT = "uh-js"
    }
}
