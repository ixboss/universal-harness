package com.universalharness.node

import android.content.Context

/**
 * Composition root for the Universal Harness Android node runtime. Builds the object graph
 * once (the same role core/cli/serve.mjs plays on desktop); no protocol, pairing, or network
 * feature exists in Phase 3A by design.
 */
object UhNode {
    fun create(context: Context): UhNodeRuntime {
        val paths = UhPaths(context.filesDir, context.cacheDir)
        val prootCommand = UhPRootCommand(paths, context.applicationInfo.nativeLibraryDir)
        val installer = UhRuntimeInstaller(paths, prootCommand)
        val reconciler = RuntimeReconciler(paths.runtimeStateFile)
        val checks = UhRuntimeChecks(paths, prootCommand, installer)
            .withNativeLibraryDir(context.applicationInfo.nativeLibraryDir)
        return UhNodeRuntime(paths, prootCommand, installer, reconciler, checks)
    }
}

class UhNodeRuntime(
    val paths: UhPaths,
    val prootCommand: UhPRootCommand,
    val installer: UhRuntimeInstaller,
    val reconciler: RuntimeReconciler,
    val checks: UhRuntimeChecks,
) {
    /**
     * Called before anything starts a guest process: after an app restart no previous guest
     * can still be alive (Android killed the process tree), so any "running" record is
     * reconciled to its true outcome instead of being trusted.
     */
    fun reconcileAfterRestart(): RuntimeReconciler.SessionRecord? = reconciler.reconcile()
}
