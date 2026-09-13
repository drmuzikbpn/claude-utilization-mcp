package com.evenseal.usagedeck.ui.ledger

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
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
import com.evenseal.usagedeck.ui.components.HomeEmpty
import com.evenseal.usagedeck.ui.components.HomeEmptyBody
import com.evenseal.usagedeck.ui.components.LimitBar
import com.evenseal.usagedeck.ui.components.PauseButton
import com.evenseal.usagedeck.ui.components.SessionRow
import com.evenseal.usagedeck.ui.components.Sparkline
import com.evenseal.usagedeck.ui.components.StatusBar
import com.evenseal.usagedeck.ui.components.Tag
import com.evenseal.usagedeck.ui.components.usersWithData
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
    val prefs by vm.settings.collectAsStateWithLifecycle()
    val expanded by vm.expanded.collectAsStateWithLifecycle()

    Column(modifier = Modifier.fillMaxSize().background(DeckColors.bg)) {
        StatusBar(
            wifi = wifi,
            machines = team.machines,
            clock = now,
            alertChip = chip,
            onWifi = { onOpen(Route.Wifi) },
            onMachine = { id -> onOpen(Route.Machine(id)) },
            use24h = prefs.clock24h
        )

        val empty = HomeEmpty.of(team)

        team.usersWithData().forEach { user ->
            UserBlock(user = user, now = now)
        }

        if (empty is HomeEmpty.NoMachines || empty is HomeEmpty.Connecting) {
            HomeEmptyBody(
                empty = empty,
                now = now,
                onPair = { onOpen(Route.Pairing) },
                modifier = Modifier.weight(1f)
            )
        } else {
            SessionsHeader(liveCount = team.liveSessionCount)

            if (empty is HomeEmpty.NoSessions) {
                HomeEmptyBody(
                    empty = empty,
                    now = now,
                    onPair = { onOpen(Route.Pairing) },
                    modifier = Modifier.weight(1f)
                )
            } else {
                LazyColumn(modifier = Modifier.weight(1f)) {
                    team.projects.filter { it.sessions.isNotEmpty() }.forEach { project ->
                        val open = "${project.machineId}|${project.key}" in expanded
                        item(key = "h:${project.machineId}:${project.key}") {
                            ProjectHeader(
                                vm = vm,
                                project = project,
                                now = now,
                                expanded = open,
                                onToggle = { vm.toggleExpanded(project.machineId, project.key) },
                                onOpen = onOpen
                            )
                        }
                        if (!open) return@forEach
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
            }
        }

        BottomBar(
            primary = "Pause all",
            primaryDanger = false,
            onPrimary = { vm.tap(PauseTarget.All) },
            onPrimaryHold = { vm.hold(PauseTarget.All) },
            secondary = homeSecondary(empty, onOpen)
        )
    }
}

/** With nothing paired, "Projects" is a dead end; offer "Pair" in its place. The gear opens Settings (wifi lives there). */
internal fun homeSecondary(empty: HomeEmpty?, onOpen: (Route) -> Unit): List<Pair<String, () -> Unit>> = listOf(
    if (empty is HomeEmpty.NoMachines) {
        "Pair" to { onOpen(Route.Pairing) }
    } else {
        "Projects" to { onOpen(Route.Projects) }
    },
    "Wifi" to { onOpen(Route.Wifi) }
)

/** A teammate's block fades to 55 % once their machine stops checking in (spec §11.1). */
@Composable
internal fun UserBlock(user: UserView, now: Instant, modifier: Modifier = Modifier) {
    val faded = user.health != Health.FRESH
    Column(
        modifier = modifier
            .fillMaxWidth()
            .alpha(if (faded) STALE_ALPHA else 1f)
            .padding(horizontal = 10.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp)
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
                text = if (faded) "last seen ${Format.age(user.limitsFetchedAt, now)}" else user.emailAddress.orEmpty(),
                color = DeckColors.dim,
                fontFamily = DeckType.mono,
                fontSize = 11.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(start = 12.dp).weight(1f, fill = false)
            )
        }
        LimitBar(label = "5h", limit = user.fiveHour, now = now)
        LimitBar(label = "7d", limit = user.sevenDay, now = now)
        if (user.scoped.isNotEmpty()) {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                user.scoped.forEach { limit ->
                    Tag(text = "${limit.scopeModel ?: limit.id} ${limit.percent}%", color = DeckColors.of(limit.status))
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

/**
 * A project row is the collapsed summary of its sessions: name, worktree count, live count, the
 * project's own burn rate and 30-minute sparkline, and a pause control for the whole project.
 * Tapping the row expands it to the individual sessions; `›` opens the drill-in.
 */
@Composable
internal fun ProjectHeader(
    vm: DeckViewModel,
    project: ProjectView,
    now: Instant,
    expanded: Boolean,
    onToggle: () -> Unit,
    onOpen: (Route) -> Unit
) {
    val target = PauseTarget.Project(project.machineId, project.key)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onToggle)
            .semantics { contentDescription = "${if (expanded) "collapse" else "expand"} ${project.name}" }
            .padding(start = 6.dp, end = 4.dp, top = 6.dp, bottom = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp)
    ) {
        Text(
            text = if (expanded) "▾" else "▸",
            color = DeckColors.dim,
            fontFamily = DeckType.text,
            fontSize = 12.sp,
            modifier = Modifier.width(12.dp)
        )
        Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(
                    text = project.name,
                    color = DeckColors.fg,
                    fontFamily = DeckType.text,
                    fontWeight = FontWeight.SemiBold,
                    fontSize = 13.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false)
                )
                if (project.worktreeCount > 1) Tag(text = "${project.worktreeCount} wt")
                Tag(text = "${project.sessions.size} live")
            }
            if (!expanded) {
                Text(
                    text = "${Format.tokens(project.liveTokens.total)} today",
                    color = DeckColors.muted,
                    fontFamily = DeckType.text,
                    fontSize = 11.sp
                )
            }
        }
        Text(
            text = Format.ratePerMin(vm.projectRate(project.machineId, project.key)),
            color = DeckColors.muted,
            fontFamily = DeckType.numeral,
            fontWeight = FontWeight.Medium,
            fontSize = 16.sp,
            textAlign = TextAlign.End,
            modifier = Modifier.width(74.dp)
        )
        Sparkline(
            series = vm.projectSparkline(project.machineId, project.key),
            modifier = Modifier.width(64.dp).height(20.dp)
        )
        PauseButton(
            visual = vm.visual(target),
            onTap = { vm.tap(target) },
            onHold = { vm.hold(target) }
        )
        Text(
            text = "›",
            color = DeckColors.accent,
            fontFamily = DeckType.text,
            fontSize = 22.sp,
            modifier = Modifier
                .clickable { onOpen(Route.Project(project.machineId, project.key)) }
                .semantics { contentDescription = "open ${project.name}" }
                .padding(horizontal = 8.dp, vertical = 4.dp)
        )
    }
}

private const val STALE_ALPHA = 0.55f
