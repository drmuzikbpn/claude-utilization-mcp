// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck.ui.components

import com.evenseal.usagedeck.core.model.Health
import com.evenseal.usagedeck.core.model.MachineConfig
import com.evenseal.usagedeck.core.model.MachineState
import com.evenseal.usagedeck.core.model.RepairReason
import com.evenseal.usagedeck.core.model.TeamState
import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Test

class HomeEmptyTest {
    private val lost = RepairReason("unauthorized", "rotated")

    private fun machine(id: String, needsRepair: RepairReason? = null) = MachineState(
        config = MachineConfig(id, id, "192.168.1.10", 47291, "t"),
        health = if (needsRepair != null) Health.DEAD else Health.FRESH,
        lastHeartbeatAt = Instant.EPOCH,
        name = id,
        needsRepair = needsRepair
    )

    @Test
    fun `no sessions names only the machines that still accept the deck`() {
        val team = TeamState(listOf(machine("mbp"), machine("studio", lost)))
        assertEquals(HomeEmpty.NoSessions(listOf("mbp")), HomeEmpty.of(team))
    }

    @Test
    fun `a machine silent for a day is waited for again`() {
        val quiet = machine("studio").copy(health = Health.DEAD, gone = true)
        assertEquals(false, quiet.hasSnapshot)
        assertEquals(HomeEmpty.Connecting(listOf(quiet)), HomeEmpty.of(TeamState(listOf(quiet))))
        assertEquals(emptyList<Any>(), TeamState(listOf(quiet)).usersWithData())
        // With another machine reporting, the hint names only the ones that can show a session.
        assertEquals(HomeEmpty.NoSessions(listOf("mbp")), HomeEmpty.of(TeamState(listOf(machine("mbp"), quiet))))
    }

    @Test
    fun `every machine lost is its own state, not an invitation to start a session`() {
        val team = TeamState(listOf(machine("studio", lost)))
        assertEquals(HomeEmpty.AllNeedRepair, HomeEmpty.of(team))
    }
}
