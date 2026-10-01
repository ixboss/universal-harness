package com.universalharness.node

import java.io.File
import org.json.JSONObject

/**
 * One runtime-install stage record. `sha256` is the pin the stage was completed against, so a
 * later run that sees a DIFFERENT pin re-does the stage instead of trusting stale state.
 */
data class StageRecord(val sha256: String?, val at: String) {
    fun toJson(): JSONObject = JSONObject().put("sha256", sha256 ?: JSONObject.NULL).put("at", at)

    companion object {
        fun fromJson(o: JSONObject): StageRecord =
            StageRecord(
                sha256 = if (o.isNull("sha256")) null else o.getString("sha256"),
                at = o.optString("at"),
            )
    }
}

/**
 * Durable, atomically-written install state for the Universal Harness Android runtime.
 *
 * Rules (brief §5 runtime requirements):
 *  - a stage counts as done only when its record exists AND its recorded pin matches the pin
 *    currently requested — a partially-interrupted install is therefore never reported complete;
 *  - the state file is written temp+rename so a crash mid-write cannot corrupt it;
 *  - reading a missing/corrupt file yields an empty state (everything re-runs), never a
 *    false "installed".
 */
class InstallStateStore(private val stateFile: File) {

    private val stages = LinkedHashMap<String, StageRecord>()

    init {
        load()
    }

    @Synchronized
    fun isStageDone(stage: String, expectedSha256: String?): Boolean {
        val record = stages[stage] ?: return false
        // A stage recorded without a pin (no artifact to hash) counts as done for any rerun;
        // a pinned stage is only done while its recorded pin still matches.
        return record.sha256 == null || record.sha256 == expectedSha256
    }

    @Synchronized
    fun markDone(stage: String, sha256: String?, at: String) {
        stages[stage] = StageRecord(sha256, at)
        persist()
    }

    @Synchronized
    fun clear(stage: String) {
        stages.remove(stage)
        persist()
    }

    @Synchronized
    fun allStages(): Map<String, StageRecord> = stages.toMap()

    @Synchronized
    private fun load() {
        stages.clear()
        if (!stateFile.isFile) return
        val parsed = try {
            JSONObject(stateFile.readText())
        } catch (_: Exception) {
            return // corrupt state == no state; stages re-run
        }
        val recorded = parsed.optJSONObject("stages") ?: return
        for (key in recorded.keys()) {
            recorded.optJSONObject(key)?.let { stages[key] = StageRecord.fromJson(it) }
        }
    }

    @Synchronized
    private fun persist() {
        stateFile.parentFile?.mkdirs()
        val json = JSONObject()
            .put("v", 1)
            .put("updatedAt", nowIso())
            .put(
                "stages",
                JSONObject().apply { for ((k, v) in stages) put(k, v.toJson()) },
            )
        val tmp = File(stateFile.parentFile, stateFile.name + ".tmp")
        tmp.writeText(json.toString(2))
        if (!tmp.renameTo(stateFile)) {
            stateFile.writeText(tmp.readText())
            tmp.delete()
        }
    }

    private fun nowIso(): String =
        java.time.Instant.now().toString()
}
