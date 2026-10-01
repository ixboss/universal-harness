/*
 * Universal Harness native spawn bridge (uhspawn JNI library).
 *
 * New Universal Harness code (com.universalharness.node) — written for Phase 3A, not part of
 * the Mobile-Harness import. It mirrors pocketspawn's proven process-group semantics
 * (fork/execve, setpgid in child AND parent, group-first kill, waitpid, 128+n signal exit
 * codes, PR_SET_DUMPABLE so PRoot may ptrace its tracee) but exposes THREE separate pipes
 * (stdin write-end, stdout read-end, stderr read-end) because the dsh SDK seam is an NDJSON
 * protocol on stdout and stderr must never interleave with protocol frames.
 *
 * SPDX-License-Identifier: MIT
 */
#include <jni.h>
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

static jint throw_io_exception(JNIEnv *env, const char *message) {
    jclass cls = (*env)->FindClass(env, "java/io/IOException");
    if (cls == NULL) return -1;
    return (*env)->ThrowNew(env, cls, message);
}

/*
 * Returns jintArray = [pid, stdinWriteFd, stdoutReadFd, stderrReadFd].
 * The child dies if the parent dies (PR_SET_PDEATHSIG) so an app crash cannot leave
 * an orphaned PRoot tree running unmanaged.
 */
JNIEXPORT jintArray JNICALL
Java_com_universalharness_node_UhNativeSpawn_spawn(
        JNIEnv *env, jobject thiz, jobjectArray argv, jobjectArray environment,
        jstring cwd) {
    (void) thiz;
    jsize argc = (*env)->GetArrayLength(env, argv);
    jsize envc = (*env)->GetArrayLength(env, environment);
    if (argc < 1) {
        throw_io_exception(env, "argv must not be empty");
        return NULL;
    }
    const char *cwdUtf = (*env)->GetStringUTFChars(env, cwd, NULL);
    if (cwdUtf == NULL) return NULL;

    char **argvNative = malloc(sizeof(char *) * (argc + 1));
    char **envpNative = malloc(sizeof(char *) * (envc + 1));
    if (argvNative == NULL || envpNative == NULL) {
        free(argvNative); free(envpNative);
        (*env)->ReleaseStringUTFChars(env, cwd, cwdUtf);
        throw_io_exception(env, "out of memory");
        return NULL;
    }
    for (int i = 0; i < argc; i++) {
        jstring s = (jstring) (*env)->GetObjectArrayElement(env, argv, i);
        const char *utf = (*env)->GetStringUTFChars(env, s, NULL);
        argvNative[i] = strdup(utf);
        (*env)->ReleaseStringUTFChars(env, s, utf);
        (*env)->DeleteLocalRef(env, s);
        if (argvNative[i] == NULL) argc = i; /* stop on OOM */
    }
    argvNative[argc] = NULL;
    for (int i = 0; i < envc; i++) {
        jstring s = (jstring) (*env)->GetObjectArrayElement(env, environment, i);
        const char *utf = (*env)->GetStringUTFChars(env, s, NULL);
        envpNative[i] = strdup(utf);
        (*env)->ReleaseStringUTFChars(env, s, utf);
        (*env)->DeleteLocalRef(env, s);
        if (envpNative[i] == NULL) envc = i;
    }
    envpNative[envc] = NULL;

    int stdinPipe[2] = {-1, -1};
    int stdoutPipe[2] = {-1, -1};
    int stderrPipe[2] = {-1, -1};
    if (pipe(stdinPipe) != 0 || pipe(stdoutPipe) != 0 || pipe(stderrPipe) != 0) {
        throw_io_exception(env, "pipe() failed");
        goto cleanup;
    }

    pid_t pid = fork();
    if (pid < 0) {
        throw_io_exception(env, "fork() failed");
        goto cleanup;
    }
    if (pid == 0) {
        /* child */
        setpgid(0, 0);
        prctl(PR_SET_PDEATHSIG, SIGKILL);
        prctl(PR_SET_DUMPABLE, 1); /* allow PRoot to ptrace its tracee */
        close(stdinPipe[1]);
        close(stdoutPipe[0]);
        close(stderrPipe[0]);
        dup2(stdinPipe[0], STDIN_FILENO);
        dup2(stdoutPipe[1], STDOUT_FILENO);
        dup2(stderrPipe[1], STDERR_FILENO);
        close(stdinPipe[0]);
        close(stdoutPipe[1]);
        close(stderrPipe[1]);
        if (chdir(cwdUtf) != 0) _exit(126); /* caller cwd does not exist in guest */
        execve(argvNative[0], argvNative, envpNative);
        _exit(127); /* exec failed */
    }

    /* parent */
    setpgid(pid, pid);
    close(stdinPipe[0]);
    close(stdoutPipe[1]);
    close(stderrPipe[1]);

    jintArray result = (*env)->NewIntArray(env, 4);
    jint values[4];
    values[0] = (jint) pid;
    values[1] = (jint) stdinPipe[1];
    values[2] = (jint) stdoutPipe[0];
    values[3] = (jint) stderrPipe[0];
    (*env)->SetIntArrayRegion(env, result, 0, 4, values);

    for (int i = 0; i < argc; i++) free(argvNative[i]);
    for (int i = 0; i < envc; i++) free(envpNative[i]);
    free(argvNative);
    free(envpNative);
    (*env)->ReleaseStringUTFChars(env, cwd, cwdUtf);
    return result;

cleanup:
    if (stdinPipe[0] >= 0) close(stdinPipe[0]);
    if (stdinPipe[1] >= 0) close(stdinPipe[1]);
    if (stdoutPipe[0] >= 0) close(stdoutPipe[0]);
    if (stdoutPipe[1] >= 0) close(stdoutPipe[1]);
    if (stderrPipe[0] >= 0) close(stderrPipe[0]);
    if (stderrPipe[1] >= 0) close(stderrPipe[1]);
    for (int i = 0; i < argc; i++) free(argvNative[i]);
    for (int i = 0; i < envc; i++) free(envpNative[i]);
    free(argvNative);
    free(envpNative);
    (*env)->ReleaseStringUTFChars(env, cwd, cwdUtf);
    return NULL;
}

JNIEXPORT jint JNICALL
Java_com_universalharness_node_UhNativeSpawn_waitFor(
        JNIEnv *env, jobject thiz, jint pid, jboolean noHang) {
    (void) env; (void) thiz;
    int status = 0;
    pid_t r;
    do {
        r = waitpid((pid_t) pid, &status, noHang ? WNOHANG : 0);
    } while (r < 0 && errno == EINTR);
    if (r == 0) return -2; /* STILL_RUNNING */
    if (r < 0) return -3;  /* waitpid error (already reaped -> ECHILD) */
    if (WIFEXITED(status)) return WEXITSTATUS(status);
    if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
    return -4;
}

JNIEXPORT jint JNICALL
Java_com_universalharness_node_UhNativeSpawn_kill(
        JNIEnv *env, jobject thiz, jint pid, jint signal) {
    (void) env; (void) thiz;
    int result = kill((pid_t) -pid, signal); /* signal the whole process group first */
    if (result != 0 && errno == ESRCH) result = kill((pid_t) pid, signal);
    return (jint) result;
}
