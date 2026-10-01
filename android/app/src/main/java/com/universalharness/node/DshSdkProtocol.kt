package com.universalharness.node

import org.json.JSONObject

/**
 * Pure protocol pieces of the dsh SDK seam (newline-delimited JSON-RPC 2.0 on stdout), kept
 * free of any Android dependency so they run in JVM unit tests. The message shapes mirror the
 * Phase 1 JS adapter exactly (core/adapter/mod.mjs): requests `initialize`, `session/prompt`,
 * `shutdown`; notifications `session.event`, `session.status`, `subagent.started`,
 * `subagent.finished`; non-JSON stdout lines are tolerated and skipped, never fatal.
 */
object DshSdkProtocol {
    val NOTIFICATION_METHODS = setOf(
        "session.event", "session.status", "subagent.started", "subagent.finished",
    )

    fun initializeParams(cwd: String, provider: String? = null, model: String? = null): JSONObject =
        JSONObject().apply {
            put("cwd", cwd)
            if (provider != null) put("provider", provider)
            if (model != null) put("model", model)
        }

    fun promptParams(sessionId: String, text: String): JSONObject =
        JSONObject().apply {
            put("sessionId", sessionId)
            put(
                "contentBlocks",
                org.json.JSONArray().put(
                    JSONObject().put("type", "text").put("text", text),
                ),
            )
        }

    fun request(method: String, id: Int, params: JSONObject? = null): JSONObject =
        JSONObject().apply {
            put("jsonrpc", "2.0")
            put("id", id)
            put("method", method)
            if (params != null) put("params", params)
        }

    fun isResponse(frame: JSONObject, id: Int): Boolean =
        frame.opt("id") == id && (frame.has("result") || frame.has("error"))

    fun isErrorResponse(frame: JSONObject): Boolean = frame.optJSONObject("error") != null

    fun errorMessage(frame: JSONObject): String {
        val error = frame.optJSONObject("error") ?: return "unknown error"
        return error.optString("message", "unknown error")
    }

    fun notificationMethod(frame: JSONObject): String? =
        frame.optString("method", "").takeIf { it in NOTIFICATION_METHODS }

    /** One raw stdout line -> a parsed frame, or null for tolerated non-protocol noise. */
    fun parseLine(line: String): JSONObject? {
        val trimmed = line.trim()
        if (trimmed.isEmpty()) return null
        return try {
            JSONObject(trimmed)
        } catch (_: Exception) {
            null
        }
    }

    fun exitInfo(exitCode: Int, signal: Int?): String =
        if (signal != null) "signaled: $signal" else "exit code: $exitCode"
}

/**
 * Incremental NDJSON framer: feed raw bytes, receive complete lines. stdout arrives in
 * arbitrary chunks from the pipe, so frames must be reassembled without buffering unboundedly
 * (a 1 MiB per-line ceiling matches the desktop transport's defense).
 */
class NdJsonFramer(private val maxLineBytes: Int = 1024 * 1024) {
    private val buffer = StringBuilder()
    var corrupted: Boolean = false
        private set

    /** Feed decoded text; returns every complete line found (may be empty). */
    fun push(text: String): List<String> {
        if (corrupted || text.isEmpty()) return emptyList()
        buffer.append(text)
        val lines = mutableListOf<String>()
        var start = 0
        for (i in buffer.indices) {
            if (buffer[i] == '\n') {
                lines.add(buffer.substring(start, i).trimEnd('\r'))
                start = i + 1
            }
        }
        // Keep the partial after the last newline (the whole buffer when no newline has
        // arrived yet) — dropping it would lose the first fragment of every frame.
        val remainder = buffer.substring(start)
        buffer.setLength(0)
        buffer.append(remainder)
        if (buffer.length > maxLineBytes) {
            // A peer that never terminates a line must not grow our memory without bound.
            corrupted = true
            buffer.setLength(0)
            throw IllegalStateException("stdout line exceeded $maxLineBytes bytes without a newline")
        }
        return lines
    }
}
