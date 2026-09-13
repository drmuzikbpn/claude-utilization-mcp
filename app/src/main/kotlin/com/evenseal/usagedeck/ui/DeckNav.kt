package com.evenseal.usagedeck.ui

import android.content.res.Configuration
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalConfiguration
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.evenseal.usagedeck.service.DeckGraph
import com.evenseal.usagedeck.ui.ledger.LedgerScreen
import com.evenseal.usagedeck.ui.theme.DeckTheme
import com.evenseal.usagedeck.ui.widedock.WideDockScreen

/** Every destination the deck has. Portrait and landscape share all of them but Home. */
sealed interface Route {
    object Home : Route

    data class Project(val machineId: String, val key: String) : Route

    object Projects : Route

    data class Machine(val id: String) : Route

    object Wifi : Route

    object Settings : Route

    object Pairing : Route
}

internal object Dest {
    const val HOME = "home"
    const val PROJECTS = "projects"
    const val WIFI = "wifi"
    const val SETTINGS = "settings"
    const val PAIRING = "pairing"
    const val PROJECT = "project/{machineId}/{key}"
    const val MACHINE = "machine/{id}"

    fun path(route: Route): String = when (route) {
        Route.Home -> HOME
        Route.Projects -> PROJECTS
        Route.Wifi -> WIFI
        Route.Settings -> SETTINGS
        Route.Pairing -> PAIRING
        is Route.Project -> "project/${route.machineId.encode()}/${route.key.encode()}"
        is Route.Machine -> "machine/${route.id.encode()}"
    }

    /** Project keys are filesystem paths, so they must not be read as extra path segments. */
    private fun String.encode(): String = java.net.URLEncoder.encode(this, Charsets.UTF_8.name())

    fun decode(raw: String?): String = raw?.let { java.net.URLDecoder.decode(it, Charsets.UTF_8.name()) }.orEmpty()
}

/**
 * Home follows the orientation sensor: portrait is the Ledger, landscape is the Wide dock
 * (spec §5). Everything else is orientation-agnostic.
 */
@Composable
fun DeckNav(graph: DeckGraph, navController: NavHostController = rememberNavController()) {
    val vm = remember(graph) { DeckViewModel(graph) }
    // A kiosk has no back button and no crash dialog worth showing, so a navigation request for
    // a destination this build does not register is ignored rather than thrown.
    val open: (Route) -> Unit = { route ->
        val path = Dest.path(route)
        if (navController.graph.findNode(path) != null) navController.navigate(path)
    }

    val dim by vm.dimLevel.collectAsStateWithLifecycle()

    DeckTheme(dimLevel = dim) {
        NavHost(navController = navController, startDestination = Dest.HOME) {
            composable(Dest.HOME) {
                val landscape =
                    LocalConfiguration.current.orientation == Configuration.ORIENTATION_LANDSCAPE
                if (landscape) WideDockScreen(vm, open) else LedgerScreen(vm, open)
            }
        }
    }
}
