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

    private fun fixture(n: String) = Fixtures.text(n)

    @Test
    fun `emits Open then parsed events then Closed`() = runTest {
        val body = "id: 1\nevent: snapshot\ndata: {\"summary\":{},\"sessions\":{},\"rules\":[],\"rev\":1}\n\n" +
            "event: heartbeat\ndata: {}\n\n"
        server.enqueue(MockResponse().setHeader("Content-Type", "text/event-stream").setBody(body))
        val items = DaemonEventSource(cfg, OkHttpClient()).events().toList()
        assertEquals(Connection.Open, items[0])
        assertTrue(items[1] is DaemonEvent.Snapshot)
        assertEquals(DaemonEvent.Heartbeat(), items[2])
        assertTrue(items.last() is Connection.Closed)
        assertNull((items.last() as Connection.Closed).error)
        val req = server.takeRequest()
        assertEquals("Bearer tok", req.getHeader("Authorization"))
        assertEquals("/v1/events", req.path)
    }

    @Test
    fun `401 closes with unauthorized`() = runTest {
        server.enqueue(
            MockResponse()
                .setResponseCode(Fixtures.errorStatus("unauthorized"))
                .setBody(Fixtures.errorBody("unauthorized"))
        )
        val last = DaemonEventSource(cfg, OkHttpClient()).events().toList().last() as Connection.Closed
        assertEquals("unauthorized", last.error!!.code)
    }

    @Test
    fun `the daemon's recorded wire transcript decodes to the documented event sequence`() = runTest {
        server.enqueue(
            MockResponse()
                .setHeader("Content-Type", "text/event-stream")
                .setBody(fixture("stream.sse"))
        )
        val items = DaemonEventSource(cfg, OkHttpClient()).events().toList()
        assertEquals(
            listOf(
                "Open",
                "Snapshot",
                "Limits",
                "Spend",
                "SessionChange",
                "Pause",
                "Heartbeat",
                "Closed"
            ),
            items.map { it::class.simpleName }
        )

        val snapshot = items[1] as DaemonEvent.Snapshot
        assertEquals("alans-mbp", snapshot.name)
        assertEquals("0.1.417+3f9c2ab", snapshot.version)
        assertEquals("Alan Example", snapshot.user!!.displayName)
        assertEquals(listOf("session", "weekly_all", "weekly_scoped:fable"), snapshot.limits.map { it.id })
        assertEquals("warn", snapshot.status.byId["weekly_scoped:fable"])
        assertEquals(95, snapshot.thresholds.critical)
        assertEquals(1284000L, snapshot.today.input)
        assertEquals(2, snapshot.sessions.size)
        assertEquals("3f2a91c4-7d51-4a0e-9a6b-1c0d5e8f2b77", snapshot.sessions.first().identifier)
        assertEquals(1, snapshot.rules.size)
        assertEquals("session:8b4c0d2e-55aa-4f13-8e77-2d9a6c31b904", snapshot.rules.single().fullScope)
        assertEquals(0L, snapshot.rev)

        val limits = items[2] as DaemonEvent.Limits
        assertEquals(39, limits.limits.first { it.id == "session" }.percent)
        assertEquals("2026-09-13T14:00:41.000Z", limits.fetchedAt)

        val spend = items[3] as DaemonEvent.Spend
        assertEquals(1294200L, spend.today.input)
        assertEquals(10200L, spend.delta.input)

        val session = items[4] as DaemonEvent.SessionChange
        assertEquals("update", session.type)
        assertEquals("3f2a91c4-7d51-4a0e-9a6b-1c0d5e8f2b77", session.session.toModel().sessionId)
        assertEquals("Bash", session.session.lastTool!!.name)
        assertEquals("orbit-api", session.session.toModel().projectName)

        val pause = items[5] as DaemonEvent.Pause
        assertEquals(listOf("8b4c0d2e-55aa-4f13-8e77-2d9a6c31b904"), pause.affected)
        assertTrue(pause.rules.single().reason!!.startsWith("usage-deck:7f10c2"))

        assertEquals(DaemonEvent.Heartbeat(5, "2026-09-13T14:00:15.000Z"), items[6])
        assertNull((items[7] as Connection.Closed).error)
    }

    @Test
    fun `the standalone snapshot fixture decodes the same way`() = runTest {
        val snapshot = SseParser.parse("snapshot", fixture("snapshot.json")) as DaemonEvent.Snapshot
        assertEquals("alans-mbp", snapshot.name)
        assertEquals(3, snapshot.limits.size)
        assertEquals(2, snapshot.sessions.size)
        assertEquals(1, snapshot.rules.size)
        assertEquals("disabled", snapshot.update!!.state)
    }

    @Test
    fun `too many SSE clients closes with the unavailable envelope`() = runTest {
        server.enqueue(
            MockResponse()
                .setResponseCode(503)
                .setBody("""{"error":{"code":"unavailable","message":"Too many event stream clients"}}""")
        )
        val last = DaemonEventSource(cfg, OkHttpClient()).events().toList().last() as Connection.Closed
        assertEquals("unavailable", last.error!!.code)
        assertEquals("Too many event stream clients", last.error!!.userMessage())
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
