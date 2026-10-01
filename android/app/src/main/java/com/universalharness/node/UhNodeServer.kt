package com.universalharness.node

import android.content.Context
import java.io.File
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.delay

/**
 * Phase 3B: owns the Universal Harness node server as a guest process.
 *
 * The node server is the same JS that runs on desktop (`uh serve`), executed by the bundled guest
 * Node under PRoot, with the staged tree bind-mounted at /opt/universal-harness. It binds a TLS
 * listener; PRoot passes socket syscalls to the host kernel, so the listener is reachable on the
 * device's own network namespace — i.e. on the LAN, and over ADB.
 *
 * The class is deliberately transport-agnostic about *who* connects; it exposes the announced
 * endpoint and mints pairing payloads, and the foreground service ([NodeServerService]) keeps the
 * process alive and advertises it over NSD.
 *
 * Nothing here weakens any protocol check: this layer only launches and observes.
 */
class UhNodeServer(
    private val context: Context,
    private val paths: UhPaths,
    private val prootCommand: UhPRootCommand,
    private val jsStage: UhJsStage,
    /** TCP port to bind; 0 lets the node choose an ephemeral one (read from the announcement). */
    private val port: Int = DEFAULT_PORT,
    private val log: (String) -> Unit = {},
) {
    enum class State { STOPPED, STARTING, RUNNING, FAILED }

    private val processRef = AtomicReference<UhNativeProcess?>(null)
    @Volatile var state: State = State.STOPPED
        private set
    @Volatile var lastError: String? = null
        private set

    /** Host path of the announcement the guest writes once its listener is bound. */
    private val announcementHostPath: File
        get() = File(paths.rootfsDir, "root/.universal-harness/identity/node-endpoint.json")

    /**
     * Start the node server. Stages the JS, launches the guest process, and waits for the
     * endpoint announcement. Returns the announced endpoint.
     */
    suspend fun start(awaitEndpointMs: Long = DEFAULT_AWAIT_MS): NodeEndpoint {
        check(state != State.RUNNING) { "node server is already running" }
        state = State.STARTING
        lastError = null
        try {
            val staged = jsStage.stageIfNeeded()
            log("staged js node: ${staged.fileCount} files (changed=${staged.changed})")

            // A stale announcement from a previous run must not be mistaken for this one's.
            announcementHostPath.delete()

            val command = prootCommand.build(
                guestCommand = listOf(
                    paths.guestNodePath,
                    jsStage.guestEntryPoint,
                    "serve",
                    "--listen", "tls://0.0.0.0:$port",
                    "--platform", "android",
                    "--arch", "arm64",
                    "--node-kind", "android",
                ),
                environment = mapOf(
                    "UH_ROOT" to jsStage.guestMount,
                    "UH_LOG_LEVEL" to "info",
                ),
                extraBinds = listOf(staged.staged.absolutePath to jsStage.guestMount),
            )
            val process = UhNativeProcess.start(command.argv, command.environment, command.cwd)
            processRef.set(process)
            log("launched node server pid=${process.processId}")

            val endpoint = awaitEndpoint(process, awaitEndpointMs)
            state = State.RUNNING
            log("node ${endpoint.nodeId} listening on ${endpoint.host}:${endpoint.port}")
            return endpoint
        } catch (e: Throwable) {
            state = State.FAILED
            lastError = e.message ?: e.javaClass.simpleName
            log("node server failed to start: $lastError")
            throw e
        }
    }

    /** Poll the guest announcement until the node reports its bound endpoint. */
    private suspend fun awaitEndpoint(process: UhNativeProcess, timeoutMs: Long): NodeEndpoint {
        val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs)
        while (System.nanoTime() < deadline) {
            val exit = process.waitFor(200)
            if (exit != UhNativeProcess.STILL_RUNNING) {
                throw IllegalStateException("node server exited early (code $exit): ${captureStderr(process)}")
            }
            NodeEndpoint.readFrom(paths.rootfsDir)?.let { return it }
            delay(150)
        }
        throw IllegalStateException(
            "node server did not announce its endpoint within ${timeoutMs}ms (stderr: ${captureStderr(process)})"
        )
    }

    private fun captureStderr(process: UhNativeProcess): String =
        runCatching {
            val stream = process.stderrStream()
            val out = StringBuilder()
            val buf = ByteArray(4096)
            while (stream.available() > 0) {
                val n = stream.read(buf)
                if (n <= 0) break
                out.append(String(buf, 0, n))
            }
            out.toString().trim().take(400)
        }.getOrDefault("(unavailable)")

    /**
     * Mint a single-use pairing payload for this node, by running `uh pair` in the guest against
     * the running endpoint. This is the exact CLI a desktop operator runs; no second minting path
     * exists, so the token's binding rules cannot drift between platforms.
     */
    suspend fun mintPairingPayload(endpoint: NodeEndpoint, lanAddress: String): PairingPayload {
        check(state == State.RUNNING) { "the node must be running to mint a pairing payload" }
        return mintPairingPayloadFor(paths, prootCommand, jsStage, endpoint, lanAddress)
    }

    /** The currently announced endpoint, or null if the node has not bound (or has exited). */
    fun currentEndpoint(): NodeEndpoint? = NodeEndpoint.readFrom(paths.rootfsDir)

    /** True while the guest process is alive. */
    fun isAlive(): Boolean = processRef.get()?.isAlive == true

    /**
     * Stop the node: SIGTERM so the guest removes its announcement and closes its listener, then
     * a bounded wait, then a group kill. Idempotent.
     */
    fun stop() {
        val process = processRef.getAndSet(null) ?: return
        runCatching { process.destroy() }
        val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(STOP_GRACE_MS)
        while (System.nanoTime() < deadline) {
            if (process.waitFor(100) != UhNativeProcess.STILL_RUNNING) break
        }
        if (process.waitFor(0) == UhNativeProcess.STILL_RUNNING) {
            runCatching { process.destroyForcibly() }
        }
        runCatching { announcementHostPath.delete() }
        state = State.STOPPED
        log("node server stopped")
    }

    companion object {
        /** The node's well-known TCP port; chosen so a controller can reach a known address. */
        const val DEFAULT_PORT = 7437
        private const val DEFAULT_AWAIT_MS = 60_000L
        private const val STOP_GRACE_MS = 8_000L

        /**
         * Mint a pairing payload by running `uh pair` in the guest against a running endpoint.
         * Standalone (no [UhNodeServer] instance required) so a supervisor that started the node
         * through [NodeServerService] — in another component, possibly another process — can
         * still mint through the exact same CLI path.
         */
        suspend fun mintPairingPayloadFor(
            paths: UhPaths,
            prootCommand: UhPRootCommand,
            jsStage: UhJsStage,
            endpoint: NodeEndpoint,
            lanAddress: String,
        ): PairingPayload {
            val command = prootCommand.build(
                guestCommand = listOf(
                    paths.guestNodePath,
                    jsStage.guestEntryPoint,
                    "pair",
                    "--endpoint",
                    endpoint.endpoint(lanAddress),
                ),
                environment = mapOf("UH_ROOT" to jsStage.guestMount),
                extraBinds = listOf(jsStage.stagedDir.absolutePath to jsStage.guestMount),
            )
            val process = UhNativeProcess.start(command.argv, command.environment, command.cwd)
            val stdout = StringBuilder()
            val buf = ByteArray(4096)
            val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(DEFAULT_AWAIT_MS)
            val stream = process.stdoutStream()
            while (System.nanoTime() < deadline) {
                if (stream.available() > 0) {
                    val n = stream.read(buf)
                    if (n > 0) stdout.append(String(buf, 0, n))
                }
                val exit = process.waitFor(100)
                if (exit != UhNativeProcess.STILL_RUNNING) {
                    stream.readBytes().forEach { stdout.append(it.toInt().toChar()) }
                    if (exit != 0) throw IllegalStateException("uh pair exited $exit: ${captureStderrOf(process)}")
                    break
                }
            }
            val text = stdout.toString().trim()
            // `uh pair` pretty-prints the payload across several lines; the object runs from the
            // first '{' to the end of the output (nothing is printed after it).
            val jsonStart = text.indexOf('{')
            if (jsonStart < 0) {
                throw IllegalStateException("uh pair produced no JSON payload: ${text.take(300)}")
            }
            return PairingPayload.parse(text.substring(jsonStart))
        }

        private fun captureStderrOf(process: UhNativeProcess): String =
            runCatching {
                val stream = process.stderrStream()
                val out = StringBuilder()
                val buf = ByteArray(4096)
                while (stream.available() > 0) {
                    val n = stream.read(buf)
                    if (n <= 0) break
                    out.append(String(buf, 0, n))
                }
                out.toString().trim().take(400)
            }.getOrDefault("(unavailable)")
    }
}
