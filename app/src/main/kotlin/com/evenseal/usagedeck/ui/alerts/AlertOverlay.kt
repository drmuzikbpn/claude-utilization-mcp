package com.evenseal.usagedeck.ui.alerts

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.evenseal.usagedeck.core.alerts.Alert
import com.evenseal.usagedeck.core.alerts.AlertKind
import com.evenseal.usagedeck.kiosk.DeckMode
import com.evenseal.usagedeck.ui.theme.DeckColors
import com.evenseal.usagedeck.ui.theme.DeckType

/**
 * The dock's full-screen alert (spec §5). It only appears on power: on battery the same alert
 * arrives as a heads-up notification, because nobody is looking at the screen. The 8 s timer is
 * [com.evenseal.usagedeck.alerts.Notifier]'s; a tap dismisses it early.
 */
@Composable
fun AlertOverlay(alert: Alert?, mode: DeckMode, onDismiss: () -> Unit) {
    if (alert == null || mode != DeckMode.DOCK) return
    val tint = colourOf(alert.kind)

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(DeckColors.bg.copy(alpha = SCRIM_ALPHA))
            .clickable(onClick = onDismiss),
        contentAlignment = Alignment.Center
    ) {
        Column(modifier = Modifier.padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Text(
                text = alert.title,
                color = tint,
                fontFamily = DeckType.numeral,
                fontWeight = FontWeight.Bold,
                fontSize = 40.sp,
                textAlign = TextAlign.Center
            )
            Text(
                modifier = Modifier.padding(top = 8.dp),
                text = alert.body,
                color = DeckColors.fg,
                fontFamily = DeckType.text,
                fontSize = 16.sp,
                textAlign = TextAlign.Center
            )
        }
    }
}

internal fun colourOf(kind: AlertKind): Color = when (kind) {
    AlertKind.WARN -> DeckColors.warn
    AlertKind.CRITICAL -> DeckColors.crit
    AlertKind.FROZEN -> DeckColors.frozen
    AlertKind.UNREACHABLE -> DeckColors.crit
}

private const val SCRIM_ALPHA = 0.94f
