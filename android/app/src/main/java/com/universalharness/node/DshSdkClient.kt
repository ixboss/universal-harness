package com.universalharness.node

import java.io.BufferedReader
import java.io.InputStream
import java.io.InputStreamReader
import java.io.OutputStream
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONObject

/**
 * Seam between the dsh SDK process and Universal Harness. Abstracted so JVM unit tests can
 * exercise the full lifecycle (initialize, prompt events, shutdown escalation, cancellation)
 * against a fake process without native code or PRoot.
 */
interface UhProcessHandle {
    fun stdin(): OutputStream
    fun stdout(): InputStream
    fun stderr(): InputStream

    /** @return exit status (128+n for signals) or [UhNativeProcess.STILL_RUNNING]. */
    fun waitForNoHang(): Int
    fun waitFor(timeoutMs: Long): Int
    fun terminate()
    fun kill()
    val pid: Int
}

class UhProcessHandleImpl(private val process: UhNativeProcess) : UhProcessHandle {
    override fun stdin(): OutputStream = process.stdinStream()
    override fun stdout(): InputStream = process.stdoutStream()
    override fun stderr(): InputStream = process.stderrStream()
    override fun waitForNoHang(): Int = try {
        process.exitValue()
    } catch (_: IllegalThreadStateException) {
        UhNativeProcess.STILL_RUNNING
    }
    override fun waitFor(timeoutMs: Long): Int = process.waitFor(timeoutMs)
    override fun terminate() {
        process.destroy()
    }
    override fun kill() {
        process.destroyForcibly()
    }
    override val pid: Int get() = process.processId
}

/** Where the dsh SDK command comes from; [UhPRootCommand] is the real implementation. */
interface GuestCommandSource {
    /** True when the pinned guest runtime is installed and its entry points exist. */
    fun guestReady(): Boolean

    /** The full argv/env to spawn `dsh --profile sdk` inside PRoot. */
    fun buildDshSdkCommand(): UhPRootCommand.Command
}

/** Callbacks the host application receives while the SDK session runs. */
interface DshSessionListener {
    /** A dsh notification (session.event / session.status / subagent.*) arrived. */
    fun onNotification(method: String, params: JSONObject) {}
    /** A complete stdout line could not be parsed as protocol (stderr-adjacent noise). */
    fun onProtocolNoise(line: String) {}
    /** A complete stderr line arrived. */
    fun onStderr(line: String) {}
}

class DshSdkException(message: String) : Exception(message)

/**
 * One dsh SDK conversation: spawn `dsh --profile sdk` inside PRoot, speak NDJSON JSON-RPC on
 * stdin/stdout, keep stderr isolated, and tear down with the desktop adapter's bounded
 * escalation: graceful `shutdown` request (15s) -> SIGTERM (10s) -> SIGKILL (5s). Cancellation
 * skips the graceful step. Every stage is time-boxed; nothing hangs and nothing is swallowed
 * silently. Nothing in this class touches UI code.
 */
class DshSdkClient(
    private val guest: GuestCommandSource,
    private val processStarter: (UhPRootCommand.Command) -> UhProcessHandle = { cmd ->
        UhProcessHandleImpl(UhNativeProcess.start(cmd.argv, cmd.environment, cmd.cwd))
    },
    private val time: CoroutineDispatcher = Dispatchers.IO,
    private val shutdownRequestTimeoutMs: Long = SHUTDOWN_TIMEOUT_MS,
    private val terminateGraceMs: Long = TERMINATE_GRACE_MS,
    private val killGraceMs: Long = KILL_GRACE_MS,
) {
    companion object {
        const val STARTUP_TIMEOUT_MS = 60_000L
        const val INITIALIZE_TIMEOUT_MS = 120_000L
        const val SHUTDOWN_TIMEOUT_MS = 15_000L
        const val TERMINATE_GRACE_MS = 10_000L
        const val KILL_GRACE_MS = 5_000L
    }

    private val nextRequestId = AtomicInteger(0)
    private var process: UhProcessHandle? = null
    private var readerJob: Job? = null
    private val pending = ConcurrentHashMap<Int, CompletableDeferred<JSONObject>>()
    private val exited = AtomicInteger(0)
    @Volatile private var exitStatus: Int = -1
    private val stderrCaptured = mutableListOf<String>()

    val isRunning: Boolean get() = exited.get() == 0 && process != null
    val lastExitStatus: Int get() = exitStatus

    /** Spawn the guest process and start pumping streams. Fails loudly on any error. */
    suspend fun start(cwd: String = "/workspace", listener: DshSessionListener = object : DshSessionListener {}) {
        check(process == null) { "session already started" }
        if (!guest.guestReady()) {
            throw DshSdkException(
                "guest runtime is not installed (${UhPins.DSH_PACKAGE} ${UhPins.DSH_VERSION} missing); " +
                    "run the runtime installer first",
            )
        }
        val handle = processStarter(guest.buildDshSdkCommand())
        process = handle
        pumpStreams(handle, listener)
        startExitWatcher(handle)
    }

    /**
     * JSON-RPC initialize; a protocol error response is propagated as [DshSdkException].
     *
     * The provider default mirrors the desktop adapter (core/adapter/mod.mjs sends
     * 'deepseek-official' when no override is given). It is also the only provider the dsh SDK
     * server mounts automatically — any other (or absent) value makes the server reject the
     * handshake with `no adapter registered for provider "..."`. No credential is needed for
     * the handshake itself; resolveCallConfig only resolves model metadata. A real prompt
     * still requires a valid key, which is the separate provider-credential gate.
     */
    suspend fun initialize(
        cwd: String = "/workspace",
        provider: String = "deepseek-official",
        model: String = "deepseek-official",
    ): JSONObject =
        request("initialize", DshSdkProtocol.initializeParams(cwd, provider, model), INITIALIZE_TIMEOUT_MS)

    suspend fun prompt(sessionId: String, text: String, timeoutMs: Long = 0): JSONObject =
        request("session/prompt", DshSdkProtocol.promptParams(sessionId, text), timeoutMs)

    suspend fun request(method: String, params: JSONObject?, timeoutMs: Long): JSONObject {
        val handle = process ?: throw DshSdkException("session not started")
        if (exited.get() != 0) throw DshSdkException("process has exited (status $exitStatus)")
        val id = nextRequestId.incrementAndGet()
        val deferred = CompletableDeferred<JSONObject>()
        pending[id] = deferred
        try {
            val frame = DshSdkProtocol.request(method, id, params).toString()
            withTimeoutOrNull(5_000) {
                handle.stdin().write((frame + "\n").toByteArray(Charsets.UTF_8))
                handle.stdin().flush()
            } ?: throw DshSdkException("stdin write timed out; the guest pipe is stuck")
            val reply: JSONObject = if (timeoutMs > 0) {
                withTimeoutOrNull(timeoutMs) { deferred.await() }
                    ?: throw DshSdkException("$method timed out after ${timeoutMs}ms")
            } else {
                deferred.await()
            }
            if (DshSdkProtocol.isErrorResponse(reply)) {
                throw DshSdkException("$method failed: ${DshSdkProtocol.errorMessage(reply)}")
            }
            return reply.optJSONObject("result") ?: JSONObject()
        } finally {
            pending.remove(id)
        }
    }

    /** Bounded shutdown: graceful protocol shutdown, then SIGTERM to the group, then SIGKILL. */
    suspend fun shutdown(): Int {
        val handle = process ?: return -1
        if (exited.get() != 0) return exitStatus
        try {
            request("shutdown", null, shutdownRequestTimeoutMs)
        } catch (_: Exception) { /* the process may die before answering; that is fine */ }
        awaitExit(handle, terminateGraceMs) { handle.terminate() }?.let { return record(it) }
        awaitExit(handle, killGraceMs) { handle.kill() }?.let { return record(it) }
        throw DshSdkException("process survived SIGKILL after ${killGraceMs}ms")
    }

    /** Cancellation: no graceful step, straight to SIGTERM -> SIGKILL. */
    suspend fun cancel(): Int {
        val handle = process ?: return -1
        if (exited.get() != 0) return exitStatus
        awaitExit(handle, terminateGraceMs) { handle.terminate() }?.let { return record(it) }
        awaitExit(handle, killGraceMs) { handle.kill() }?.let { return record(it) }
        throw DshSdkException("cancelled process survived SIGKILL")
    }

    fun capturedStderr(): List<String> = synchronized(stderrCaptured) { stderrCaptured.toList() }

    private fun record(status: Int): Int {
        exitStatus = status
        exited.set(1)
        return status
    }

    private fun awaitExit(handle: UhProcessHandle, timeoutMs: Long, escalate: () -> Unit): Int? {
        val status = handle.waitFor(timeoutMs)
        if (status != UhNativeProcess.STILL_RUNNING) return status
        escalate()
        val after = handle.waitFor(timeoutMs)
        return if (after == UhNativeProcess.STILL_RUNNING) null else after
    }

    private fun pumpStreams(handle: UhProcessHandle, listener: DshSessionListener) {
        readerJob = CoroutineScope(time).launch {
            val framer = NdJsonFramer()
            val stdout = BufferedReader(InputStreamReader(handle.stdout(), Charsets.UTF_8))
            val stderr = BufferedReader(InputStreamReader(handle.stderr(), Charsets.UTF_8))
            val stderrJob = launch {
                stderr.forEachLine { line ->
                    synchronized(stderrCaptured) { stderrCaptured.add(line) }
                    listener.onStderr(line)
                }
            }
            try {
                stdout.forEachLine { line ->
                    for (candidate in framer.push(line + "\n")) {
                        val frame = DshSdkProtocol.parseLine(candidate)
                        if (frame == null) {
                            listener.onProtocolNoise(candidate)
                            continue
                        }
                        val id = frame.opt("id")
                        if (id is Int && pending.containsKey(id)) {
                            pending[id]?.complete(frame)
                        } else {
                            DshSdkProtocol.notificationMethod(frame)?.let { method ->
                                listener.onNotification(method, frame.optJSONObject("params") ?: JSONObject())
                            }
                        }
                    }
                }
            } catch (_: Exception) {
                // stream closed on exit; the exit watcher records the status
            } finally {
                stderrJob.cancel()
                for ((_, deferred) in pending) {
                    deferred.completeExceptionally(DshSdkException("process exited before replying"))
                }
            }
        }
    }

    private fun startExitWatcher(handle: UhProcessHandle) {
        CoroutineScope(time).launch {
            while (true) {
                val status = handle.waitForNoHang()
                if (status != UhNativeProcess.STILL_RUNNING) {
                    exitStatus = status
                    exited.set(1)
                    break
                }
                delay(200)
            }
        }
    }
}
