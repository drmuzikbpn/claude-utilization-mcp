package com.evenseal.usagedeck.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.evenseal.usagedeck.core.model.MachineState
import com.evenseal.usagedeck.ui.theme.DeckColors
import com.evenseal.usagedeck.ui.theme.DeckType

/**
 * A machine that stopped accepting this deck (`MachineState.needsRepair`): which one, why, and
 * how to fix it. Re-pair is a tap, so the card is amber, never red (red is for hold actions
 * only). [onRepair] gets the machine id; the pairing that follows replaces this same row.
 */
@Composable
fun RepairCard(machine: MachineState, onRepair: (String) -> Unit, modifier: Modifier = Modifier) {
    val reason = machine.needsRepair ?: return
    val name = machine.name ?: machine.config.name
    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 10.dp, vertical = 4.dp)
            .border(1.dp, DeckColors.warn, RoundedCornerShape(10.dp))
            .background(DeckColors.surface, RoundedCornerShape(10.dp))
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = "$name no longer accepts this deck",
                color = DeckColors.warn,
                fontFamily = DeckType.text,
                fontWeight = FontWeight.SemiBold,
                fontSize = 14.sp
            )
            Text(
                text = reason.message,
                color = DeckColors.fg,
                fontFamily = DeckType.text,
                fontSize = 12.sp,
                modifier = Modifier.padding(top = 2.dp)
            )
            Text(
                text = "On $name, run `claude-usage pair`, then scan its QR.",
                color = DeckColors.muted,
                fontFamily = DeckType.mono,
                fontSize = 11.sp,
                modifier = Modifier.padding(top = 2.dp)
            )
            // The deck can no longer lift its own pauses there; the Mac can.
            if (machine.rules.isNotEmpty()) {
                Text(
                    text = "If sessions on $name are stuck paused, run `claude-usage resume --all` there.",
                    color = DeckColors.muted,
                    fontFamily = DeckType.mono,
                    fontSize = 11.sp,
                    modifier = Modifier.padding(top = 2.dp)
                )
            }
        }
        Text(
            text = "Re-pair",
            color = DeckColors.fg,
            fontFamily = DeckType.text,
            fontWeight = FontWeight.Medium,
            fontSize = 14.sp,
            modifier = Modifier
                .border(1.dp, DeckColors.warn, RoundedCornerShape(10.dp))
                .clickable { onRepair(machine.config.id) }
                .padding(horizontal = 16.dp, vertical = 10.dp)
        )
    }
}
