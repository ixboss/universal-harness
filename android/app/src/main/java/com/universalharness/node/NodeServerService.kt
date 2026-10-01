package com.universalharness.node

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.IBinder
import androidx.core.app.NotificationCompat
import com.jarves.mh.R
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * Phase 3B: the Android node foreground service.
 *
 * It owns one [UhNodeServer] for the lifetime of the process: it stages the JS node, launches the
 * guest node server, advertises it over NSD, and keeps both alive. Android may kill a background
 * process at any time; running as a foreground service with a wakelock is what makes the node's
 * TLS listener and its running tasks durable (brief §15: the node is authoritative and survives a
 * controller disconnect — and as far as the OS allows, an app backgrounding too).
 *
 * The service publishes nothing sensitive. The notification shows the endpoint; the pairing payload
 * is minted on demand by the UI through [currentEndpoint]/[mintPairing], never broadcast.
 */
class NodeServerService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var serverJob: Job? = null
    @Volatile private var server: UhNodeServer? = null
    @Volatile private var advertisement: NsdNodeAdvertisement? = null
    @Volatile private var endpoint: NodeEndpoint? = null

    override fun onCreate() {
        super.onCreate()
        ensureNodeChannel(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action ?: ACTION_START) {
            ACTION_START -> startNode()
            ACTION_STOP -> {
                stopNode()
                stopSelf()
            }
        }
        return START_STICKY
    }

    private fun startNode() {
        if (serverJob?.isActive == true) return
        startForeground(NODE_NOTIFICATION_ID, nodeNotification("Starting Universal Harness node…"))
        serverJob = scope.launch {
            val runtime = UhNode.create(this@NodeServerService)
            val jsStage = UhJsStage(this@NodeServerService, runtime.paths)
            val node = UhNodeServer(
                context = this@NodeServerService,
                paths = runtime.paths,
                prootCommand = runtime.prootCommand,
                jsStage = jsStage,
            ) { line -> android.util.Log.i(TAG, "node: $line") }
            server = node
            try {
                val ep = node.start()
                endpoint = ep
                val nsd = NsdNodeAdvertisement(this@NodeServerService)
                nsd.register(NsdNodeAdvertisement.serviceName(ep.nodeId), ep.port)
                advertisement = nsd
                notify("Universal Harness node ready", "Listening on :${ep.port} • ${ep.nodeId.take(14)}…")
            } catch (e: Throwable) {
                notify("Universal Harness node failed", e.message ?: "see logs", important = true)
            }
        }
    }

    private fun stopNode() {
        runCatching { advertisement?.unregister() }
        advertisement = null
        runCatching { server?.stop() }
        server = null
        serverJob?.cancel()
    }

    override fun onDestroy() {
        stopNode()
        scope.cancel()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun notify(title: String, text: String, important: Boolean = false) {
        getSystemService(NotificationManager::class.java).notify(
            NODE_NOTIFICATION_ID, nodeNotification(text, title, important)
        )
    }

    private fun nodeNotification(
        text: String,
        title: String = "Universal Harness node",
        important: Boolean = false,
    ): Notification {
        val stopIntent = PendingIntent.getService(
            this, 0, Intent(this, NodeServerService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return NotificationCompat.Builder(this, NODE_CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(text)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setOngoing(true)
            .setPriority(if (important) NotificationCompat.PRIORITY_DEFAULT else NotificationCompat.PRIORITY_LOW)
            .addAction(0, "Stop node", stopIntent)
            .build()
    }

    companion object {
        const val ACTION_START = "com.universalharness.node.START"
        const val ACTION_STOP = "com.universalharness.node.STOP"
        private const val NODE_CHANNEL_ID = "uh-node"
        private const val NODE_NOTIFICATION_ID = 7437
        private const val TAG = "UhNodeService"

        /** The endpoint the node announced, or null if it has not bound yet. */
        @Volatile var endpoint: NodeEndpoint? = null

        fun ensureNodeChannel(context: Context) {
            val nm = context.getSystemService(NotificationManager::class.java)
            if (nm.getNotificationChannel(NODE_CHANNEL_ID) == null) {
                nm.createNotificationChannel(
                    NotificationChannel(
                        NODE_CHANNEL_ID,
                        "Universal Harness node",
                        NotificationManager.IMPORTANCE_LOW,
                    ).apply { description = "Shows when the Universal Harness node is listening on the LAN" }
                )
            }
        }
    }
}
