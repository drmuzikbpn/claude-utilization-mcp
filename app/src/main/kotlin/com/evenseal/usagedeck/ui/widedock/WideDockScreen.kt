package com.evenseal.usagedeck.ui.widedock

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.evenseal.usagedeck.core.model.Health
import com.evenseal.usagedeck.core.model.Limit
import com.evenseal.usagedeck.core.model.TeamState
import com.evenseal.usagedeck.core.model.UserView
import com.evenseal.usagedeck.core.pause.PauseTarget
import com.evenseal.usagedeck.ui.DeckViewModel
import com.evenseal.usagedeck.ui.Route
import com.evenseal.usagedeck.ui.components.BottomBar
import com.evenseal.usagedeck.ui.components.Format
import com.evenseal.usagedeck.ui.components.SessionRow
import com.evenseal.usagedeck.ui.components.StatusBar
import com.evenseal.usagedeck.ui.theme.DeckColors
import com.evenseal.usagedeck.ui.theme.DeckType
import java.time.Instant
import java.time.ZoneId

/**
 * Landscape home (spec §11.2). The rail carries numbers big enough to read from the other side
 * of the room; alerts land in the status bar rather than as a banner so nothing ever reflows.
 */
@Composable
fun WideDockScreen(vm: DeckViewModel, onOpen: (Route) -> Unit) {
    val team by vm.team.collectAsStateWithLifecycle()
    val now by vm.now.collectAsStateWithLifecycle()
    val wifi by vm.wifi.collectAsStateWithLifecycle()
    val chip by vm.alertChip.collectAsStateWithLifecycle()

    Row(modifier = Modifier.fillMaxSize().background(DeckColors.bg)) {
        Rail(team = team, now = now, modifier = Modifier.width(RAIL_WIDTH).fillMaxHeight())

        Column(modifier = Modifier.weight(1f).fillMaxHeight()) {
            StatusBar(
                wifi = wifi,
                machines = team.machines,
                clock = now,
                alertChip = chip,
                onWifi = { onOpen(Route.Wifi) },
                onMachine = { id -> onOpen(Route.Machine(id)) }
            )

            LazyColumn(modifier = Modifier.weight(1f)) {
                team.projects.filter { it.sessions.isNotEmpty() }.forEach { project ->
                    items(project.sessions, key = { "${project.machineId}:${it.sessionId}" }) { session ->
                        val target = PauseTarget.Session(project.machineId, session.sessionId)
                        SessionRow(
                            session = session,
                            rate = vm.rate(project.machineId, session.sessionId),
                            series = vm.series(project.machineId, session.sessionId),
                            machineName = project.name,
                            visual = vm.visual(target),
                            now = now,
                            onTap = { vm.tap(target) },
                            onHold = { vm.hold(target) },
                            onOpen = { onOpen(Route.Project(project.machineId, project.key)) }
                        )
                    }
                }
            }

            BottomBar(
                primary = "Pause all",
                primaryDanger = false,
                onPrimary = { vm.tap(PauseTarget.All) },
                onPrimaryHold = { vm.hold(PauseTarget.All) },
                secondary = listOf(
                    "Projects" to { onOpen(Route.Projects) },
                    "Wifi" to { onOpen(Route.Wifi) }
                )
            )
        }
    }
}

@Composable
private fun Rail(team: TeamState, now: Instant, modifier: Modifier) {
    Column(
        modifier = modifier
            .background(DeckColors.surface)
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 10.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        team.users.forEach { user -> RailUser(user = user, now = now) }

        Column(modifier = Modifier.fillMaxWidth().padding(top = 4.dp)) {
            Text(
                text = "team today",
                color = DeckColors.dim,
                fontFamily = DeckType.text,
                fontSize = 10.sp
            )
            Text(
                text = Format.tokens(team.teamToday.total),
                color = DeckColors.fg,
                fontFamily = DeckType.numeral,
                fontWeight = FontWeight.Medium,
                fontSize = 22.sp
            )
            Text(
                text = "${team.liveSessionCount} live",
                color = DeckColors.muted,
                fontFamily = DeckType.text,
                fontSize = 11.sp
            )
        }
    }
}

@Composable
private fun RailUser(user: UserView, now: Instant) {
    val faded = user.health != Health.FRESH
    Column(modifier = Modifier.fillMaxWidth().alpha(if (faded) STALE_ALPHA else 1f)) {
        Text(
            text = user.displayName,
            color = DeckColors.muted,
            fontFamily = DeckType.text,
            fontWeight = FontWeight.Medium,
            fontSize = 12.sp
        )
        BigNumber(limit = user.fiveHour, size = FIVE_HOUR_SP, now = now)
        BigNumber(limit = user.sevenDay, size = SEVEN_DAY_SP, now = now)
    }
}

/**
 * The percent alone is the headline; the `%` sign and the reset caption are deliberately much
 * smaller so the number is what carries across the room.
 */
@Composable
private fun BigNumber(limit: Limit?, size: Int, now: Instant) {
    val color = limit?.let { DeckColors.of(it.status) } ?: DeckColors.dim
    Row(verticalAlignment = Alignment.Bottom) {
        Text(
            text = limit?.percent?.toString() ?: "—",
            color = color,
            fontFamily = DeckType.numeral,
            fontWeight = FontWeight.SemiBold,
            fontSize = size.sp
        )
        Text(
            text = "%",
            color = color,
            fontFamily = DeckType.numeral,
            fontSize = (size / 3).sp,
            modifier = Modifier.padding(bottom = (size / 8).dp)
        )
    }
    Text(
        text = Format.resets(limit?.resetsAt, now, ZoneId.systemDefault()),
        color = DeckColors.dim,
        fontFamily = DeckType.text,
        fontSize = 10.sp
    )
}

private val RAIL_WIDTH = 200.dp
private const val STALE_ALPHA = 0.55f
private const val FIVE_HOUR_SP = 64
private const val SEVEN_DAY_SP = 30
