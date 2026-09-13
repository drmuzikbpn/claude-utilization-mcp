package com.evenseal.usagedeck.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.LocalViewConfiguration
import androidx.compose.ui.platform.ViewConfiguration
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.evenseal.usagedeck.ui.theme.DeckColors
import com.evenseal.usagedeck.ui.theme.DeckType

/**
 * The action strip: one primary action plus a handful of destinations. [onPrimaryHold] is the hard
 * variant of the primary action (freeze); when it is null the primary is a plain tap target.
 * [primaryDanger] tints the primary amber-to-red, and the red ring only appears mid-hold.
 */
@Composable
fun BottomBar(
    primary: String,
    primaryDanger: Boolean,
    onPrimary: () -> Unit,
    onPrimaryHold: (() -> Unit)?,
    secondary: List<Pair<String, () -> Unit>>,
    modifier: Modifier = Modifier
) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .background(DeckColors.surface)
            .padding(horizontal = 10.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        PrimaryAction(
            label = primary,
            danger = primaryDanger,
            onPrimary = onPrimary,
            onPrimaryHold = onPrimaryHold,
            modifier = Modifier.weight(1f)
        )
        secondary.forEach { (label, action) ->
            Text(
                modifier = Modifier
                    .clip(RoundedCornerShape(6.dp))
                    .background(DeckColors.surface2)
                    .clickable(onClick = action)
                    .padding(horizontal = 12.dp, vertical = 8.dp),
                text = label,
                color = DeckColors.fg,
                fontFamily = DeckType.text,
                fontWeight = FontWeight.Medium,
                fontSize = 14.sp
            )
        }
    }
}

@Composable
private fun PrimaryAction(
    label: String,
    danger: Boolean,
    onPrimary: () -> Unit,
    onPrimaryHold: (() -> Unit)?,
    modifier: Modifier
) {
    val haptics = LocalHapticFeedback.current
    var holding by remember { mutableStateOf(false) }
    val viewConfiguration = LocalViewConfiguration.current
    val holdConfiguration = remember(viewConfiguration) {
        object : ViewConfiguration by viewConfiguration {
            override val longPressTimeoutMillis: Long get() = PauseButtonDefaults.HOLD_MILLIS
        }
    }
    val tint = when {
        holding -> DeckColors.crit
        danger -> DeckColors.warn
        else -> DeckColors.fg
    }
    val longPress: ((Offset) -> Unit)? = onPrimaryHold?.let { hold ->
        { _: Offset ->
            haptics.performHapticFeedback(HapticFeedbackType.LongPress)
            hold()
        }
    }

    CompositionLocalProvider(LocalViewConfiguration provides holdConfiguration) {
        Text(
            modifier = modifier
                .clip(RoundedCornerShape(6.dp))
                .background(tint.copy(alpha = 0.15f))
                .pointerInput(onPrimaryHold) {
                    detectTapGestures(
                        onPress = {
                            holding = true
                            tryAwaitRelease()
                            holding = false
                        },
                        onTap = { onPrimary() },
                        onLongPress = longPress
                    )
                }
                .padding(horizontal = 12.dp, vertical = 8.dp),
            text = label,
            color = tint,
            fontFamily = DeckType.text,
            fontWeight = FontWeight.SemiBold,
            fontSize = 14.sp
        )
    }
}
