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
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
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
import com.evenseal.usagedeck.ui.components.HomeEmpty
import com.evenseal.usagedeck.ui.components.HomeEmptyBody
import com.evenseal.usagedeck.ui.components.MachineWaitRow
import com.evenseal.usagedeck.ui.components.SessionRow
import com.evenseal.usagedeck.ui.components.StatusBar
import com.evenseal.usagedeck.ui.components.usersWithData
import com.evenseal.usagedeck.ui.ledger.homeSecondary
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
    val empty = HomeEmpty.of(team)
    val showMachine = team.machines.size > 1

    Column(modifier = Modifier.fillMaxSize().background(DeckColors.bg)) {
        StatusBar(
            wifi = wifi,
            machines = team.machines,
            clock = now,
            alertChip = chip,
            onWifi = { onOpen(Route.Wifi) },
            onMachine = { id -> onOpen(Route.Machine(id)) }
        )

        Row(modifier = Modifier.weight(1f)) {
            Rail(team = team, now = now, modifier = Modifier.width(RAIL_WIDTH).fillMaxHeight())

            Column(modifier = Modifier.weight(1f).fillMaxHeight()) {
                if (empty != null) {
                    HomeEmptyBody(
                        empty = empty,
                        now = now,
                        onPair = { onOpen(Route.Pairing) },
                        modifier = Modifier.weight(1f)
                    )
                } else {
                    ColumnHeader(liveCount = team.liveSessionCount)
                    LazyColumn(modifier = Modifier.weight(1f)) {
                        team.projects.filter { it.sessions.isNotEmpty() }.forEach { project ->
                            items(project.sessions, key = { "${project.machineId}:${it.sessionId}" }) { session ->
                                val target = PauseTarget.Session(project.machineId, session.sessionId)
                                SessionRow(
                                    session = session,
                                    rate = vm.rate(project.machineId, session.sessionId),
                                    series = vm.series(project.machineId, session.sessionId),
                                    machineName = if (showMachine) team.machine(project.machineId)?.name else null,
                                    visual = vm.visual(target),
                                    now = now,
                                    onTap = { vm.tap(target) },
                                    onHold = { vm.hold(target) },
                                    onOpen = { onOpen(Route.Project(project.machineId, project.key)) },
                                    headline = project.name,
                                    compact = true
                                )
                            }
                        }
                    }
                }

                BottomBar(
                    primary = "Pause all",
                    primaryDanger = false,
                    onPrimary = { vm.tap(PauseTarget.All) },
                    onPrimaryHold = { vm.hold(PauseTarget.All) },
                    secondary = homeSecondary(empty, onOpen),
                    compact = true
                )
            }
        }
    }
}

/** The mockup's column captions: what the list is, and what the two numeric columns mean. */
@Composable
private fun ColumnHeader(liveCount: Int) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(DeckColors.surface2)
            .padding(horizontal = 10.dp, vertical = 3.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(
            text = "Sessions · $liveCount",
            color = DeckColors.muted,
            fontFamily = DeckType.text,
            fontWeight = FontWeight.Medium,
            fontSize = 11.sp,
            modifier = Modifier.weight(1f)
        )
        Text(
            text = "tok/min · 30m",
            color = DeckColors.dim,
            fontFamily = DeckType.text,
            fontSize = 10.sp
        )
    }
}

@Composable
private fun Rail(team: TeamState, now: Instant, modifier: Modifier) {
    Column(
        modifier = modifier
            .drawBehind {
                drawLine(
                    color = DeckColors.line,
                    start = Offset(size.width, 0f),
                    end = Offset(size.width, size.height),
                    strokeWidth = 1.dp.toPx()
                )
            }
            .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        Column(
            modifier = Modifier.weight(1f).verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            team.usersWithData().forEach { user -> RailUser(user = user, now = now) }
            if (team.usersWithData().isEmpty()) {
                Text(
                    text = if (team.machines.isEmpty()) "nothing paired" else "waiting for data",
                    color = DeckColors.dim,
                    fontFamily = DeckType.text,
                    fontSize = 12.sp
                )
                team.machines.forEach { MachineWaitRow(machine = it, now = now) }
            }
        }

        Text(
            text = "team today ${Format.tokens(team.teamToday.total)} · ${team.liveSessionCount} live",
            color = DeckColors.dim,
            fontFamily = DeckType.mono,
            fontSize = 10.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis
        )
    }
}

@Composable
private fun RailUser(user: UserView, now: Instant) {
    val faded = user.health != Health.FRESH
    Column(modifier = Modifier.fillMaxWidth().alpha(if (faded) STALE_ALPHA else 1f)) {
        Text(
            text = user.displayName.uppercase(),
            color = DeckColors.muted,
            fontFamily = DeckType.text,
            fontWeight = FontWeight.SemiBold,
            fontSize = 11.sp,
            letterSpacing = 1.2.sp
        )
        Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            BigNumber(limit = user.fiveHour, size = FIVE_HOUR_SP)
            BigNumber(limit = user.sevenDay, size = SEVEN_DAY_SP)
        }
        Text(
            text = "5h ${Format.resetsShort(user.fiveHour?.resetsAt, now, ZoneId.systemDefault())} · " +
                "7d ${Format.resetsShort(user.sevenDay?.resetsAt, now, ZoneId.systemDefault())}",
            color = DeckColors.dim,
            fontFamily = DeckType.mono,
            fontSize = 10.sp,
            maxLines = 1
        )
    }
}

/** The percent alone is the headline; no `%` sign, colour carries the state (mockup D). */
@Composable
private fun BigNumber(limit: Limit?, size: Int) {
    val color = limit?.let { DeckColors.of(it.status) } ?: DeckColors.dim
    Text(
        text = limit?.percent?.toString() ?: "—",
        color = color,
        fontFamily = DeckType.numeral,
        fontWeight = FontWeight.SemiBold,
        fontSize = size.sp,
        lineHeight = size.sp
    )
}

private val RAIL_WIDTH = 200.dp
private const val STALE_ALPHA = 0.55f
private const val FIVE_HOUR_SP = 64
private const val SEVEN_DAY_SP = 30
