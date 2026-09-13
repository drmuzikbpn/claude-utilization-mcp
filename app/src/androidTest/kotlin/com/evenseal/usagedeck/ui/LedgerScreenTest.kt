package com.evenseal.usagedeck.ui

import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.evenseal.usagedeck.core.model.Health
import com.evenseal.usagedeck.core.model.TeamState
import com.evenseal.usagedeck.core.pause.Escalation
import com.evenseal.usagedeck.core.pause.PauseTarget
import com.evenseal.usagedeck.ui.components.PauseButtonDefaults
import com.evenseal.usagedeck.ui.ledger.LedgerScreen
import com.evenseal.usagedeck.ui.theme.DeckTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class LedgerScreenTest {
    @get:Rule
    val compose = createComposeRule()

    /**
     * `SessionRow` and the project header are both `clickable`, which merges their descendants'
     * semantics, so the pause controls are only addressable on the unmerged tree.
     */
    private fun pauseControls() = compose.onAllNodesWithContentDescription(
        PauseButtonDefaults.CONTENT_DESCRIPTION,
        useUnmergedTree = true
    )

    private fun show(vm: DeckViewModel) {
        compose.setContent { DeckTheme { LedgerScreen(vm = vm, onOpen = {}) } }
    }

    @Test
    fun showsBothUsersFiveHourPercentages() {
        show(fakeViewModel())

        compose.onNodeWithText("Alan").assertExists()
        compose.onNodeWithText("Sam").assertExists()
        compose.onNodeWithText("42%").assertExists()
        compose.onNodeWithText("77%").assertExists()
    }

    @Test
    fun showsTheLiveSessionCount() {
        show(fakeViewModel())
        compose.onNodeWithText("Sessions · 2 live").assertExists()
    }

    @Test
    fun aSoftPausedSessionShowsItsEscalationCountdown() {
        val scope = PauseTarget.Session("m1", "a1b2c3d4").scope()
        val actions = RecordingPauseActions(
            paused = setOf(scope),
            escalations = mapOf(scope to Escalation("m1", scope, Fx.NOW.plusSeconds(42)))
        )
        show(fakeViewModel(actions = actions))

        compose.onNodeWithText("0:42").assertExists()
    }

    @Test
    fun aDeadMachinesSessionPauseControlIsDisabled() {
        val team = TeamState(
            listOf(
                Fx.machine(
                    id = "m1",
                    name = "Alan",
                    email = "alan@evensealproductions.com",
                    fiveHour = 42,
                    sevenDay = 18,
                    health = Health.DEAD,
                    sessions = listOf(Fx.session("a1b2c3d4"))
                )
            )
        )
        show(fakeViewModel(team = team))

        val controls = pauseControls()
        val count = controls.fetchSemanticsNodes().size
        assertEquals(2, count)
        (0 until count).forEach { i -> controls[i].assertIsNotEnabled() }
    }

    @Test
    fun tappingASessionPauseCallsTapWithThatSessionsTarget() {
        val actions = RecordingPauseActions()
        show(fakeViewModel(actions = actions))

        // [0] is the first project header, [1] is that project's only session.
        pauseControls()[1].performClick()

        assertEquals(listOf(PauseTarget.Session("m1", "a1b2c3d4")), actions.taps)
    }

    @Test
    fun pauseAllUsesTheAllTarget() {
        val actions = RecordingPauseActions()
        show(fakeViewModel(actions = actions))

        compose.onNodeWithText("Pause all").performClick()

        assertEquals(listOf<PauseTarget>(PauseTarget.All), actions.taps)
    }
}
