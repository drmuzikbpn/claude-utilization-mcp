package com.evenseal.usagedeck.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.evenseal.usagedeck.core.model.Limit
import com.evenseal.usagedeck.ui.theme.DeckColors
import com.evenseal.usagedeck.ui.theme.DeckType
import java.time.Instant
import java.time.ZoneId

/**
 * One utilisation window: `5h` or `7d`, the bar, the percent and the reset caption.
 * A null [limit] means the daemon has not reported that window yet and renders as `—`.
 */
@Composable
fun LimitBar(
    label: String,
    limit: Limit?,
    now: Instant,
    modifier: Modifier = Modifier,
    zone: ZoneId = ZoneId.systemDefault()
) {
    val percent = limit?.percent?.coerceIn(0, 100)
    val color = limit?.let { DeckColors.of(it.status) } ?: DeckColors.dim

    Column(modifier = modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.Bottom
        ) {
            Text(
                text = label,
                color = DeckColors.muted,
                fontFamily = DeckType.text,
                fontWeight = FontWeight.Medium,
                fontSize = 13.sp
            )
            Text(
                text = percent?.let { "$it%" } ?: EMPTY,
                color = color,
                fontFamily = DeckType.numeral,
                fontWeight = FontWeight.SemiBold,
                fontSize = 22.sp
            )
        }

        Box(
            modifier = Modifier
                .padding(top = 3.dp)
                .fillMaxWidth()
                .height(6.dp)
                .clip(RoundedCornerShape(3.dp))
                .background(DeckColors.surface2)
        ) {
            if (percent != null && percent > 0) {
                Box(
                    modifier = Modifier
                        .fillMaxWidth(percent / 100f)
                        .height(6.dp)
                        .background(color)
                )
            }
        }

        Text(
            modifier = Modifier.padding(top = 2.dp),
            text = if (limit == null) EMPTY else Format.resets(limit.resetsAt, now, zone),
            color = DeckColors.dim,
            fontFamily = DeckType.text,
            fontSize = 11.sp
        )
    }
}

private const val EMPTY = "—"
