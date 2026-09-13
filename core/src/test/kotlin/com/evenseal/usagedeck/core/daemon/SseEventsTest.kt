package com.evenseal.usagedeck.core.daemon

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SseEventsTest {
    @Test
    fun `heartbeat parses with empty data`() {
        assertEquals(DaemonEvent.Heartbeat, SseParser.parse("heartbeat", ""))
    }

    @Test
    fun `session event parses type and session`() {
        val e = SseParser.parse(
            "session",
            """{"type":"update","session":{"sessionId":"s1","cwd":"/x",""" +
                """"startedAt":"2026-09-13T11:20:00Z","lastActivityAt":"2026-09-13T11:21:00Z"}}"""
        ) as DaemonEvent.SessionChange
        assertEquals("update", e.type)
        assertEquals("s1", e.session.sessionId)
    }

    @Test
    fun `spend event parses today and delta`() {
        val e = SseParser.parse("spend", """{"today":{"input":10},"delta":{"input":2}}""") as DaemonEvent.Spend
        assertEquals(2L, e.delta.input)
        assertEquals(10L, e.today.input)
    }

    @Test
    fun `limits event parses limits and status`() {
        val e = SseParser.parse(
            "limits",
            """{"limits":[{"id":"weekly_all","kind":"weekly_all","percent":96}],""" +
                """"status":{"byId":{"weekly_all":"critical"},"overall":"critical"}}"""
        ) as DaemonEvent.Limits
        assertEquals(96, e.limits.single().percent)
        assertEquals("critical", e.status.byId["weekly_all"])
    }

    @Test
    fun `pause event parses rules and affected`() {
        val e = SseParser.parse(
            "pause",
            """{"rules":[{"id":"r-1","scope":"all","mode":"soft","reason":"usage-deck:abc",""" +
                """"createdAt":"2026-09-13T14:02:00Z","createdBy":"dashboard"}],"affected":["s1"]}"""
        ) as DaemonEvent.Pause
        assertEquals("usage-deck:abc", e.rules.single().reason)
        assertEquals(listOf("s1"), e.affected)
    }

    @Test
    fun `update event parses the health update object`() {
        val e = SseParser.parse(
            "update",
            """{"channel":"stable","current":"0.1.417+abc","available":null,"state":"deferred",""" +
                """"deferredReason":"hard_frozen_sessions"}"""
        ) as DaemonEvent.Update
        assertEquals("deferred", e.update.state)
        assertNull(e.update.available)
    }

    @Test
    fun `snapshot parses nested summary and sessions and rules array`() {
        val json = """{"name":"alans-mbp","version":"0.1.5+abc","user":{"emailAddress":"a@b"},
          "summary":{"limits":[{"id":"session","kind":"session","percent":42}],"status":{"byId":{"session":"ok"},"overall":"ok"},"today":{"input":1}},
          "sessions":{"rev":7,"sessions":[]},"rules":[{"id":"r","scope":"all","mode":"soft","createdAt":"2026-09-13T00:00:00Z"}],"update":{"state":"idle"},"rev":7}"""
        val s = SseParser.parse("snapshot", json) as DaemonEvent.Snapshot
        assertEquals("alans-mbp", s.name)
        assertEquals(42, s.limits.single().percent)
        assertEquals(1, s.rules.size)
        assertEquals(7L, s.rev)
        assertEquals("ok", s.status.byId["session"])
        assertEquals(1L, s.today.input)
        assertEquals("a@b", s.user!!.emailAddress)
        assertEquals("idle", s.update!!.state)
    }

    @Test
    fun `snapshot accepts rules wrapped in object`() {
        val s = SseParser.parse(
            "snapshot",
            """{"summary":{},"sessions":{},"rules":{"rev":1,"rules":[]},"rev":1}"""
        ) as DaemonEvent.Snapshot
        assertTrue(s.rules.isEmpty())
    }

    @Test
    fun `malformed data yields Unknown not exception`() {
        assertTrue(SseParser.parse("session", "{not json") is DaemonEvent.Unknown)
    }

    @Test
    fun `unknown event name yields Unknown`() {
        assertEquals(DaemonEvent.Unknown("zebra"), SseParser.parse("zebra", "{}"))
    }
}
