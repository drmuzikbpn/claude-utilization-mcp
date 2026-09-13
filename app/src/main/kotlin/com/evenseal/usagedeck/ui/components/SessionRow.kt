package com.evenseal.usagedeck.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.evenseal.usagedeck.core.model.Session
import com.evenseal.usagedeck.ui.theme.DeckColors
import com.evenseal.usagedeck.ui.theme.DeckType
import java.time.Instant

/**
 * One live session: short id, model and worktree tags, burn rate, 30-minute sparkline and the
 * pause control. Tapping the row opens the project drill-in; the pause control keeps its own
 * gesture grammar, so a tap there never opens anything.
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
            .padding(horizontal = 10.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        Column(modifier = Modifier.weight(1f)) {
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
                session.model?.let { Tag(text = it, color = DeckColors.accent) }
                session.worktree?.let { Tag(text = it, color = DeckColors.muted) }
                if (machineName != null) Tag(text = machineName, color = DeckColors.dim)
            }
            Text(
                text = subtitle(session, now),
                color = DeckColors.dim,
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
            modifier = Modifier.width(56.dp).height(20.dp)
        )

        PauseButton(visual = visual, onTap = onTap, onHold = onHold)
    }
}

/** Last tool call when the daemon reported one, otherwise how long the session has been quiet. */
private fun subtitle(session: Session, now: Instant): String {
    val tool = session.lastTool
    return if (tool != null) {
        "${tool.name} · ${Format.age(tool.at, now)}"
    } else {
        Format.age(session.lastActivityAt, now)
    }
}

@Composable
private fun Tag(text: String, color: Color) {
    Text(
        modifier = Modifier
            .clip(RoundedCornerShape(3.dp))
            .background(color.copy(alpha = 0.15f))
            .padding(horizontal = 4.dp, vertical = 1.dp),
        text = text,
        color = color,
        fontFamily = DeckType.text,
        fontSize = 10.sp,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis
    )
}
