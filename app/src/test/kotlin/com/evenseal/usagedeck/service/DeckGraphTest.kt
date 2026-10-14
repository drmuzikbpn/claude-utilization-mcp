// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck.service

import androidx.test.core.app.ApplicationProvider
import com.evenseal.usagedeck.UsageDeckApp
import com.evenseal.usagedeck.core.daemon.DaemonException
import com.evenseal.usagedeck.core.model.MachineConfig
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class DeckGraphTest {
    private val graph = ApplicationProvider.getApplicationContext<UsageDeckApp>().graph

    @Test
    fun `the pause controller's api is the client's watched one, so its 401s mark the machine`() = runBlocking {
        // TEST-NET-1: never routable, so the client fails quietly in the background.
        graph.machineStore.add(MachineConfig("g1", "studio", "192.0.2.1", 47292, "t", fp = "a".repeat(64)))
        try {
            graph.startClients()
            val client = withTimeout(5_000) { graph.clients.first { "g1" in it } }.getValue("g1")
            assertSame(client.api, graph.apiFor("g1"))
        } finally {
            graph.stopClients()
            graph.machineStore.remove("g1")
        }
    }

    @Test
    fun `a row from the retired pairing gets a client that asks for a re-pair and never connects`() = runBlocking {
        graph.machineStore.add(MachineConfig("old", "studio", "192.0.2.2", 47291, ""))
        try {
            graph.startClients()
            val client = withTimeout(5_000) { graph.clients.first { "old" in it } }.getValue("old")
            assertEquals("legacy", client.state.value.needsRepair?.code)
            val refused = runCatching { graph.apiFor("old")!!.summary() }.exceptionOrNull()
            assertEquals("legacy", (refused as DaemonException).code)
        } finally {
            graph.stopClients()
            graph.machineStore.remove("old")
        }
    }

    @Test
    fun `the shared http client has no cleartext connection spec`() {
        assertTrue(graph.http.connectionSpecs.isNotEmpty())
        assertTrue(graph.http.connectionSpecs.none { !it.isTls })
    }
}
