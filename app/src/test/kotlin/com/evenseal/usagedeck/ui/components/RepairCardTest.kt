package com.evenseal.usagedeck.ui.components

import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.evenseal.usagedeck.core.model.Health
import com.evenseal.usagedeck.core.model.MachineConfig
import com.evenseal.usagedeck.core.model.MachineState
import com.evenseal.usagedeck.core.model.RepairReason
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29])
class RepairCardTest {
    @get:Rule
    val compose = createComposeRule()

    private val machine = MachineState(
        config = MachineConfig("m1", "studio.local", "192.168.1.195", 47291, "t"),
        health = Health.DEAD,
        name = "studio",
        needsRepair = RepairReason("unauthorized", "It rejected this deck's token — it was probably rotated.")
    )

    @Test
    fun `says which machine, why, and what to run`() {
        compose.setContent { RepairCard(machine = machine, onRepair = {}) }

        compose.onNodeWithText("studio no longer accepts this deck").assertExists()
        compose.onNodeWithText("It rejected this deck's token — it was probably rotated.").assertExists()
        compose.onNodeWithText("On studio, run `claude-usage pair`, then scan its QR.").assertExists()
    }

    @Test
    fun `re-pair opens pairing for that machine`() {
        var opened: String? = null
        compose.setContent { RepairCard(machine = machine, onRepair = { opened = it }) }

        compose.onNodeWithText("Re-pair").performClick()

        assertEquals("m1", opened)
    }
}
