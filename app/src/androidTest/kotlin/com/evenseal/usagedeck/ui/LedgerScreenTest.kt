package com.evenseal.usagedeck.ui

import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.evenseal.usagedeck.core.model.Health
import com.evenseal.usagedeck.core.model.MachineConfig
import com.evenseal.usagedeck.core.model.MachineState
import com.evenseal.usagedeck.core.model.TeamState
import com.evenseal.usagedeck.core.pause.Escalation
import com.evenseal.usagedeck.core.pause.PauseTarget
import com.evenseal.usagedeck.settings.Settings
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

    /** Projects start collapsed; the tests that look at session rows open them first. */
    private fun expand(vararg projects: String) {
        projects.forEach { name ->
            val headers = compose.onAllNodesWithContentDescription("expand $name")
            if (headers.fetchSemanticsNodes().isNotEmpty()) headers[0].performClick()
        }
    }

    @Test
    fun showsBothUsersFiveHourPercentages() {
        show(fakeViewModel())

        // The name appears in the user block and again in the status-bar machine chip.
        compose.onAllNodesWithText("Alan").assertCountEquals(2)
        compose.onAllNodesWithText("Sam").assertCountEquals(2)
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
        expand("calendarpa", "audioleveler")

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
        expand("calendarpa", "audioleveler")

        val controls = pauseControls()
        val count = controls.fetchSemanticsNodes().size
        assertEquals(2, count)
        (0 until count).forEach { i -> controls[i].assertIsNotEnabled() }
    }

    @Test
    fun tappingASessionPauseCallsTapWithThatSessionsTarget() {
        val actions = RecordingPauseActions()
        show(fakeViewModel(actions = actions))
        expand("calendarpa", "audioleveler")

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

    @Test
    fun noMachinesShowsThePairingPromptInsteadOfABlankList() {
        var opened: Route? = null
        compose.setContent {
            DeckTheme { LedgerScreen(vm = fakeViewModel(team = TeamState(emptyList())), onOpen = { opened = it }) }
        }

        compose.onNodeWithText("No machines paired").assertExists()
        compose.onNodeWithText("Pair a machine").performClick()
        assertEquals(Route.Pairing, opened)
        compose.onNodeWithText("Pair").assertExists()
    }

    @Test
    fun aPairedButUnreachableMachineShowsItsNameAndError() {
        val waiting = MachineState(
            config = MachineConfig("m1", "studio.local", "192.168.1.50", 47291, "t"),
            health = Health.DEAD,
            lastError = "Token rejected. Re-run pairing on the Mac."
        )
        show(fakeViewModel(team = TeamState(listOf(waiting))))

        compose.onNodeWithText("Waiting for machine").assertExists()
        compose.onNodeWithText("studio.local").assertExists()
        compose.onNodeWithText("Token rejected. Re-run pairing on the Mac.").assertExists()
        compose.onNodeWithText("192.168.1.50:47291").assertExists()
    }

    @Test
    fun liveMachinesWithNoSessionsShowTheHintNotABlankList() {
        val quiet = TeamState(
            listOf(
                Fx.machine("m1", "alan-mbp", "alan@example.com", fiveHour = 12, sevenDay = 30)
            )
        )
        show(fakeViewModel(team = quiet))

        compose.onNodeWithText("No live sessions").assertExists()
        compose.onNodeWithText("Sessions · 0 live").assertExists()
        compose.onNodeWithText("12%").assertExists()
    }

    @Test
    fun aRenamedSessionShowsItsTitleInsteadOfItsId() {
        val titled = Fx.session("a1b2c3d4").copy(title = "Jamie - Android OS")
        val team = TeamState(
            listOf(
                Fx.machine("m1", "Alan", "alan@example.com", fiveHour = 12, sevenDay = 30, sessions = listOf(titled))
            )
        )
        show(fakeViewModel(team = team))
        expand("calendarpa")

        compose.onNodeWithText("Jamie - Android OS").assertExists()
        compose.onNodeWithText("a1b2… · 1.9M today", substring = true).assertExists()
    }

    @Test
    fun projectsStartCollapsedWithASummaryAndExpandOnTap() {
        show(fakeViewModel())

        // Both fixture projects burn 1.9M, so each collapsed header carries the summary line.
        compose.onAllNodesWithText("1.9M today").assertCountEquals(2)
        compose.onAllNodesWithText("a1b2…").assertCountEquals(0)
        expand("calendarpa")
        compose.onNodeWithText("a1b2…").assertExists()
        compose.onNodeWithContentDescription("collapse calendarpa").assertExists()
    }

    @Test
    fun userBlocksStartFoldedToOneLineAndUnfoldOnTap() {
        show(fakeViewModel())

        compose.onNodeWithText("42%").assertExists()
        compose.onNodeWithText("alan@evensealproductions.com").assertDoesNotExist()
        compose.onNodeWithContentDescription("expand Alan").performClick()
        compose.onNodeWithText("alan@evensealproductions.com").assertExists()
        compose.onNodeWithContentDescription("collapse Alan").assertExists()
        compose.onNodeWithText("sam@evensealproductions.com").assertDoesNotExist()
    }

    @Test
    fun aRenamedUserShowsTheDeckNameInsteadOfTheDaemons() {
        show(fakeViewModel(settings = Settings(userNames = mapOf("uuid-m1" to "Studio"))))

        compose.onNodeWithContentDescription("expand Studio").assertExists()
        compose.onNodeWithContentDescription("expand Sam").assertExists()
        // The machine chip keeps the machine's own name; only the person is renamed.
        compose.onAllNodesWithText("Alan").assertCountEquals(1)
    }
}
