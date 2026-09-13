package com.evenseal.usagedeck.core.model

import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TeamStateTest {
    private val t0: Instant = Instant.parse("2026-09-13T14:00:00Z")

    private fun limit(id: String, percent: Int, kind: String = id) = Limit(
        id = id,
        kind = kind,
        group = if (id == "session") "session" else "weekly",
        percent = percent,
        severity = "normal",
        resetsAt = null,
        scopeModel = null,
        isActive = false,
        status = LimitStatus.OK
    )

    private fun session(
        id: String,
        cwd: String,
        projectKey: String,
        projectName: String,
        worktree: String? = null,
        tokens: Tokens = Tokens(input = 100),
        alive: Boolean = true,
        pause: PauseState? = null
    ) = Session(
        sessionId = id,
        pid = 1,
        alive = alive,
        discovered = Discovered.HOOK,
        cwd = cwd,
        transcriptPath = null,
        projectKey = projectKey,
        projectName = projectName,
        worktree = worktree,
        model = "claude-opus-5",
        startedAt = t0,
        lastActivityAt = t0,
        tokens = tokens,
        pause = pause,
        lastTool = null
    )

    private fun machine(
        id: String,
        user: User?,
        limits: List<Limit> = emptyList(),
        limitsFetchedAt: Instant? = null,
        sessions: List<Session> = emptyList(),
        today: Tokens = Tokens.ZERO,
        projectTokens: List<ProjectTokens> = emptyList(),
        health: Health = Health.FRESH
    ) = MachineState(
        config = MachineConfig(id, id, "100.68.1.2", 47291, "tok"),
        health = health,
        lastHeartbeatAt = t0,
        name = id,
        version = "0.1.417+abc",
        user = user,
        limits = limits,
        limitsFetchedAt = limitsFetchedAt,
        today = today,
        sessions = sessions,
        projectTokens = projectTokens
    )

    private val alan = User("alan@evensealproductions.com", "uuid-alan", "Alan")
    private val jamie = User("jamie@example.com", "uuid-jamie", "Jamie")

    @Test
    fun `same user on two machines collapses with the freshest limits winning`() {
        val stale = machine(
            "m1",
            alan,
            limits = listOf(limit("weekly_all", 10)),
            limitsFetchedAt = t0.minusSeconds(600),
            health = Health.STALE
        )
        val fresh = machine(
            "m2",
            alan.copy(displayName = null),
            limits = listOf(limit("weekly_all", 81), limit("session", 42)),
            limitsFetchedAt = t0,
            health = Health.FRESH
        )
        val team = TeamState(listOf(stale, fresh))
        val user = team.users.single()
        assertEquals("uuid-alan", user.key)
        assertEquals("Alan", user.displayName)
        assertEquals(listOf("m1", "m2"), user.machineIds)
        assertEquals(81, user.sevenDay!!.percent)
        assertEquals(42, user.fiveHour!!.percent)
        assertEquals(t0, user.limitsFetchedAt)
        assertEquals(Health.FRESH, user.health)
    }

    @Test
    fun `two different users stay separate`() {
        val team = TeamState(
            listOf(
                machine("m1", alan, limits = listOf(limit("session", 10)), limitsFetchedAt = t0),
                machine("m2", jamie, limits = listOf(limit("session", 90)), limitsFetchedAt = t0)
            )
        )
        assertEquals(2, team.users.size)
        assertEquals(setOf("uuid-alan", "uuid-jamie"), team.users.map { it.key }.toSet())
        assertEquals(10, team.users.first { it.key == "uuid-alan" }.fiveHour!!.percent)
    }

    @Test
    fun `a machine with no user falls back to its machine id`() {
        val team = TeamState(listOf(machine("m9", null)))
        val user = team.users.single()
        assertEquals("m9", user.key)
        assertEquals("m9", user.displayName)
        assertNull(user.emailAddress)
    }

    @Test
    fun `scoped limits are exposed separately from the two headlines`() {
        val scoped = limit("weekly_scoped:fable", 10, kind = "weekly_scoped")
        val team = TeamState(
            listOf(
                machine(
                    "m1",
                    alan,
                    limits = listOf(limit("session", 42), limit("weekly_all", 81), scoped),
                    limitsFetchedAt = t0
                )
            )
        )
        val user = team.users.single()
        assertEquals(listOf("weekly_scoped:fable"), user.scoped.map { it.id })
    }

    @Test
    fun `worktrees of one repo roll up into a single project`() {
        val git = "/Users/alan/code/calendarpa/.git"
        val m = machine(
            "m1",
            alan,
            sessions = listOf(
                session("s1", "/Users/alan/code/calendarpa", git, "calendarpa", tokens = Tokens(input = 10)),
                session(
                    "s2",
                    "/Users/alan/code/calendarpa-wt/billing",
                    git,
                    "calendarpa",
                    worktree = "billing",
                    tokens = Tokens(input = 20)
                )
            )
        )
        val project = TeamState(listOf(m)).projects.single()
        assertEquals(git, project.key)
        assertEquals("calendarpa", project.name)
        assertEquals("m1", project.machineId)
        assertEquals(2, project.sessions.size)
        assertEquals(2, project.worktreeCount)
        assertEquals(30L, project.liveTokens.input)
        assertFalse(project.isIdle)
    }

    @Test
    fun `idle projects come after live ones and carry their today totals`() {
        val git = "/Users/alan/code/calendarpa/.git"
        val m = machine(
            "m1",
            alan,
            sessions = listOf(
                session("s1", "/Users/alan/code/calendarpa", git, "calendarpa", tokens = Tokens(input = 10))
            ),
            projectTokens = listOf(
                ProjectTokens("-Users-alan-code-calendarpa", "/Users/alan/code/calendarpa", Tokens(input = 500)),
                ProjectTokens("-Users-alan-code-audioleveler", "/Users/alan/code/audioleveler", Tokens(input = 900))
            )
        )
        val projects = TeamState(listOf(m)).projects
        assertEquals(2, projects.size)
        assertEquals(git, projects[0].key)
        assertEquals(500L, projects[0].todayTokens!!.input)
        assertEquals("/Users/alan/code/audioleveler", projects[1].key)
        assertEquals("audioleveler", projects[1].name)
        assertTrue(projects[1].isIdle)
        assertEquals(900L, projects[1].todayTokens!!.input)
    }

    @Test
    fun `live projects sort by live tokens descending`() {
        val m = machine(
            "m1",
            alan,
            sessions = listOf(
                session("s1", "/a", "/a/.git", "a", tokens = Tokens(input = 10)),
                session("s2", "/b", "/b/.git", "b", tokens = Tokens(input = 99))
            )
        )
        assertEquals(listOf("/b/.git", "/a/.git"), TeamState(listOf(m)).projects.map { it.key })
    }

    @Test
    fun `hard pause wins over soft on a project`() {
        val git = "/g/.git"
        val soft = PauseState(PauseMode.SOFT, "r1", "session:s1", t0, emptyList())
        val hard = PauseState(PauseMode.HARD, "r2", "session:s2", t0, listOf(42))
        val m = machine(
            "m1",
            alan,
            sessions = listOf(
                session("s1", "/g", git, "g", pause = soft),
                session("s2", "/g/wt", git, "g", worktree = "wt", pause = hard)
            )
        )
        assertEquals(PauseMode.HARD, TeamState(listOf(m)).projects.single().pause!!.mode)
    }

    @Test
    fun `team today sums both machines and live sessions are counted`() {
        val team = TeamState(
            listOf(
                machine(
                    "m1",
                    alan,
                    today = Tokens(input = 100, output = 5),
                    sessions = listOf(session("s1", "/a", "/a/.git", "a"))
                ),
                machine(
                    "m2",
                    jamie,
                    today = Tokens(input = 200, output = 7),
                    sessions = listOf(
                        session("s2", "/b", "/b/.git", "b"),
                        session("s3", "/c", "/c/.git", "c", alive = false)
                    )
                )
            )
        )
        assertEquals(300L, team.teamToday.input)
        assertEquals(12L, team.teamToday.output)
        assertEquals(2, team.liveSessionCount)
    }

    @Test
    fun `machine and session lookups are scoped to one machine`() {
        val team = TeamState(
            listOf(
                machine("m1", alan, sessions = listOf(session("s1", "/a", "/a/.git", "a"))),
                machine("m2", jamie, sessions = listOf(session("s2", "/b", "/b/.git", "b")))
            )
        )
        assertNotNull(team.machine("m2"))
        assertNull(team.machine("nope"))
        assertEquals("s1", team.session("m1", "s1")!!.sessionId)
        assertNull(team.session("m2", "s1"))
    }

    @Test
    fun `same project key on two machines stays two projects`() {
        val git = "/Users/alan/code/calendarpa/.git"
        val team = TeamState(
            listOf(
                machine("m1", alan, sessions = listOf(session("s1", "/x", git, "calendarpa"))),
                machine("m2", jamie, sessions = listOf(session("s2", "/x", git, "calendarpa")))
            )
        )
        assertEquals(2, team.projects.size)
        assertEquals(setOf("m1", "m2"), team.projects.map { it.machineId }.toSet())
    }
}
