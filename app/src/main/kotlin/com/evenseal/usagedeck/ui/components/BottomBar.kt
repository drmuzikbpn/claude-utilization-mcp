package com.evenseal.usagedeck.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.evenseal.usagedeck.ui.theme.DeckColors
import com.evenseal.usagedeck.ui.theme.DeckType

/**
 * The action strip, drawn as the mockups' `.btn` buttons: 9 dp corners, a 1 dp border, text on
 * `surface`. The primary action is amber-bordered (`.btn.warn`) because it pauses something; the
 * ring goes red only while a hold is in progress. [onPrimaryHold] is the hard variant of the
 * primary action (freeze); when it is null the primary is a plain tap target.
 */
@Composable
fun BottomBar(
    primary: String,
    primaryDanger: Boolean,
    onPrimary: () -> Unit,
    onPrimaryHold: (() -> Unit)?,
    secondary: List<Pair<String, () -> Unit>>,
    modifier: Modifier = Modifier,
    compact: Boolean = false
) {
    val pad = if (compact) 6.dp else 10.dp
    Row(
        modifier = modifier
            .fillMaxWidth()
            .background(DeckColors.surface)
            .padding(horizontal = 10.dp, vertical = if (compact) 6.dp else 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        PrimaryAction(
            label = primary,
            danger = primaryDanger,
            onPrimary = onPrimary,
            onPrimaryHold = onPrimaryHold,
            pad = pad,
            modifier = Modifier.weight(1f)
        )
        secondary.forEach { (label, action) ->
            DeckButton(label = label, onClick = action, pad = pad)
        }
    }
}

/** A secondary (`.btn.ghost`) button: bordered, transparent, neutral text. */
@Composable
fun DeckButton(label: String, onClick: () -> Unit, modifier: Modifier = Modifier, pad: Dp = 10.dp) {
    Box(
        modifier = modifier
            .clip(BUTTON_SHAPE)
            .border(1.dp, DeckColors.line, BUTTON_SHAPE)
            .clickable(onClick = onClick)
            .padding(horizontal = 14.dp, vertical = pad),
        contentAlignment = Alignment.Center
    ) {
        Text(
            text = label,
            color = DeckColors.fg,
            fontFamily = DeckType.text,
            fontWeight = FontWeight.Medium,
            fontSize = 14.sp
        )
    }
}

@Composable
private fun PrimaryAction(
    label: String,
    danger: Boolean,
    onPrimary: () -> Unit,
    onPrimaryHold: (() -> Unit)?,
    pad: Dp,
    modifier: Modifier
) {
    val haptics = LocalHapticFeedback.current
    var holding by remember { mutableStateOf(false) }
    val tint = when {
        holding -> DeckColors.crit
        danger -> DeckColors.crit
        else -> DeckColors.warn
    }
    val longPress: ((Offset) -> Unit)? = onPrimaryHold?.let { hold ->
        { _: Offset ->
            haptics.performHapticFeedback(HapticFeedbackType.LongPress)
            hold()
        }
    }

    HoldTimeout {
        Box(
            modifier = modifier
                .clip(BUTTON_SHAPE)
                .background(DeckColors.surface2)
                .border(if (holding) 2.dp else 1.dp, tint.copy(alpha = if (holding) 0.9f else 0.45f), BUTTON_SHAPE)
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
                .padding(horizontal = 14.dp, vertical = pad),
            contentAlignment = Alignment.CenterStart
        ) {
            Text(
                text = label,
                color = tint,
                fontFamily = DeckType.text,
                fontWeight = FontWeight.SemiBold,
                fontSize = 14.sp
            )
        }
    }
}

private val BUTTON_SHAPE = RoundedCornerShape(9.dp)
