package com.evenseal.usagedeck.core.daemon

import com.evenseal.usagedeck.core.model.MachineConfig
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class EventSourceTest {
    private val server = MockWebServer()
    private lateinit var cfg: MachineConfig

    @Before
    fun up() {
        server.start()
        cfg = MachineConfig("m", "n", server.hostName, server.port, "tok")
    }

    @After
    fun down() {
        runCatching { server.shutdown() }
    }

    private fun fixture(n: String) = javaClass.getResource("/fixtures/$n")!!.readText()

    @Test
    fun `emits Open then parsed events then Closed`() = runTest {
        val body = "id: 1\nevent: snapshot\ndata: {\"summary\":{},\"sessions\":{},\"rules\":[],\"rev\":1}\n\n" +
            "event: heartbeat\ndata: {}\n\n"
        server.enqueue(MockResponse().setHeader("Content-Type", "text/event-stream").setBody(body))
        val items = DaemonEventSource(cfg, OkHttpClient()).events().toList()
        assertEquals(Connection.Open, items[0])
        assertTrue(items[1] is DaemonEvent.Snapshot)
        assertEquals(DaemonEvent.Heartbeat, items[2])
        assertTrue(items.last() is Connection.Closed)
        assertNull((items.last() as Connection.Closed).error)
        val req = server.takeRequest()
        assertEquals("Bearer tok", req.getHeader("Authorization"))
        assertEquals("/v1/events", req.path)
    }

    @Test
    fun `401 closes with unauthorized`() = runTest {
        server.enqueue(MockResponse().setResponseCode(401).setBody(fixture("error-401.json")))
        val last = DaemonEventSource(cfg, OkHttpClient()).events().toList().last() as Connection.Closed
        assertEquals("unauthorized", last.error!!.code)
    }

    @Test
    fun `connection refused closes with network error`() = runTest {
        server.shutdown()
        val items = DaemonEventSource(cfg, OkHttpClient()).events().toList()
        val last = items.last() as Connection.Closed
        assertEquals("network", last.error!!.code)
        assertTrue(items.none { it == Connection.Open })
    }
}
