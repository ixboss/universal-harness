package com.universalharness.node

import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * The NSD advertisement carries public metadata only: the fixed service type from PROTOCOL.md §1
 * and a display name that distinguishes nodes without leaking a full identity. ADR-007: discovery
 * is never authorization, so the name must never embed a token or full node id.
 */
class NsdNodeAdvertisementTest {
    @Test
    fun `the service type is the Universal Harness mDNS type`() {
        assertEquals("_universal-harness._tcp.", NsdNodeAdvertisement.SERVICE_TYPE)
    }

    @Test
    fun `the service name shows only the first 8 hex of the node id`() {
        assertEquals(
            "Universal Harness 0f1e2d3c",
            NsdNodeAdvertisement.serviceName("node_0f1e2d3c4b5a69788796a5b4c3d2e1f0"),
        )
    }

    @Test
    fun `a short node id is padded by taking what exists`() {
        assertEquals("Universal Harness abcdef01", NsdNodeAdvertisement.serviceName("node_abcdef01"))
    }

    @Test
    fun `an id without the node_ prefix is still shortened`() {
        assertEquals("Universal Harness 12345678", NsdNodeAdvertisement.serviceName("1234567890abcdef"))
    }

    @Test
    fun `a blank id falls back to the generic name`() {
        assertEquals("Universal Harness node", NsdNodeAdvertisement.serviceName("node_"))
        assertEquals("Universal Harness node", NsdNodeAdvertisement.serviceName(""))
    }
}
