package com.evenseal.usagedeck.ui.components

import androidx.compose.foundation.Canvas
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.dp
import com.evenseal.usagedeck.ui.theme.DeckColors

/**
 * A 30-minute burn trace: filled area, line, endpoint dot. Deliberately axis-free — the numbers
 * next to it carry the magnitude, this only carries the shape.
 */
@Composable
fun Sparkline(series: List<Double>, modifier: Modifier, color: Color = DeckColors.accent) {
    Canvas(modifier = modifier) {
        if (series.size < 2 || size.width <= 0f || size.height <= 0f) return@Canvas

        val max = series.max()
        val min = series.min()
        val span = (max - min).takeIf { it > 0.0 } ?: 1.0
        val stepX = size.width / (series.size - 1)
        val strokeWidth = 1.5.dp.toPx()
        val inset = strokeWidth / 2f
        val usableHeight = (size.height - strokeWidth).coerceAtLeast(0f)

        val points = series.mapIndexed { index, value ->
            val y = inset + (1f - ((value - min) / span).toFloat()) * usableHeight
            Offset(index * stepX, y)
        }

        val area = Path().apply {
            moveTo(points.first().x, size.height)
            points.forEach { lineTo(it.x, it.y) }
            lineTo(points.last().x, size.height)
            close()
        }
        drawPath(area, color = color.copy(alpha = 0.18f))

        val line = Path().apply {
            moveTo(points.first().x, points.first().y)
            points.drop(1).forEach { lineTo(it.x, it.y) }
        }
        drawPath(line, color = color, style = Stroke(width = strokeWidth))

        drawCircle(color = color, radius = 2.dp.toPx(), center = points.last())
    }
}
