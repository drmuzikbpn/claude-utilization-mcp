package com.evenseal.usagedeck.core.model

import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AgingTest {
    private val now = Instant.parse("2026-09-13T14:00:00Z")

    @Test
    fun `null heartbeat is dead`() {
        assertEquals(Health.DEAD, Aging.health(null, now))
    }

    @Test
    fun `29s is fresh 30s is stale 120s is dead`() {
        assertEquals(Health.FRESH, Aging.health(now.minusSeconds(29), now))
        assertEquals(Health.STALE, Aging.health(now.minusSeconds(30), now))
        assertEquals(Health.STALE, Aging.health(now.minusSeconds(119), now))
        assertEquals(Health.DEAD, Aging.health(now.minusSeconds(120), now))
    }

    @Test
    fun `a heartbeat in the future is fresh`() {
        assertEquals(Health.FRESH, Aging.health(now.plusSeconds(5), now))
    }

    @Test
    fun `a machine is gone a day after its last check-in`() {
        assertFalse(Aging.isGone(now.minusSeconds(86_399), now))
        assertTrue(Aging.isGone(now.minusSeconds(86_400), now))
        // Never heard from is still connecting: there is nothing of its to drop.
        assertFalse(Aging.isGone(null, now))
    }

    private val limit = Limit("session", "session", "session", 42, "normal", null, null, false, LimitStatus.OK)

    private fun reporting(lastHeartbeatAt: Instant) = MachineState(
        config = MachineConfig("m1", "m1", "100.68.1.2", 47291, "tok"),
        health = Health.FRESH,
        lastHeartbeatAt = lastHeartbeatAt,
        name = "m1",
        version = "0.1.98",
        user = User("adam@example.com", "uuid-adam", "Adam"),
        limits = listOf(limit),
        limitsFetchedAt = lastHeartbeatAt,
        today = Tokens(input = 9),
        projectTokens = listOf(ProjectTokens("/g", "/g", Tokens(input = 9))),
        rules = listOf(PauseRule("r1", "all", PauseMode.SOFT, null, lastHeartbeatAt, "dashboard"))
    )

    @Test
    fun `aging a machine out forgets its readings but not who it is`() {
        val heard = now.minusSeconds(86_400)
        val dead = reporting(heard).aged(now.minusSeconds(1))
        assertEquals(Health.DEAD, dead.health)
        assertFalse(dead.gone)
        assertEquals(listOf(limit), dead.limits)

        val gone = dead.aged(now)
        assertTrue(gone.gone)
        assertTrue(gone.limits.isEmpty())
        assertNull(gone.limitsFetchedAt)
        assertEquals(Tokens.ZERO, gone.today)
        assertTrue(gone.sessions.isEmpty())
        assertTrue(gone.projectTokens.isEmpty())
        assertTrue(gone.rules.isEmpty())
        assertEquals("Adam", gone.user?.displayName)
        assertEquals("0.1.98", gone.version)
        assertEquals(heard, gone.lastHeartbeatAt)
    }

    @Test
    fun `an answer that lands while gone survives the next tick`() {
        val gone = reporting(now.minusSeconds(200_000)).aged(now)
        val answered = gone.copy(limits = listOf(limit.copy(percent = 7)))
        assertEquals(listOf(7), answered.aged(now.plusSeconds(1)).limits.map { it.percent })
    }

    @Test
    fun `a machine that needs a re-pair reads dead whatever its heartbeat says`() {
        val lost = reporting(now).copy(needsRepair = RepairReason("unauthorized", "rotated"))
        assertEquals(Health.DEAD, lost.aged(now).health)
        assertFalse(lost.aged(now).gone)
    }
}
