package com.evenseal.usagedeck.ui.components

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.evenseal.usagedeck.core.model.PauseMode
import com.evenseal.usagedeck.core.model.Session
import com.evenseal.usagedeck.ui.theme.DeckColors
import com.evenseal.usagedeck.ui.theme.DeckType
import java.time.Instant

/**
 * One live session, laid out as the Ledger mockup's row: identity and tags on the first line,
 * `today · last tool` on the second, then the burn rate, the 30-minute sparkline and the pause
 * control. Tapping the row opens the project drill-in; the pause control keeps its own gesture
 * grammar, so a tap there never opens anything.
 */
@Composable
fun SessionRow(
    session: Session,
    rate: Double,
    series: List<Double>,
    machineName: String?,
    visual: PauseVisual,
    now: Instant,
    onTap: () -> Unit,
    onHold: () -> Unit,
    onOpen: () -> Unit,
    modifier: Modifier = Modifier
) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .clickable(onClick = onOpen)
            .padding(horizontal = 10.dp, vertical = 7.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp)
            ) {
                Text(
                    text = Format.shortId(session.sessionId),
                    color = DeckColors.fg,
                    fontFamily = DeckType.mono,
                    fontWeight = FontWeight.Medium,
                    fontSize = 13.sp
                )
                if (session.pause?.mode == PauseMode.HARD) {
                    Tag(text = FROZEN_TAG, color = DeckColors.frozen)
                }
                session.worktree?.let { Tag(text = it) }
                Format.modelShort(session.model)?.let { Tag(text = it, color = DeckColors.accent) }
                if (machineName != null) Tag(text = Format.hostShort(machineName))
            }
            Text(
                text = subtitle(session, now),
                color = DeckColors.muted,
                fontFamily = DeckType.text,
                fontSize = 11.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
        }

        Text(
            text = Format.ratePerMin(rate),
            color = DeckColors.muted,
            fontFamily = DeckType.numeral,
            fontWeight = FontWeight.Medium,
            fontSize = 16.sp
        )

        Sparkline(
            series = series,
            modifier = Modifier.width(64.dp).height(20.dp)
        )

        PauseButton(visual = visual, onTap = onTap, onHold = onHold)
    }
}

/** `1.2M today · Read 4s ago`, falling back to how long the session has been quiet. */
private fun subtitle(session: Session, now: Instant): String {
    val today = "${Format.tokens(session.tokens.total)} today"
    val tool = session.lastTool
    return if (tool != null) {
        "$today · ${tool.name} ${Format.age(tool.at, now)}"
    } else {
        "$today · ${Format.age(session.lastActivityAt, now)}"
    }
}

/** A frozen session says so in words, not only in colour — the dock is read from a distance. */
const val FROZEN_TAG = "frozen"
