package com.evenseal.usagedeck.core.model

import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ActivityOrderTest {
    private val t0: Instant = Instant.parse("2026-10-02T19:00:00Z")

    private fun session(id: String) = Session(
        sessionId = id,
        pid = 1,
        alive = true,
        discovered = Discovered.HOOK,
        cwd = "/w/$id",
        transcriptPath = null,
        projectKey = "k",
        projectName = "p",
        worktree = null,
        model = null,
        startedAt = t0,
        lastActivityAt = t0,
        tokens = Tokens.ZERO,
        pause = null,
        lastTool = null
    )

    private fun project(name: String, vararg sessions: String) = ProjectView(
        machineId = "m",
        key = name,
        name = name,
        sessions = sessions.map { session(it) },
        todayTokens = null,
        worktreeCount = 1
    )

    private val rates = mapOf("a1" to 0.0, "a2" to 900.0, "b1" to 50_000.0, "b2" to 2_000_000.0, "c1" to 400_000.0)
    private val team = listOf(project("a", "a1", "a2"), project("b", "b1", "b2"), project("c", "c1"))
    private fun sessionRate(p: ProjectView, s: Session) = rates.getValue(s.sessionId)
    private fun projectRate(p: ProjectView) = p.sessions.sumOf { rates.getValue(it.sessionId) }

    @Test
    fun `projects go fastest first, each with its sessions fastest first`() {
        val ordered = ActivityOrder.projects(team, ::projectRate, ::sessionRate)
        assertEquals(listOf("b", "c", "a"), ordered.map { it.name })
        assertEquals(listOf("b2", "b1"), ordered[0].sessions.map { it.sessionId })
        assertEquals(listOf("a2", "a1"), ordered[2].sessions.map { it.sessionId })
    }

    @Test
    fun `the flat list ranks every session on its own`() {
        val rows = ActivityOrder.sessions(team, ::sessionRate)
        assertEquals(listOf("b2", "c1", "b1", "a2", "a1"), rows.map { it.session.sessionId })
        assertEquals(listOf("b", "c", "b", "a", "a"), rows.map { it.project.name })
    }

    @Test
    fun `projects with no live session are left out`() {
        val ordered = ActivityOrder.projects(team + project("idle"), ::projectRate, ::sessionRate)
        assertEquals(3, ordered.size)
    }

    @Test
    fun `rows burning at nearly the same pace keep their places`() {
        val close = listOf(project("x", "x1"), project("y", "y1"))
        val nearly = mapOf("x1" to 100_000.0, "y1" to 110_000.0)
        val ordered = ActivityOrder.projects(
            close,
            { p -> nearly.getValue(p.sessions.first().sessionId) },
            { _, s -> nearly.getValue(s.sessionId) }
        )
        assertEquals(listOf("x", "y"), ordered.map { it.name })
        assertEquals(ActivityOrder.band(100_000.0), ActivityOrder.band(110_000.0))
        assertTrue(ActivityOrder.band(200_000.0) > ActivityOrder.band(100_000.0))
    }

    @Test
    fun `under one token a minute is idle, whatever the fraction`() {
        assertEquals(ActivityOrder.band(0.0), ActivityOrder.band(0.9))
        assertTrue(ActivityOrder.band(1.0) > ActivityOrder.band(0.9))
    }
}
