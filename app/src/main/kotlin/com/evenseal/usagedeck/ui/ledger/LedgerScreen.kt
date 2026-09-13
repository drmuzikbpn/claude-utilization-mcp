package com.evenseal.usagedeck.ui.ledger

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
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
import com.evenseal.usagedeck.core.model.ProjectView
import com.evenseal.usagedeck.core.model.UserView
import com.evenseal.usagedeck.core.pause.PauseTarget
import com.evenseal.usagedeck.ui.DeckViewModel
import com.evenseal.usagedeck.ui.Route
import com.evenseal.usagedeck.ui.components.BottomBar
import com.evenseal.usagedeck.ui.components.Format
import com.evenseal.usagedeck.ui.components.LimitBar
import com.evenseal.usagedeck.ui.components.PauseButton
import com.evenseal.usagedeck.ui.components.SessionRow
import com.evenseal.usagedeck.ui.components.StatusBar
import com.evenseal.usagedeck.ui.theme.DeckColors
import com.evenseal.usagedeck.ui.theme.DeckType
import java.time.Instant

/** Portrait home (spec §11.1): who is burning what, right now, grouped by project. */
@Composable
fun LedgerScreen(vm: DeckViewModel, onOpen: (Route) -> Unit) {
    val team by vm.team.collectAsStateWithLifecycle()
    val now by vm.now.collectAsStateWithLifecycle()
    val wifi by vm.wifi.collectAsStateWithLifecycle()
    val chip by vm.alertChip.collectAsStateWithLifecycle()

    Column(modifier = Modifier.fillMaxSize().background(DeckColors.bg)) {
        StatusBar(
            wifi = wifi,
            machines = team.machines,
            clock = now,
            alertChip = chip,
            onWifi = { onOpen(Route.Wifi) },
            onMachine = { id -> onOpen(Route.Machine(id)) }
        )

        team.users.forEach { user ->
            UserBlock(user = user, now = now)
        }

        SessionsHeader(liveCount = team.liveSessionCount)

        LazyColumn(modifier = Modifier.weight(1f)) {
            team.projects.filter { it.sessions.isNotEmpty() }.forEach { project ->
                item(key = "h:${project.machineId}:${project.key}") {
                    ProjectHeader(vm = vm, project = project, now = now, onOpen = onOpen)
                }
                items(project.sessions, key = { "${project.machineId}:${it.sessionId}" }) { session ->
                    val target = PauseTarget.Session(project.machineId, session.sessionId)
                    SessionRow(
                        session = session,
                        rate = vm.rate(project.machineId, session.sessionId),
                        series = vm.series(project.machineId, session.sessionId),
                        machineName = null,
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

/** A teammate's block fades to 55 % once their machine stops checking in (spec §11.1). */
@Composable
internal fun UserBlock(user: UserView, now: Instant, modifier: Modifier = Modifier) {
    val faded = user.health != Health.FRESH
    Column(
        modifier = modifier
            .fillMaxWidth()
            .alpha(if (faded) STALE_ALPHA else 1f)
            .padding(horizontal = 10.dp, vertical = 6.dp)
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                text = user.displayName,
                color = DeckColors.fg,
                fontFamily = DeckType.text,
                fontWeight = FontWeight.SemiBold,
                fontSize = 15.sp
            )
            Text(
                text = user.emailAddress ?: "last seen ${Format.age(user.limitsFetchedAt, now)}",
                color = DeckColors.dim,
                fontFamily = DeckType.text,
                fontSize = 11.sp
            )
        }
        Row(
            modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            Column(modifier = Modifier.weight(1f)) {
                LimitBar(label = "5h", limit = user.fiveHour, now = now)
            }
            Column(modifier = Modifier.weight(1f)) {
                LimitBar(label = "7d", limit = user.sevenDay, now = now)
            }
        }
        if (user.scoped.isNotEmpty()) {
            Row(
                modifier = Modifier.padding(top = 4.dp),
                horizontalArrangement = Arrangement.spacedBy(6.dp)
            ) {
                user.scoped.forEach { limit ->
                    Text(
                        text = "${limit.scopeModel ?: limit.id} ${limit.percent}%",
                        color = DeckColors.of(limit.status),
                        fontFamily = DeckType.mono,
                        fontSize = 10.sp
                    )
                }
            }
        }
    }
}

@Composable
private fun SessionsHeader(liveCount: Int) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(DeckColors.surface2)
            .padding(horizontal = 10.dp, vertical = 4.dp),
        horizontalArrangement = Arrangement.SpaceBetween
    ) {
        Text(
            text = "Sessions · $liveCount live",
            color = DeckColors.muted,
            fontFamily = DeckType.text,
            fontWeight = FontWeight.Medium,
            fontSize = 12.sp
        )
        Text(
            text = "tokens/min · 30m",
            color = DeckColors.dim,
            fontFamily = DeckType.text,
            fontSize = 11.sp
        )
    }
}

@Composable
internal fun ProjectHeader(vm: DeckViewModel, project: ProjectView, now: Instant, onOpen: (Route) -> Unit) {
    val target = PauseTarget.Project(project.machineId, project.key)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable { onOpen(Route.Project(project.machineId, project.key)) }
            .padding(horizontal = 10.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp)
    ) {
        Text(
            text = project.name,
            color = DeckColors.fg,
            fontFamily = DeckType.text,
            fontWeight = FontWeight.SemiBold,
            fontSize = 13.sp,
            modifier = Modifier.weight(1f)
        )
        if (project.worktreeCount > 1) {
            Text(
                text = "${project.worktreeCount} wt",
                color = DeckColors.muted,
                fontFamily = DeckType.mono,
                fontSize = 10.sp
            )
        }
        PauseButton(
            visual = vm.visual(target),
            onTap = { vm.tap(target) },
            onHold = { vm.hold(target) }
        )
    }
}

private const val STALE_ALPHA = 0.55f
