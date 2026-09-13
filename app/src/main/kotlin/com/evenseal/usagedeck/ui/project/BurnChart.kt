package com.evenseal.usagedeck.ui.project

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.evenseal.usagedeck.ui.components.Format
import com.evenseal.usagedeck.ui.theme.DeckColors
import com.evenseal.usagedeck.ui.theme.DeckType
import kotlin.math.floor
import kotlin.math.log10
import kotlin.math.pow
import kotlin.math.roundToLong

/**
 * The five-hour burn chart from spec §11.3. One y scale, three gridlines and an endpoint dot —
 * the point is the shape of the last five hours, not precise readings.
 */
@Composable
fun BurnChart(series: List<Double>, modifier: Modifier) {
    val max = series.maxOrNull() ?: 0.0
    Column(modifier = modifier) {
        Row(modifier = Modifier.fillMaxWidth()) {
            Text(
                text = Format.tokens(oneSigFig(max)),
                color = DeckColors.dim,
                fontFamily = DeckType.mono,
                fontSize = 10.sp
            )
        }
        Box(modifier = Modifier.fillMaxWidth().weight(1f)) {
            Canvas(modifier = Modifier.fillMaxSize()) {
                val gridColor = DeckColors.line
                (1..GRIDLINES).forEach { i ->
                    val y = size.height * i / (GRIDLINES + 1f)
                    drawLine(gridColor, Offset(0f, y), Offset(size.width, y), strokeWidth = 1f)
                }
                if (series.size < 2 || max <= 0.0) return@Canvas

                val stepX = size.width / (series.size - 1)
                val stroke = 1.5.dp.toPx()
                val usable = (size.height - stroke).coerceAtLeast(0f)
                val points = series.mapIndexed { index, value ->
                    val y = stroke / 2f + (1f - (value / max).toFloat()) * usable
                    Offset(index * stepX, y)
                }

                val area = Path().apply {
                    moveTo(points.first().x, size.height)
                    points.forEach { lineTo(it.x, it.y) }
                    lineTo(points.last().x, size.height)
                    close()
                }
                drawPath(area, color = DeckColors.accent.copy(alpha = 0.18f))

                val line = Path().apply {
                    moveTo(points.first().x, points.first().y)
                    points.drop(1).forEach { lineTo(it.x, it.y) }
                }
                drawPath(line, color = DeckColors.accent, style = Stroke(width = stroke))
                drawCircle(DeckColors.accent, radius = 2.5.dp.toPx(), center = points.last())
            }
            Text(
                modifier = Modifier.align(Alignment.BottomStart),
                text = "0",
                color = DeckColors.dim,
                fontFamily = DeckType.mono,
                fontSize = 10.sp
            )
        }
        Row(
            modifier = Modifier.fillMaxWidth().padding(top = 2.dp),
            horizontalArrangement = androidx.compose.foundation.layout.Arrangement.SpaceBetween
        ) {
            Text(
                text = "−5h",
                color = DeckColors.dim,
                fontFamily = DeckType.mono,
                fontSize = 10.sp
            )
            Text(
                text = "−2h30",
                color = DeckColors.dim,
                fontFamily = DeckType.mono,
                fontSize = 10.sp
            )
            Text(
                text = "now",
                color = DeckColors.dim,
                fontFamily = DeckType.mono,
                fontSize = 10.sp
            )
        }
    }
}

/** 38 210 → 40 000, so the top gridline reads as a round number rather than a measurement. */
internal fun oneSigFig(value: Double): Long {
    if (value <= 0.0) return 0
    val magnitude = 10.0.pow(floor(log10(value)))
    return ((value / magnitude).roundToLong() * magnitude).roundToLong()
}

private const val GRIDLINES = 3
