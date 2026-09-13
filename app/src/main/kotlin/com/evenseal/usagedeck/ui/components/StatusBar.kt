package com.evenseal.usagedeck.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.evenseal.usagedeck.core.model.Health
import com.evenseal.usagedeck.core.model.MachineState
import com.evenseal.usagedeck.ui.theme.DeckColors
import com.evenseal.usagedeck.ui.theme.DeckType
import com.evenseal.usagedeck.wifi.WifiStatus
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

private val CLOCK: DateTimeFormatter = DateTimeFormatter.ofPattern("HH:mm", Locale.UK)

/**
 * The one-line header every screen carries: wifi chip, clock, one dot per machine, and the alert
 * chip when something needs attention. Alerts appear here rather than as a banner so the wide dock
 * never reflows (spec §11.2).
 */
@Composable
fun StatusBar(
    wifi: WifiStatus,
    machines: List<MachineState>,
    clock: Instant,
    alertChip: String?,
    onWifi: () -> Unit,
    onMachine: (String) -> Unit,
    modifier: Modifier = Modifier,
    zone: ZoneId = ZoneId.systemDefault()
) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .background(DeckColors.surface)
            .padding(horizontal = 10.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        WifiChip(wifi = wifi, onClick = onWifi)

        if (alertChip != null) {
            Chip(text = alertChip, color = DeckColors.warn)
        }

        Box(modifier = Modifier.weight(1f))

        machines.forEach { machine ->
            MachineDot(machine = machine, onClick = { onMachine(machine.config.id) })
        }

        Text(
            text = CLOCK.format(clock.atZone(zone)),
            color = DeckColors.fg,
            fontFamily = DeckType.numeral,
            fontWeight = FontWeight.Medium,
            fontSize = 16.sp
        )
    }
}

@Composable
private fun WifiChip(wifi: WifiStatus, onClick: () -> Unit) {
    val color = if (wifi.connected) DeckColors.muted else DeckColors.crit
    val label = if (wifi.connected) {
        "${wifi.ssid.orEmpty()} ${bars(wifi.bars)}"
    } else {
        "no wifi"
    }
    Text(
        modifier = Modifier
            .clip(RoundedCornerShape(4.dp))
            .clickable(onClick = onClick)
            .padding(horizontal = 6.dp, vertical = 2.dp),
        text = label,
        color = color,
        fontFamily = DeckType.text,
        fontWeight = FontWeight.Medium,
        fontSize = 12.sp
    )
}

@Composable
private fun Chip(text: String, color: Color) {
    Text(
        modifier = Modifier
            .clip(RoundedCornerShape(4.dp))
            .background(color.copy(alpha = 0.15f))
            .padding(horizontal = 6.dp, vertical = 2.dp),
        text = text,
        color = color,
        fontFamily = DeckType.text,
        fontWeight = FontWeight.Medium,
        fontSize = 12.sp
    )
}

@Composable
private fun MachineDot(machine: MachineState, onClick: () -> Unit) {
    val color = when (machine.health) {
        Health.FRESH -> DeckColors.ok
        Health.STALE -> DeckColors.warn
        Health.DEAD -> DeckColors.crit
    }
    Box(
        modifier = Modifier
            .clip(CircleShape)
            .clickable(onClick = onClick)
            .padding(3.dp)
            .size(8.dp)
            .clip(CircleShape)
            .background(color)
    )
}

/** Four signal bars as block characters, so the chip needs no icon assets. */
private fun bars(level: Int): String {
    val filled = level.coerceIn(0, 4)
    return "▂▄▆█".take(filled).padEnd(4, '·')
}
