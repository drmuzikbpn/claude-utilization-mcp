package com.evenseal.usagedeck.core.daemon

import com.evenseal.usagedeck.core.model.Discovered
import com.evenseal.usagedeck.core.model.MachineConfig
import com.evenseal.usagedeck.core.model.PauseMode
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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
        val body = "id: 1\nevent: snapshot\ndata: {\"summary\":{},\"sessions\":[],\"rules\":[],\"rev\":1}\n\n" +
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
                "Pause",
                "SessionChange",
                "Spend",
                "Spend",
                "Heartbeat",
                "Closed"
            ),
            items.map { it::class.simpleName }
        )

        val snapshot = items[1] as DaemonEvent.Snapshot
        assertEquals("alans-mbp", snapshot.name)
        assertEquals("0.1.0", snapshot.version)
        assertEquals("Alan Example", snapshot.user!!.displayName)
        assertEquals(listOf("session", "weekly_all", "weekly_scoped:fable"), snapshot.limits.map { it.id })
        assertEquals(69, snapshot.limits.first { it.id == "session" }.percent)
        assertEquals("Fable", snapshot.limits.first { it.id == "weekly_scoped:fable" }.scope!!.model)
        assertEquals("ok", snapshot.status.byId["weekly_all"])
        assertEquals(95, snapshot.thresholds.critical)
        assertEquals(7702L, snapshot.today.input)
        assertEquals(3L, snapshot.rev)
        assertEquals("disabled", snapshot.update!!.state)

        // sessions arrive as the §17.3 object: hook-registered worktree first, then transcript-only
        val live = snapshot.sessions.first().toModel()
        assertEquals("3f6c1a2e-8b1d-4c1a-9e1f-5d2a7b9c0e11", live.sessionId)
        assertEquals(48213, live.pid)
        assertEquals("/Users/alan/code/foo/.git", live.projectKey)
        assertEquals("foo", live.projectName)
        assertEquals("foo-wt2", live.worktree)
        assertTrue(live.canHardPause)
        assertEquals(PauseMode.SOFT, live.pause!!.mode)
        assertEquals("r_trpikx7bbznr4lgn", live.pause!!.ruleId)
        assertEquals("Bash", live.lastTool!!.name)
        val backfilled = snapshot.sessions[1].toModel()
        assertEquals(Discovered.TRANSCRIPT, backfilled.discovered)
        assertFalse(backfilled.alive)
        assertFalse(backfilled.canHardPause)
        assertEquals("/Users/alan/code/android-project", backfilled.projectKey)

        // rules arrive in the §18.1 scope grammar
        assertEquals(1, snapshot.rules.size)
        assertEquals("session:3f6c1a2e-8b1d-4c1a-9e1f-5d2a7b9c0e11", snapshot.rules.single().toModel().scope)
        assertEquals("usage-deck:install-7f3a", snapshot.rules.single().reason)

        val pause = items[2] as DaemonEvent.Pause
        assertTrue("the rule was resumed, so the list is empty", pause.rules.isEmpty())
        assertEquals(listOf("3f6c1a2e-8b1d-4c1a-9e1f-5d2a7b9c0e11"), pause.affected)

        val session = items[3] as DaemonEvent.SessionChange
        assertEquals("update", session.type)
        assertEquals("3f6c1a2e-8b1d-4c1a-9e1f-5d2a7b9c0e11", session.session.toModel().sessionId)
        assertNull("the pause cleared on the same session", session.session.pause)
        assertEquals("foo", session.session.toModel().projectName)

        // today is cumulative; delta is per-event, so the second spend's delta is the increment
        val first = items[4] as DaemonEvent.Spend
        val second = items[5] as DaemonEvent.Spend
        assertEquals(7704L, first.today.input)
        assertEquals(7708L, second.today.input)
        assertEquals(4L, second.delta.input)
        assertEquals(second.today.input - first.today.input, second.delta.input)

        assertEquals(DaemonEvent.Heartbeat(11, "2026-09-13T19:01:56.885Z"), items[6])
        assertNull((items[7] as Connection.Closed).error)
    }

    @Test
    fun `the standalone snapshot fixture decodes the same way`() = runTest {
        val snapshot = SseParser.parse("snapshot", fixture("snapshot.json")) as DaemonEvent.Snapshot
        assertEquals("alans-mbp", snapshot.name)
        assertEquals(3, snapshot.limits.size)
        assertEquals(46, snapshot.sessions.size)
        assertEquals(1, snapshot.rules.size)
        assertEquals(3L, snapshot.rev)
        assertEquals("disabled", snapshot.update!!.state)
        assertEquals(
            "session:3f6c1a2e-8b1d-4c1a-9e1f-5d2a7b9c0e11",
            snapshot.rules.single().toModel().scope
        )
    }

    @Test
    fun `a session missing a required field fails into Unknown rather than half-decoding`() {
        val event = SseParser.parse("session", """{"type":"update","session":{"cwd":"/x"}}""")
        assertEquals(DaemonEvent.Unknown("session"), event)
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
