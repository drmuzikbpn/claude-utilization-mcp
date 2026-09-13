package com.evenseal.usagedeck.core.alerts

import com.evenseal.usagedeck.core.model.Discovered
import com.evenseal.usagedeck.core.model.Health
import com.evenseal.usagedeck.core.model.Limit
import com.evenseal.usagedeck.core.model.LimitStatus
import com.evenseal.usagedeck.core.model.MachineConfig
import com.evenseal.usagedeck.core.model.MachineState
import com.evenseal.usagedeck.core.model.PauseMode
import com.evenseal.usagedeck.core.model.PauseState
import com.evenseal.usagedeck.core.model.Session
import com.evenseal.usagedeck.core.model.TeamState
import com.evenseal.usagedeck.core.model.Tokens
import com.evenseal.usagedeck.core.model.User
import java.time.Instant
import java.time.ZoneOffset
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AlertEvaluatorTest {
    private val t0: Instant = Instant.parse("2026-09-13T14:00:00Z")
    private val alan = User("alan@evensealproductions.com", "uuid-alan", "Alan")
    private val evaluator = AlertEvaluator(MutableStateFlow(AlertThresholds()), ZoneOffset.UTC)

    private fun limit(id: String, percent: Int, resetsAt: Instant? = null, kind: String = id, model: String? = null) =
        Limit(
            id = id,
            kind = kind,
            group = if (id == "session") "session" else "weekly",
            percent = percent,
            severity = "normal",
            resetsAt = resetsAt,
            scopeModel = model,
            isActive = false,
            status = LimitStatus.OK
        )

    private fun session(id: String, pause: PauseState? = null) = Session(
        sessionId = id,
        pid = 42,
        alive = true,
        discovered = Discovered.HOOK,
        cwd = "/Users/alan/code/calendarpa",
        transcriptPath = null,
        projectKey = "/Users/alan/code/calendarpa/.git",
        projectName = "calendarpa",
        worktree = null,
        model = null,
        startedAt = t0,
        lastActivityAt = t0,
        tokens = Tokens.ZERO,
        pause = pause,
        lastTool = null
    )

    private fun machine(
        id: String = "m1",
        health: Health = Health.FRESH,
        limits: List<Limit> = emptyList(),
        sessions: List<Session> = emptyList(),
        user: User? = alan
    ) = MachineState(
        config = MachineConfig(id, "alans-mbp", "100.68.1.2", 47291, "tok"),
        health = health,
        lastHeartbeatAt = t0,
        name = "alans-mbp",
        user = user,
        limits = limits,
        limitsFetchedAt = t0,
        sessions = sessions
    )

    private fun team(vararg machines: MachineState) = TeamState(machines.toList())

    @Test
    fun `crossing the warn threshold raises one warn alert`() {
        val before = team(machine(limits = listOf(limit("weekly_all", 79, Instant.parse("2026-09-18T09:00:00Z")))))
        val after = team(machine(limits = listOf(limit("weekly_all", 81, Instant.parse("2026-09-18T09:00:00Z")))))
        val alerts = evaluator.evaluate(before, after)
        val alert = alerts.single()
        assertEquals(AlertKind.WARN, alert.kind)
        assertEquals("WARN|uuid-alan|weekly_all", alert.key)
        assertEquals("Alan 7-day at 81% · resets Fri 09:00", alert.body)
    }

    @Test
    fun `staying above warn raises nothing the second time`() {
        val at81 = team(machine(limits = listOf(limit("weekly_all", 81))))
        val at82 = team(machine(limits = listOf(limit("weekly_all", 82))))
        assertTrue(evaluator.evaluate(at81, at82).isEmpty())
    }

    @Test
    fun `first sight of a limit already above warn raises warn`() {
        val after = team(machine(limits = listOf(limit("weekly_all", 81))))
        val alert = evaluator.evaluate(null, after).single()
        assertEquals(AlertKind.WARN, alert.kind)
        assertEquals("Alan 7-day at 81% · resets: unknown", alert.body)
    }

    @Test
    fun `crossing critical raises critical not warn`() {
        val before = team(machine(limits = listOf(limit("weekly_all", 81))))
        val after = team(machine(limits = listOf(limit("weekly_all", 96))))
        val alert = evaluator.evaluate(before, after).single()
        assertEquals(AlertKind.CRITICAL, alert.kind)
        assertEquals("CRITICAL|uuid-alan|weekly_all", alert.key)
        assertTrue(alert.body.startsWith("Alan 7-day at 96%"))
    }

    @Test
    fun `first sight already critical raises critical only`() {
        val after = team(machine(limits = listOf(limit("session", 99, Instant.parse("2026-09-13T16:35:00Z")))))
        val alert = evaluator.evaluate(null, after).single()
        assertEquals(AlertKind.CRITICAL, alert.kind)
        assertEquals("Alan 5-hour at 99% · resets Sun 16:35", alert.body)
    }

    @Test
    fun `scoped limits are named by their model`() {
        val scoped = limit("weekly_scoped:fable", 96, kind = "weekly_scoped", model = "Fable")
        val alert = evaluator.evaluate(null, team(machine(limits = listOf(scoped)))).single()
        assertTrue(alert.body.startsWith("Alan Fable at 96%"))
    }

    @Test
    fun `dropping back below warn raises nothing`() {
        val before = team(machine(limits = listOf(limit("weekly_all", 96))))
        val after = team(machine(limits = listOf(limit("weekly_all", 4))))
        assertTrue(evaluator.evaluate(before, after).isEmpty())
    }

    @Test
    fun `both users crossing at once produce two alerts`() {
        val jamie = User("jamie@example.com", "uuid-jamie", "Jamie")
        val before = team(
            machine("m1", limits = listOf(limit("weekly_all", 10))),
            machine("m2", limits = listOf(limit("weekly_all", 10)), user = jamie)
        )
        val after = team(
            machine("m1", limits = listOf(limit("weekly_all", 85))),
            machine("m2", limits = listOf(limit("weekly_all", 85)), user = jamie)
        )
        val alerts = evaluator.evaluate(before, after)
        assertEquals(2, alerts.size)
        assertEquals(setOf("WARN|uuid-alan|weekly_all", "WARN|uuid-jamie|weekly_all"), alerts.map { it.key }.toSet())
    }

    @Test
    fun `a session entering hard freeze raises frozen`() {
        val frozen = PauseState(PauseMode.HARD, "r-1", "session:s1", t0, listOf(42))
        val soft = PauseState(PauseMode.SOFT, "r-1", "session:s1", t0, emptyList())
        val before = team(machine(sessions = listOf(session("s1", soft))))
        val after = team(machine(sessions = listOf(session("s1", frozen))))
        val alert = evaluator.evaluate(before, after).single()
        assertEquals(AlertKind.FROZEN, alert.kind)
        assertEquals("FROZEN|m1|s1", alert.key)
        assertTrue(alert.body.contains("calendarpa"))
    }

    @Test
    fun `a session that stays frozen raises nothing`() {
        val frozen = PauseState(PauseMode.HARD, "r-1", "session:s1", t0, listOf(42))
        val before = team(machine(sessions = listOf(session("s1", frozen))))
        val after = team(machine(sessions = listOf(session("s1", frozen))))
        assertTrue(evaluator.evaluate(before, after).isEmpty())
    }

    @Test
    fun `a machine entering dead raises unreachable once`() {
        val before = team(machine(health = Health.STALE))
        val after = team(machine(health = Health.DEAD))
        val alert = evaluator.evaluate(before, after).single()
        assertEquals(AlertKind.UNREACHABLE, alert.kind)
        assertEquals("UNREACHABLE|m1", alert.key)
        assertTrue(alert.body.contains("alans-mbp"))

        assertTrue(evaluator.evaluate(after, after).isEmpty())
    }

    @Test
    fun `a machine that starts dead raises nothing`() {
        assertTrue(evaluator.evaluate(null, team(machine(health = Health.DEAD))).isEmpty())
    }

    @Test
    fun `thresholds are configurable`() {
        val strict = AlertEvaluator(MutableStateFlow(AlertThresholds(warn = 50, critical = 60)), ZoneOffset.UTC)
        val before = team(machine(limits = listOf(limit("weekly_all", 40))))
        val after = team(machine(limits = listOf(limit("weekly_all", 55))))
        assertEquals(AlertKind.WARN, strict.evaluate(before, after).single().kind)
    }
}
