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
    fun `every machine lost is its own state, not an invitation to start a session`() {
        val team = TeamState(listOf(machine("studio", lost)))
        assertEquals(HomeEmpty.AllNeedRepair, HomeEmpty.of(team))
    }
}
