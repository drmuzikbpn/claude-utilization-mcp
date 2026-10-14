// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck.core.model

import java.time.Duration
import java.time.Instant

/**
 * Heartbeat aging: fresh under 30 s, stale under 2 min, dead at or past 2 min (spec §7).
 * A machine that has not checked in for a day is gone: it stays paired, but nothing it last
 * reported is shown any more.
 */
object Aging {
    val FRESH: Duration = Duration.ofSeconds(30)
    val DEAD: Duration = Duration.ofSeconds(120)
    val GONE: Duration = Duration.ofDays(1)

    fun health(lastHeartbeatAt: Instant?, now: Instant): Health {
        if (lastHeartbeatAt == null) return Health.DEAD
        val age = Duration.between(lastHeartbeatAt, now)
        return when {
            age < FRESH -> Health.FRESH
            age < DEAD -> Health.STALE
            else -> Health.DEAD
        }
    }

    /** A machine never heard from is still connecting, not gone: there is nothing of its to drop. */
    fun isGone(lastHeartbeatAt: Instant?, now: Instant): Boolean =
        lastHeartbeatAt != null && Duration.between(lastHeartbeatAt, now) >= GONE
}

/**
 * This state on [now]'s clock: health re-derived (a machine that needs a re-pair reads dead
 * whatever its heartbeat says) and, on the tick the machine turns [Aging.GONE], its readings
 * forgotten. Only on that tick, so an answer that lands just before the heartbeat it proves is
 * not wiped by the next one.
 */
fun MachineState.aged(now: Instant): MachineState {
    val health = if (needsRepair != null) Health.DEAD else Aging.health(lastHeartbeatAt, now)
    val silent = Aging.isGone(lastHeartbeatAt, now)
    if (!silent || gone) return copy(health = health, gone = silent)
    return copy(
        health = health,
        gone = true,
        limits = emptyList(),
        limitsFetchedAt = null,
        today = Tokens.ZERO,
        sessions = emptyList(),
        rules = emptyList(),
        projectTokens = emptyList()
    )
}
