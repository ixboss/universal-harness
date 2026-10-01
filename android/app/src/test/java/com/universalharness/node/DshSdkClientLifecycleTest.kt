package com.universalharness.node

import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.io.PipedInputStream
import java.io.PipedOutputStream
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.json.JSONObject

/**
 * Full lifecycle of the dsh SDK client against a fake process handle: no native code, no
 * PRoot, but the real client logic (framing, correlation, bounded teardown, cancellation).
 */
class DshSdkClientLifecycleTest {
    private class FakeGuest : GuestCommandSource {
        override fun guestReady(): Boolean = true
        override fun buildDshSdkCommand(): UhPRootCommand.Command =
            UhPRootCommand.Command(listOf("/fake/dsh", "--profile", "sdk"), emptyMap(), "/workspace")
    }

    private class FakeProcess : UhProcessHandle {
        val stdin = ByteArrayOutputStream()
        val stdoutTo = PipedOutputStream()
        val stdoutIn = PipedInputStream(stdoutTo, 65_536)
        val stderrTo = PipedOutputStream()
        val stderrIn = PipedInputStream(stderrTo, 65_536)
        @Volatile private var exitCode: Int? = null
        @Volatile var terminated = false
        @Volatile var killed = false

        override fun stdin(): OutputStream = stdin
        override fun stdout(): InputStream = stdoutIn
        override fun stderr(): InputStream = stderrIn
        override fun waitForNoHang(): Int = exitCode ?: UhNativeProcess.STILL_RUNNING
        override fun waitFor(timeoutMs: Long): Int {
            val deadline = System.currentTimeMillis() + timeoutMs
            while (exitCode == null && System.currentTimeMillis() < deadline) Thread.sleep(5)
            return exitCode ?: UhNativeProcess.STILL_RUNNING
        }
        override fun terminate() {
            terminated = true
            exitCode = 128 + 15
            closeStreams()
        }
        override fun kill() {
            killed = true
            exitCode = 128 + 9
            closeStreams()
        }
        override val pid: Int = 4242

        @Volatile private var streamsClosed = false
        private fun closeStreams() {
            if (streamsClosed) return
            streamsClosed = true
            runCatching { stdoutTo.close() }
            runCatching { stderrTo.close() }
        }

        fun feed(line: String) {
            stdoutTo.write((line + "\n").toByteArray())
            stdoutTo.flush()
        }
    }

    private val process = FakeProcess()

    private fun client(vararg timeouts: Long): DshSdkClient =
        DshSdkClient(
            FakeGuest(),
            processStarter = { process },
            time = kotlinx.coroutines.Dispatchers.Default,
            shutdownRequestTimeoutMs = timeouts.getOrElse(0) { 500 },
            terminateGraceMs = timeouts.getOrElse(1) { 500 },
            killGraceMs = timeouts.getOrElse(2) { 500 },
        )

    @AfterTest
    fun cleanup() {
        runCatching { process.stdoutTo.close() }
        runCatching { process.stderrTo.close() }
    }

    private fun awaitStdinRequest(): JSONObject {
        val deadline = System.currentTimeMillis() + 5_000
        while (System.currentTimeMillis() < deadline) {
            val text = process.stdin.toString("UTF-8")
            val newline = text.indexOf('\n')
            if (newline >= 0) return JSONObject(text.substring(0, newline))
            Thread.sleep(5)
        }
        throw AssertionError("no request frame arrived on stdin")
    }

    @Test
    fun `initialize round-trips and returns the result object`() = runBlocking {
        val c = client()
        c.start()
        val responses = launch {
            val request = awaitStdinRequest()
            assertEquals("initialize", request.getString("method"))
            assertEquals("/workspace", request.getJSONObject("params").getString("cwd"))
            process.feed(JSONObject().put("id", request.getInt("id")).put("result", JSONObject().put("protocolVersion", 4)).toString())
        }
        val result = c.initialize()
        responses.join()
        assertEquals(4, result.getInt("protocolVersion"))
        assertTrue(c.isRunning)
    }

    @Test
    fun `protocol error responses are propagated as exceptions`() = runBlocking {
        val c = client()
        c.start()
        val responses = launch {
            val request = awaitStdinRequest()
            process.feed(
                JSONObject().put("id", request.getInt("id"))
                    .put("error", JSONObject().put("message", "unsupported profile")).toString(),
            )
        }
        assertFailsWith<DshSdkException> { c.initialize() }.let {
            assertTrue(it.message!!.contains("unsupported profile"))
        }
        responses.join()
    }

    @Test
    fun `notifications reach the listener and noise is tolerated`() = runBlocking {
        val c = client()
        val events = mutableListOf<Pair<String, JSONObject>>()
        val noise = mutableListOf<String>()
        c.start(listener = object : DshSessionListener {
            override fun onNotification(method: String, params: JSONObject) { events.add(method to params) }
            override fun onProtocolNoise(line: String) { noise.add(line) }
        })
        process.feed("this is not json")
        process.feed(
            JSONObject().put("method", "session.event")
                .put("params", JSONObject().put("event", JSONObject().put("type", "message"))).toString(),
        )
        kotlinx.coroutines.delay(200)
        assertEquals(listOf("session.event"), events.map { it.first })
        assertEquals(listOf("this is not json"), noise)
    }

    @Test
    fun `shutdown escalates gracefully when no reply arrives`() = runBlocking {
        val c = client(300, 400, 400)
        c.start()
        // No response is ever fed: the graceful request times out, then SIGTERM lands.
        val status = c.shutdown()
        assertTrue(process.terminated, "SIGTERM must have been sent to the group")
        assertFalse(process.killed, "SIGKILL must not fire when SIGTERM succeeds")
        assertEquals(128 + 15, status)
    }

    @Test
    fun `cancellation skips the graceful step`() = runBlocking {
        val c = client(300, 300, 300)
        c.start()
        val status = c.cancel()
        assertTrue(process.terminated)
        assertFalse(process.killed)
        assertEquals(128 + 15, status)
        assertFalse(c.isRunning)
        assertEquals(128 + 15, c.lastExitStatus)
    }

    @Test
    fun `a process that ignores SIGTERM is SIGKILLed`() = runBlocking {
        val stubborn = object : UhProcessHandle by process {
            override fun terminate() { /* ignores SIGTERM, stays alive */ }
            override fun kill() { process.kill() }
        }
        val c = DshSdkClient(
            FakeGuest(),
            processStarter = { stubborn },
            time = kotlinx.coroutines.Dispatchers.Default,
            shutdownRequestTimeoutMs = 200,
            terminateGraceMs = 200,
            killGraceMs = 500,
        )
        c.start()
        val status = c.shutdown()
        assertEquals(128 + 9, status, "SIGKILL must be the observed end for a SIGTERM-ignoring process")
    }

    @Test
    fun `a start against a missing guest fails loudly`() = runBlocking {
        val missing = object : GuestCommandSource {
            override fun guestReady() = false
            override fun buildDshSdkCommand() = UhPRootCommand.Command(emptyList(), emptyMap(), "/")
        }
        assertFailsWith<DshSdkException> {
            DshSdkClient(missing).start()
        }
        Unit
    }
}
