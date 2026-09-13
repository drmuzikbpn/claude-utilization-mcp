package com.evenseal.usagedeck.ui

import android.content.res.Configuration
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.evenseal.usagedeck.core.model.TeamState
import com.evenseal.usagedeck.ui.theme.DeckTheme
import com.evenseal.usagedeck.ui.widedock.WideDockScreen
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class WideDockScreenTest {
    @get:Rule
    val compose = createComposeRule()

    private fun showLandscape(vm: DeckViewModel) {
        compose.setContent {
            val landscape = Configuration(LocalConfiguration.current).apply {
                orientation = Configuration.ORIENTATION_LANDSCAPE
            }
            CompositionLocalProvider(LocalConfiguration provides landscape) {
                DeckTheme { WideDockScreen(vm = vm, onOpen = {}) }
            }
        }
    }

    @Test
    fun theRailCarriesTheBigFiveHourNumeral() {
        showLandscape(fakeViewModel())
        compose.onNodeWithText("42").assertExists()
        compose.onNodeWithText("77").assertExists()
    }

    @Test
    fun theRailCarriesTheSevenDayNumeral() {
        showLandscape(fakeViewModel())
        compose.onNodeWithText("18").assertExists()
        compose.onNodeWithText("31").assertExists()
    }

    @Test
    fun theRailFooterShowsTheTeamTotalAndLiveCount() {
        showLandscape(fakeViewModel())
        compose.onNodeWithText("team today", substring = true).assertExists()
        compose.onNodeWithText("2 live", substring = true).assertExists()
    }

    @Test
    fun theBottomBarStillOffersPauseAll() {
        showLandscape(fakeViewModel())
        compose.onNodeWithText("Pause all").assertExists()
    }

    @Test
    fun noMachinesShowsThePairingPromptInBothPanes() {
        compose.setContent {
            DeckTheme {
                WideDockScreen(
                    vm = fakeViewModel(team = TeamState(emptyList())),
                    onOpen = {}
                )
            }
        }

        compose.onNodeWithText("No machines paired").assertExists()
        compose.onNodeWithText("nothing paired").assertExists()
        compose.onNodeWithText("Pair").assertExists()
    }

    @Test
    fun rowsLeadWithTheProjectNameAndCarryTheColumnCaptions() {
        compose.setContent { DeckTheme { WideDockScreen(vm = fakeViewModel(), onOpen = {}) } }

        compose.onNodeWithText("calendarpa").assertExists()
        compose.onNodeWithText("audioleveler").assertExists()
        compose.onNodeWithText("tok/min · 30m").assertExists()
        compose.onNodeWithText("a1b2… · 1.9M today", substring = true).assertExists()
    }
}
