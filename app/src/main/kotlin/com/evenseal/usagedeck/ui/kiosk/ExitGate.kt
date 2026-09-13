package com.evenseal.usagedeck.ui.kiosk

import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalViewConfiguration
import androidx.compose.ui.platform.ViewConfiguration
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.evenseal.usagedeck.core.Clock
import com.evenseal.usagedeck.kiosk.ExitPin
import com.evenseal.usagedeck.ui.components.Format
import com.evenseal.usagedeck.ui.theme.DeckColors
import com.evenseal.usagedeck.ui.theme.DeckType

/**
 * The only way out of the kiosk (spec §4): an invisible corner that needs a three-second hold,
 * then the six-digit PIN. Invisible and slow on purpose — a guest poking the screen must never
 * find it, and a technician who knows about it always can.
 */
@Composable
fun ExitGate(pin: ExitPin, clock: Clock, onUnlocked: () -> Unit, modifier: Modifier = Modifier) {
    var prompting by remember { mutableStateOf(false) }
    val viewConfiguration = LocalViewConfiguration.current
    val holdConfiguration = remember(viewConfiguration) {
        object : ViewConfiguration by viewConfiguration {
            override val longPressTimeoutMillis: Long get() = ExitGateDefaults.HOLD_MILLIS
        }
    }

    CompositionLocalProvider(LocalViewConfiguration provides holdConfiguration) {
        Box(
            modifier = modifier
                .size(CORNER_SIZE)
                .background(Color.Transparent)
                .semantics { contentDescription = ExitGateDefaults.CONTENT_DESCRIPTION }
                .pointerInput(Unit) {
                    detectTapGestures(onLongPress = { prompting = true })
                }
        )
    }

    if (prompting) {
        PinDialog(
            pin = pin,
            clock = clock,
            onDismiss = { prompting = false },
            onUnlocked = {
                prompting = false
                onUnlocked()
            }
        )
    }
}

@Composable
private fun PinDialog(pin: ExitPin, clock: Clock, onDismiss: () -> Unit, onUnlocked: () -> Unit) {
    var entry by remember { mutableStateOf("") }
    var message by remember { mutableStateOf<String?>(null) }
    val configured = pin.isSet()

    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = DeckColors.surface,
        title = {
            Text(
                text = if (configured) "Maintenance exit" else "Set an exit PIN first",
                color = DeckColors.fg,
                fontFamily = DeckType.text
            )
        },
        text = {
            Column {
                if (configured) {
                    OutlinedTextField(
                        value = entry,
                        onValueChange = { entry = it.filter(Char::isDigit).take(PIN_LENGTH) },
                        label = { Text("PIN") },
                        singleLine = true,
                        visualTransformation = PasswordVisualTransformation(),
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword)
                    )
                } else {
                    Text(
                        text = "Settings → kiosk exit PIN. Until one is set the deck can only be " +
                            "unpinned over adb.",
                        color = DeckColors.muted,
                        fontFamily = DeckType.text,
                        fontSize = 13.sp
                    )
                }
                message?.let {
                    Text(
                        modifier = Modifier.semantics { contentDescription = ExitGateDefaults.ERROR_DESCRIPTION },
                        text = it,
                        color = DeckColors.crit,
                        fontFamily = DeckType.text,
                        fontSize = 12.sp
                    )
                }
            }
        },
        confirmButton = {
            TextButton(
                enabled = configured,
                onClick = {
                    when (val result = pin.verify(entry)) {
                        ExitPin.Result.Ok -> onUnlocked()
                        is ExitPin.Result.Wrong ->
                            message = "Wrong PIN · ${result.remaining} left"
                        is ExitPin.Result.LockedOut ->
                            message = "Locked out for ${Format.countdown(result.until, clock.now())}"
                    }
                    entry = ""
                }
            ) {
                Text("Unlock", color = DeckColors.accent)
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("Cancel", color = DeckColors.muted) }
        }
    )
}

object ExitGateDefaults {
    const val CONTENT_DESCRIPTION = "kiosk exit gate"
    const val ERROR_DESCRIPTION = "kiosk exit error"

    /** Spec §4: three seconds, so the corner is never found by accident. */
    const val HOLD_MILLIS = 3_000L
}

private const val PIN_LENGTH = 6
private val CORNER_SIZE = 48.dp
