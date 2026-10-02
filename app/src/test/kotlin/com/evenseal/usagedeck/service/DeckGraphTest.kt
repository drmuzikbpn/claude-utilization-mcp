package com.evenseal.usagedeck.service

import androidx.test.core.app.ApplicationProvider
import com.evenseal.usagedeck.UsageDeckApp
import com.evenseal.usagedeck.core.model.MachineConfig
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertSame
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class DeckGraphTest {
    private val graph = ApplicationProvider.getApplicationContext<UsageDeckApp>().graph

    @Test
    fun `the pause controller's api is the client's watched one, so its 401s mark the machine`() = runBlocking {
        // TEST-NET-1: never routable, so the client fails quietly in the background.
        graph.machineStore.add(MachineConfig("g1", "studio", "192.0.2.1", 47291, "t"))
        try {
            graph.startClients()
            val client = withTimeout(5_000) { graph.clients.first { "g1" in it } }.getValue("g1")
            assertSame(client.api, graph.apiFor("g1"))
        } finally {
            graph.stopClients()
            graph.machineStore.remove("g1")
        }
    }
}
