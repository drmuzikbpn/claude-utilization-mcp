package com.evenseal.usagedeck.core.model

import java.time.Duration
import java.time.Instant

/** Heartbeat aging: fresh under 30 s, stale under 2 min, dead at or past 2 min (spec §7). */
object Aging {
    val FRESH: Duration = Duration.ofSeconds(30)
    val DEAD: Duration = Duration.ofSeconds(120)

    fun health(lastHeartbeatAt: Instant?, now: Instant): Health {
        if (lastHeartbeatAt == null) return Health.DEAD
        val age = Duration.between(lastHeartbeatAt, now)
        return when {
            age < FRESH -> Health.FRESH
            age < DEAD -> Health.STALE
            else -> Health.DEAD
        }
    }
}
