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
import androidx.compose.ui.text.style.TextAlign
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
    modifier: Modifier = Modifier,
    /** When set (the wide dock), the row leads with this — the project — and the session name moves to the subtitle. */
    headline: String? = null,
    /** The wide dock's denser row: tighter padding, smaller type, a 30 dp pause control. */
    compact: Boolean = false
) {
    val name = session.title ?: Format.shortId(session.sessionId)
    val lead = headline ?: name
    Row(
        modifier = modifier
            .fillMaxWidth()
            .clickable(onClick = onOpen)
            .padding(horizontal = 10.dp, vertical = if (compact) 4.dp else 7.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        Column(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(if (compact) 1.dp else 3.dp)
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp)
            ) {
                Text(
                    text = lead,
                    color = DeckColors.fg,
                    fontFamily = if (headline != null || session.title != null) DeckType.text else DeckType.mono,
                    fontWeight = FontWeight.Medium,
                    fontSize = if (compact) 12.sp else 13.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false)
                )
                if (session.pause?.mode == PauseMode.HARD) {
                    Tag(text = FROZEN_TAG, color = DeckColors.frozen)
                }
                session.worktree?.let { Tag(text = it) }
                Format.modelShort(session.model)?.let { Tag(text = it, color = DeckColors.accent) }
                if (machineName != null) Tag(text = Format.hostShort(machineName))
            }
            Text(
                text = subtitle(session, now, if (headline != null) name else null),
                color = DeckColors.muted,
                fontFamily = DeckType.text,
                fontSize = if (compact) 10.sp else 11.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
        }

        Text(
            text = Format.ratePerMin(rate),
            color = DeckColors.muted,
            fontFamily = DeckType.numeral,
            fontWeight = FontWeight.Medium,
            fontSize = if (compact) 14.sp else 16.sp,
            textAlign = TextAlign.End,
            modifier = Modifier.width(RATE_WIDTH)
        )

        Sparkline(
            series = series,
            modifier = Modifier.width(64.dp).height(if (compact) 18.dp else 20.dp)
        )

        PauseButton(visual = visual, size = if (compact) 30.dp else 34.dp, onTap = onTap, onHold = onHold)
    }
}

/**
 * `1.2M today · Read 4s ago`, falling back to how long the session has been quiet. A titled
 * session keeps its short id here so two renamed sessions can still be told apart.
 */
private fun subtitle(session: Session, now: Instant, lead: String?): String {
    val prefix = lead ?: if (session.title != null) Format.shortId(session.sessionId) else null
    val today = "${prefix?.let { "$it · " } ?: ""}${Format.tokens(session.tokens.total)} today"
    val tool = session.lastTool
    return if (tool != null) {
        "$today · ${tool.name} ${Format.age(tool.at, now)}"
    } else {
        "$today · ${Format.age(session.lastActivityAt, now)}"
    }
}

/** A frozen session says so in words, not only in colour — the dock is read from a distance. */
const val FROZEN_TAG = "frozen"

/** Rates line up in a column so the sparklines and controls do too. */
private val RATE_WIDTH = 74.dp
