package com.universalharness.node

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import java.util.concurrent.atomic.AtomicReference

/**
 * Phase 3B: advertises the node over mDNS/NSD as `_universal-harness._tcp` (PROTOCOL.md §1).
 *
 * Discovery is deliberately *not* authorization (ADR-007): the advertisement carries only public
 * metadata — the service type, the port, and a display name. It carries **no** pairing token, no
 * node identity fingerprint, and no certificate fingerprint. A controller that discovers this node
 * still has to obtain a pairing payload out of band (a QR code the operator scans) and pin both
 * fingerprints before it trusts anything.
 *
 * The service name embeds the node id's first 8 hex chars so several nodes on one LAN are
 * distinguishable without leaking the full identity.
 */
class NsdNodeAdvertisement(
    private val context: Context,
    private val serviceType: String = SERVICE_TYPE,
) {
    enum class State { UNREGISTERED, REGISTERING, REGISTERED, FAILED }

    @Volatile var state: State = State.UNREGISTERED
        private set
    @Volatile var failure: String? = null
        private set
    private val registrationListener = AtomicReference<NsdManager.RegistrationListener?>(null)

    /**
     * Register the node. [name] should be derived from the node id (see class docs).
     * Returns true once registration is in flight or confirmed.
     */
    fun register(name: String, port: Int): Boolean {
        check(state != State.REGISTERED) { "already registered" }
        val nsd = context.getSystemService(Context.NSD_SERVICE) as? NsdManager
            ?: run { failure = "NSD unavailable on this device"; state = State.FAILED; return false }
        val info = NsdServiceInfo().apply {
            serviceName = name
            this.serviceType = this@NsdNodeAdvertisement.serviceType
            this.port = port
        }
        val listener = object : NsdManager.RegistrationListener {
            override fun onServiceRegistered(s: NsdServiceInfo) {
                state = State.REGISTERED
                failure = null
            }
            override fun onRegistrationFailed(s: NsdServiceInfo, errorCode: Int) {
                state = State.FAILED
                failure = "nsd registration failed (code $errorCode)"
            }
            override fun onServiceUnregistered(s: NsdServiceInfo) { state = State.UNREGISTERED }
            override fun onUnregistrationFailed(s: NsdServiceInfo, errorCode: Int) {
                failure = "nsd unregistration failed (code $errorCode)"
            }
        }
        registrationListener.set(listener)
        state = State.REGISTERING
        return runCatching { nsd.registerService(info, NsdManager.PROTOCOL_DNS_SD, listener) }.isSuccess
    }

    /** Unregister; idempotent. Safe to call from a stopped node. */
    fun unregister() {
        val listener = registrationListener.getAndSet(null) ?: return
        val nsd = context.getSystemService(Context.NSD_SERVICE) as? NsdManager ?: return
        runCatching { nsd.unregisterService(listener) }
        state = State.UNREGISTERED
    }

    companion object {
        /** The mDNS service type every Universal Harness node advertises. */
        const val SERVICE_TYPE = "_universal-harness._tcp."

        /** A display name that distinguishes nodes without leaking a full identity. */
        fun serviceName(nodeId: String): String {
            val short = nodeId.removePrefix("node_").take(8).ifBlank { "node" }
            return "Universal Harness $short"
        }
    }
}
