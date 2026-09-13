package com.evenseal.usagedeck.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.evenseal.usagedeck.core.model.Health
import com.evenseal.usagedeck.core.model.MachineState
import com.evenseal.usagedeck.core.model.TeamState
import com.evenseal.usagedeck.ui.theme.DeckColors
import com.evenseal.usagedeck.ui.theme.DeckType
import java.time.Instant

/** What the home screens show instead of a blank list. Decided once here so Ledger and Wide dock agree. */
sealed interface HomeEmpty {
    /** Nothing has ever been paired: the only useful thing to do is pair. */
    object NoMachines : HomeEmpty

    /** Machines are paired but none has delivered a snapshot yet (or all have gone dead). */
    data class Connecting(val machines: List<MachineState>) : HomeEmpty

    /** Data is flowing; there is simply nothing running. */
    data class NoSessions(val machineNames: List<String>) : HomeEmpty

    companion object {
        fun of(team: TeamState): HomeEmpty? = when {
            team.machines.isEmpty() -> NoMachines
            team.machines.none { it.hasSnapshot } -> Connecting(team.machines)
            team.liveSessionCount == 0 ->
                NoSessions(team.machines.map { it.name ?: it.config.name })
            else -> null
        }
    }
}

/** A machine has "arrived" once anything from its snapshot is in hand; before that its user block would be all dashes. */
val MachineState.hasSnapshot: Boolean
    get() = user != null || limits.isNotEmpty() || sessions.isNotEmpty() || lastHeartbeatAt != null

/** The users worth a block: those with at least one machine that has delivered a snapshot. */
fun TeamState.usersWithData() = users.filter { u -> u.machineIds.any { machine(it)?.hasSnapshot == true } }

/** Centered title + body + optional single action. Fills whatever space it is given. */
@Composable
fun EmptyState(
    title: String,
    body: String,
    modifier: Modifier = Modifier,
    action: Pair<String, () -> Unit>? = null,
    detail: @Composable (() -> Unit)? = null
) {
    Column(
        modifier = modifier.fillMaxSize().padding(horizontal = 28.dp, vertical = 24.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Text(
            text = title,
            color = DeckColors.fg,
            fontFamily = DeckType.numeral,
            fontWeight = FontWeight.SemiBold,
            fontSize = 26.sp,
            textAlign = TextAlign.Center
        )
        Text(
            text = body,
            color = DeckColors.muted,
            fontFamily = DeckType.text,
            fontSize = 13.sp,
            textAlign = TextAlign.Center,
            lineHeight = 19.sp,
            modifier = Modifier.padding(top = 8.dp)
        )
        detail?.let {
            Column(modifier = Modifier.fillMaxWidth().padding(top = 16.dp)) { it() }
        }
        action?.let { (label, onClick) ->
            Text(
                text = label,
                color = DeckColors.fg,
                fontFamily = DeckType.text,
                fontWeight = FontWeight.Medium,
                fontSize = 14.sp,
                modifier = Modifier
                    .padding(top = 20.dp)
                    .border(1.dp, DeckColors.accent, RoundedCornerShape(10.dp))
                    .background(DeckColors.surface, RoundedCornerShape(10.dp))
                    .clickable(onClick = onClick)
                    .padding(horizontal = 22.dp, vertical = 12.dp)
            )
        }
    }
}

/** One row per paired machine while we wait for it: name, its state, and the last error if any. */
@Composable
fun MachineWaitRow(machine: MachineState, now: Instant, modifier: Modifier = Modifier) {
    val label = machine.name ?: machine.config.name
    val error = machine.lastError
    val status =
        when {
            error != null -> error
            machine.health == Health.DEAD && machine.lastHeartbeatAt == null -> "connecting…"
            machine.health == Health.DEAD -> "last heard ${Format.age(machine.lastHeartbeatAt, now)}"
            else -> "waiting for first snapshot…"
        }
    Row(
        modifier = modifier
            .fillMaxWidth()
            .background(DeckColors.surface, RoundedCornerShape(10.dp))
            .padding(horizontal = 12.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = label,
                color = DeckColors.fg,
                fontFamily = DeckType.text,
                fontWeight = FontWeight.Medium,
                fontSize = 13.sp
            )
            Text(
                text = status,
                color = if (error != null) DeckColors.warn else DeckColors.muted,
                fontFamily = DeckType.mono,
                fontSize = 11.sp,
                modifier = Modifier.padding(top = 2.dp)
            )
        }
        Text(
            text = "${machine.config.addr}:${machine.config.port}",
            color = DeckColors.dim,
            fontFamily = DeckType.mono,
            fontSize = 10.sp
        )
    }
}

/** The shared empty-state body for both home screens. Returns nothing when there is data to show. */
@Composable
fun HomeEmptyBody(empty: HomeEmpty, now: Instant, onPair: () -> Unit, modifier: Modifier = Modifier) {
    when (empty) {
        HomeEmpty.NoMachines ->
            EmptyState(
                title = "No machines paired",
                body =
                "On a Mac running the claude-usage daemon, run\n" +
                    "claude-usage configure pairing\nand scan the QR code it prints.",
                action = "Pair a machine" to onPair,
                modifier = modifier
            )
        is HomeEmpty.Connecting ->
            EmptyState(
                title = "Waiting for ${if (empty.machines.size == 1) "machine" else "machines"}",
                body = "Paired, but no data yet. Check the daemon is running and this phone is on the same network.",
                modifier = modifier,
                detail = {
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        empty.machines.forEach { MachineWaitRow(machine = it, now = now) }
                    }
                }
            )
        is HomeEmpty.NoSessions ->
            EmptyState(
                title = "No live sessions",
                body =
                "Start a Claude Code session on ${empty.machineNames.joinToString(" or ")} " +
                    "and it appears here.",
                modifier = modifier
            )
    }
}
