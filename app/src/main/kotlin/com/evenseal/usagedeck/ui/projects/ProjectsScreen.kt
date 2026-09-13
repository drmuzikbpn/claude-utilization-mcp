package com.evenseal.usagedeck.ui.projects

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
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.evenseal.usagedeck.core.model.ProjectView
import com.evenseal.usagedeck.ui.DeckViewModel
import com.evenseal.usagedeck.ui.Route
import com.evenseal.usagedeck.ui.components.Format
import com.evenseal.usagedeck.ui.theme.DeckColors
import com.evenseal.usagedeck.ui.theme.DeckType

/**
 * Every project the team touched today (spec §11.4). Live ones first; idle ones follow, dimmed,
 * carrying only what they spent.
 */
@Composable
fun ProjectsScreen(vm: DeckViewModel, onOpen: (Route) -> Unit, onBack: () -> Unit) {
    val team by vm.team.collectAsStateWithLifecycle()

    Column(modifier = Modifier.fillMaxSize().background(DeckColors.bg)) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .background(DeckColors.surface)
                .clickable(onClick = onBack)
                .padding(horizontal = 10.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp)
        ) {
            Text(text = "‹", color = DeckColors.accent, fontFamily = DeckType.text, fontSize = 18.sp)
            Text(
                text = "Projects",
                color = DeckColors.fg,
                fontFamily = DeckType.text,
                fontWeight = FontWeight.SemiBold,
                fontSize = 16.sp
            )
        }

        LazyColumn(modifier = Modifier.weight(1f)) {
            items(team.projects, key = { "${it.machineId}:${it.key}" }) { project ->
                ProjectRow(
                    project = project,
                    rate = project.sessions.sumOf { vm.rate(project.machineId, it.sessionId) },
                    onOpen = { onOpen(Route.Project(project.machineId, project.key)) }
                )
            }
        }
    }
}

@Composable
private fun ProjectRow(project: ProjectView, rate: Double, onOpen: () -> Unit) {
    val idle = project.isIdle
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .alpha(if (idle) IDLE_ALPHA else 1f)
            .clickable(onClick = onOpen)
            .padding(horizontal = 10.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = project.name,
                color = DeckColors.fg,
                fontFamily = DeckType.text,
                fontWeight = FontWeight.Medium,
                fontSize = 14.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
            Text(
                text = if (idle) "idle" else "${project.sessions.size} live",
                color = DeckColors.dim,
                fontFamily = DeckType.text,
                fontSize = 11.sp
            )
        }
        if (!idle) {
            Text(
                text = Format.ratePerMin(rate),
                color = DeckColors.muted,
                fontFamily = DeckType.numeral,
                fontSize = 15.sp
            )
        }
        Text(
            text = Format.tokens(project.todayTokens?.total ?: project.liveTokens.total),
            color = DeckColors.fg,
            fontFamily = DeckType.numeral,
            fontWeight = FontWeight.Medium,
            fontSize = 18.sp
        )
    }
}

private const val IDLE_ALPHA = 0.55f
