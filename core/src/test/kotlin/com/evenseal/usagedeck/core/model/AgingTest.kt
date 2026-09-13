package com.evenseal.usagedeck.core.model

import java.time.Instant
import org.junit.Assert.assertEquals
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
}
