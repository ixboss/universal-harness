package com.universalharness.node

import java.io.File
import org.json.JSONObject

/**
 * Restart reconciliation for guest runtime sessions (the Android counterpart of the node
 * server's recover(), ADR-005: a supervisor reconciles process liveness against task records
 * on every start and restart — a dead process must never be reported as running).
 *
 * When a dsh SDK session starts, the client records `{state: "running", pid, startedAt}`.
 * On app restart the OS has killed every guest process (PR_SET_PDEATHSIG also guarantees the
 * guest dies with its parent), so [reconcile] rewrites any "running" record to
 * `{state: "reconciled-after-restart"}`; it never trusts the pid as still alive.
 */
class RuntimeReconciler(private val stateFile: File) {

    data class SessionRecord(val state: String, val pid: Int?, val startedAt: String?, val reconciledAt: String?)

    fun markRunning(pid: Int, startedAt: String) {
        persist(
            JSONObject()
                .put("state", "running")
                .put("pid", pid)
                .put("startedAt", startedAt),
        )
    }

    fun markStopped() {
        persist(JSONObject().put("state", "stopped").put("updatedAt", now()))
    }

    /**
     * Called at app start BEFORE any session can start. Returns the previous record for
     * diagnostics; after this call the state file never claims a running session.
     */
    fun reconcile(): SessionRecord? {
        val previous = read()
        if (previous?.state == "running") {
            persist(
                JSONObject()
                    .put("state", "reconciled-after-restart")
                    .put("previousState", "running")
                    .put("pid", previous.pid ?: JSONObject.NULL)
                    .put("reconciledAt", now()),
            )
            return read()
        }
        return previous
    }

    fun current(): SessionRecord? = read()

    private fun read(): SessionRecord? {
        if (!stateFile.isFile) return null
        val o = try {
            JSONObject(stateFile.readText())
        } catch (_: Exception) {
            return null
        }
        return SessionRecord(
            state = o.optString("state"),
            pid = if (o.has("pid") && !o.isNull("pid")) o.optInt("pid") else null,
            startedAt = o.optString("startedAt").takeIf { it.isNotEmpty() },
            reconciledAt = o.optString("reconciledAt").takeIf { it.isNotEmpty() },
        )
    }

    private fun persist(json: JSONObject) {
        stateFile.parentFile?.mkdirs()
        val tmp = File(stateFile.parentFile, stateFile.name + ".tmp")
        tmp.writeText(json.toString(2))
        if (!tmp.renameTo(stateFile)) {
            stateFile.writeText(tmp.readText())
            tmp.delete()
        }
    }

    private fun now(): String = java.time.Instant.now().toString()
}
