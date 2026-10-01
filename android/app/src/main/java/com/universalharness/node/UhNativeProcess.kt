package com.universalharness.node

import android.os.ParcelFileDescriptor
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.util.concurrent.TimeUnit

/**
 * Kotlin side of the `uhspawn` JNI bridge (app/src/main/cpp/uh_spawn.c).
 *
 * Why a new bridge exists alongside Mobile-Harness's pocketspawn: pocketspawn merges
 * stdout and stderr into a single output file (or a PTY). The dsh SDK seam is a clean
 * NDJSON protocol on stdout; stderr must be captured separately or it can interleave with
 * protocol frames. uh_spawn forks with three pipes (stdin write-end returned to the JVM,
 * stdout and stderr read-ends returned to the JVM), puts the child in its own process
 * group (setpgid in child and parent) so teardown can signal the whole tree, and reuses
 * pocketspawn's proven kill/wait semantics (group-first signal, waitpid, 128+n exit codes).
 */
class UhNativeProcess private constructor(
    private val pid: Int,
    stdinFd: Int,
    stdoutFd: Int,
    stderrFd: Int,
) : Process() {
    private val stdin: OutputStream =
        ParcelFileDescriptor.AutoCloseOutputStream(ParcelFileDescriptor.adoptFd(stdinFd))
    private val stdout: InputStream =
        ParcelFileDescriptor.AutoCloseInputStream(ParcelFileDescriptor.adoptFd(stdoutFd))
    private val stderr: InputStream =
        ParcelFileDescriptor.AutoCloseInputStream(ParcelFileDescriptor.adoptFd(stderrFd))

    @Volatile private var result: Int? = null

    fun stdinStream(): OutputStream = stdin
    fun stdoutStream(): InputStream = stdout
    fun stderrStream(): InputStream = stderr

    val processId: Int get() = pid

    override fun getOutputStream(): OutputStream = stdin
    override fun getInputStream(): InputStream = stdout
    override fun getErrorStream(): InputStream = stderr

    override fun waitFor(): Int {
        result?.let { return it }
        return UhNativeSpawn.waitFor(pid, false).also { result = it }
    }

    fun waitFor(timeoutMs: Long): Int {
        result?.let { return it }
        val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs)
        while (System.nanoTime() < deadline) {
            val status = UhNativeSpawn.waitFor(pid, true)
            if (status != STILL_RUNNING) {
                result = status
                return status
            }
            Thread.sleep(20)
        }
        return STILL_RUNNING
    }

    override fun exitValue(): Int {
        result?.let { return it }
        val status = UhNativeSpawn.waitFor(pid, true)
        if (status == STILL_RUNNING) throw IllegalThreadStateException("process is still running")
        result = status
        return status
    }

    /** Group-first SIGTERM, exactly like pocketspawn.destroy(). */
    override fun destroy() {
        UhNativeSpawn.kill(pid, 15)
    }

    /** Group-first SIGINT (Ctrl+C equivalent). */
    fun interrupt() {
        UhNativeSpawn.kill(pid, 2)
    }

    override fun destroyForcibly(): Process {
        UhNativeSpawn.kill(pid, 9)
        return this
    }

    override fun isAlive(): Boolean = runCatching { exitValue(); false }.getOrDefault(true)

    companion object {
        const val STILL_RUNNING = -2

        fun start(
            argv: List<String>,
            environment: Map<String, String>,
            cwd: String,
        ): UhNativeProcess {
            require(argv.isNotEmpty()) { "argv is empty" }
            val spawned = UhNativeSpawn.spawn(
                argv.toTypedArray(),
                environment.map { "${it.key}=${it.value}" }.toTypedArray(),
                cwd,
            )
            check(spawned.size == 4 && spawned[0] > 0) { "native launch failed: ${spawned.contentToString()}" }
            return UhNativeProcess(spawned[0], spawned[1], spawned[2], spawned[3])
        }
    }
}

private object UhNativeSpawn {
    init {
        System.loadLibrary("uhspawn")
    }

    external fun spawn(argv: Array<String>, environment: Array<String>, cwd: String): IntArray
    external fun waitFor(pid: Int, noHang: Boolean): Int
    external fun kill(pid: Int, signal: Int): Int
}
