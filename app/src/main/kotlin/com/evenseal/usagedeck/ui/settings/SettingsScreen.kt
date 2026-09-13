package com.evenseal.usagedeck.ui.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Slider
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.evenseal.usagedeck.settings.CRITICAL_MAX
import com.evenseal.usagedeck.settings.ESCALATION_CHOICES
import com.evenseal.usagedeck.settings.Settings
import com.evenseal.usagedeck.settings.WARN_MAX
import com.evenseal.usagedeck.settings.WARN_MIN
import com.evenseal.usagedeck.ui.theme.DeckColors
import com.evenseal.usagedeck.ui.theme.DeckType
import java.time.LocalTime

/** Spec §11.5. Everything here is a deck-wide policy, so it all lives on one scrolling page. */
@Composable
fun SettingsScreen(
    settings: Settings,
    version: String,
    updateState: String,
    onUpdate: ((Settings) -> Settings) -> Unit,
    onSetPin: (String) -> Unit,
    onCheckUpdate: () -> Unit,
    onBack: () -> Unit,
    wifiLabel: String = "",
    onWifi: () -> Unit = {}
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(DeckColors.bg)
            .verticalScroll(rememberScrollState())
    ) {
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
                text = "Settings",
                color = DeckColors.fg,
                fontFamily = DeckType.text,
                fontWeight = FontWeight.SemiBold,
                fontSize = 16.sp
            )
        }

        Section("Network")
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clickable(onClick = onWifi)
                .padding(horizontal = 10.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                text = "Wifi",
                color = DeckColors.fg,
                fontFamily = DeckType.text,
                fontSize = 14.sp,
                modifier = Modifier.weight(1f)
            )
            Text(text = wifiLabel, color = DeckColors.muted, fontFamily = DeckType.mono, fontSize = 12.sp)
            Text(text = "  ›", color = DeckColors.accent, fontFamily = DeckType.text, fontSize = 18.sp)
        }

        Section("Display")
        ToggleRow(
            label = "Keep screen on",
            description = "Hold the screen on even when unplugged.",
            checked = settings.keepScreenOn,
            onChange = { on -> onUpdate { it.copy(keepScreenOn = on) } }
        )
        ToggleRow(
            label = "Auto-dim at night",
            description = "Dim to the night level during quiet hours.",
            checked = settings.autoDim,
            onChange = { on -> onUpdate { it.copy(autoDim = on) } }
        )
        ToggleRow(
            label = "24-hour clock",
            description = "Off shows 6:21 PM instead of 18:21.",
            checked = settings.clock24h,
            onChange = { on -> onUpdate { it.copy(clock24h = on) } }
        )

        Section("Alerts")
        ToggleRow(
            label = "Alert sound",
            description = "A soft chime when an alert shows. Quiet hours still silence it.",
            checked = settings.sound,
            onChange = { on -> onUpdate { it.copy(sound = on) } }
        )

        Section("Thresholds")
        SliderRow(
            label = "warn",
            value = settings.warn,
            range = WARN_MIN..WARN_MAX,
            description = WARN_SLIDER,
            onChange = { warn -> onUpdate { it.copy(warn = warn) } }
        )
        SliderRow(
            label = "critical",
            value = settings.critical,
            range = (settings.warn + 1)..CRITICAL_MAX,
            description = CRITICAL_SLIDER,
            onChange = { critical -> onUpdate { it.copy(critical = critical) } }
        )

        Section("Escalation")
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 10.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp)
        ) {
            ESCALATION_CHOICES.forEach { choice ->
                Choice(
                    label = choice?.let { "${it}s" } ?: "off",
                    selected = settings.escalationSeconds == choice,
                    onClick = { onUpdate { it.copy(escalationSeconds = choice) } }
                )
            }
        }

        Section("Quiet hours")
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 10.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            HourPicker(
                label = "from",
                time = settings.quietStart,
                onChange = { time -> onUpdate { it.copy(quietStart = time) } }
            )
            HourPicker(
                label = "to",
                time = settings.quietEnd,
                onChange = { time -> onUpdate { it.copy(quietEnd = time) } }
            )
        }
        SliderRow(
            label = "night dim",
            value = (settings.nightDim * PERCENT).toInt(),
            range = DIM_MIN_PERCENT..PERCENT,
            description = DIM_SLIDER,
            onChange = { percent -> onUpdate { it.copy(nightDim = percent / PERCENT.toFloat()) } }
        )

        Section("Kiosk exit PIN")
        PinField(isSet = settings.pinSet, onSetPin = onSetPin)

        Section("Updates")
        Text(
            modifier = Modifier.padding(horizontal = 10.dp),
            text = updateState,
            color = DeckColors.muted,
            fontFamily = DeckType.text,
            fontSize = 13.sp
        )
        TextButton(onClick = onCheckUpdate, modifier = Modifier.padding(horizontal = 6.dp)) {
            Text("Check for update now", color = DeckColors.accent, fontFamily = DeckType.text)
        }
        Text(
            modifier = Modifier.padding(10.dp),
            text = version,
            color = DeckColors.dim,
            fontFamily = DeckType.mono,
            fontSize = 11.sp
        )
    }
}

@Composable
private fun ToggleRow(label: String, description: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable { onChange(!checked) }
            .padding(horizontal = 10.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(text = label, color = DeckColors.fg, fontFamily = DeckType.text, fontSize = 14.sp)
            Text(text = description, color = DeckColors.dim, fontFamily = DeckType.text, fontSize = 11.sp)
        }
        Switch(
            checked = checked,
            onCheckedChange = onChange,
            colors = SwitchDefaults.colors(
                checkedThumbColor = DeckColors.fg,
                checkedTrackColor = DeckColors.accent,
                uncheckedThumbColor = DeckColors.muted,
                uncheckedTrackColor = DeckColors.surface2
            )
        )
    }
}

@Composable
private fun Section(title: String) {
    Text(
        modifier = Modifier
            .fillMaxWidth()
            .background(DeckColors.surface2)
            .padding(horizontal = 10.dp, vertical = 4.dp),
        text = title,
        color = DeckColors.muted,
        fontFamily = DeckType.text,
        fontWeight = FontWeight.Medium,
        fontSize = 12.sp
    )
}

@Composable
private fun SliderRow(label: String, value: Int, range: IntRange, description: String, onChange: (Int) -> Unit) {
    Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 4.dp)) {
        Text(
            text = "$label $value",
            color = DeckColors.fg,
            fontFamily = DeckType.text,
            fontSize = 13.sp
        )
        Slider(
            modifier = Modifier.semantics { contentDescription = description },
            value = value.coerceIn(range).toFloat(),
            valueRange = range.first.toFloat()..range.last.toFloat(),
            steps = (range.last - range.first - 1).coerceAtLeast(0),
            onValueChange = { onChange(it.toInt()) }
        )
    }
}

@Composable
private fun Choice(label: String, selected: Boolean, onClick: () -> Unit) {
    Text(
        modifier = Modifier
            .clip(RoundedCornerShape(4.dp))
            .background(if (selected) DeckColors.accent.copy(alpha = 0.2f) else DeckColors.surface)
            .clickable(onClick = onClick)
            .padding(horizontal = 8.dp, vertical = 6.dp),
        text = label,
        color = if (selected) DeckColors.accent else DeckColors.muted,
        fontFamily = DeckType.mono,
        fontSize = 12.sp
    )
}

@Composable
private fun HourPicker(label: String, time: LocalTime, onChange: (LocalTime) -> Unit) {
    Column {
        Text(text = label, color = DeckColors.dim, fontFamily = DeckType.text, fontSize = 11.sp)
        Row(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = { onChange(time.minusHours(1)) }) {
                Text("−", color = DeckColors.accent, fontFamily = DeckType.mono)
            }
            Text(
                text = "%02d:%02d".format(time.hour, time.minute),
                color = DeckColors.fg,
                fontFamily = DeckType.mono,
                fontSize = 14.sp
            )
            TextButton(onClick = { onChange(time.plusHours(1)) }) {
                Text("+", color = DeckColors.accent, fontFamily = DeckType.mono)
            }
        }
    }
}

@Composable
private fun PinField(isSet: Boolean, onSetPin: (String) -> Unit) {
    var entry by remember { mutableStateOf("") }
    Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 4.dp)) {
        Text(
            text = if (isSet) "A PIN is set. Enter six digits to change it." else "No PIN set yet.",
            color = DeckColors.muted,
            fontFamily = DeckType.text,
            fontSize = 12.sp
        )
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(
                modifier = Modifier.semantics { contentDescription = PIN_FIELD },
                value = entry,
                onValueChange = { entry = it.filter(Char::isDigit).take(PIN_LENGTH) },
                singleLine = true,
                visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword)
            )
            TextButton(
                enabled = entry.length == PIN_LENGTH,
                onClick = {
                    onSetPin(entry)
                    entry = ""
                }
            ) {
                Text("Save", color = DeckColors.accent, fontFamily = DeckType.text)
            }
        }
    }
}

const val WARN_SLIDER = "warn threshold"
const val CRITICAL_SLIDER = "critical threshold"
const val DIM_SLIDER = "night dim"
const val PIN_FIELD = "exit pin field"

private const val PIN_LENGTH = 6
private const val PERCENT = 100
private const val DIM_MIN_PERCENT = 10
