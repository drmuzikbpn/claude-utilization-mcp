package com.evenseal.usagedeck.ui.theme

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color

private val deckColorScheme = darkColorScheme(
    primary = DeckColors.accent,
    onPrimary = DeckColors.bg,
    secondary = DeckColors.frozen,
    background = DeckColors.bg,
    onBackground = DeckColors.fg,
    surface = DeckColors.surface,
    onSurface = DeckColors.fg,
    surfaceVariant = DeckColors.surface2,
    onSurfaceVariant = DeckColors.muted,
    outline = DeckColors.line,
    error = DeckColors.crit,
    onError = DeckColors.fg
)

/**
 * The only theme. [dimLevel] is a brightness multiplier, not an alpha: 1f is full brightness and
 * 0.35f is the night level from spec §5, applied as a black scrim over the whole deck so quiet
 * hours dim the panel without changing a single colour token.
 */
@Composable
fun DeckTheme(dimLevel: Float = 1f, content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = deckColorScheme, typography = deckTypography) {
        Box(modifier = Modifier.fillMaxSize().background(DeckColors.bg)) {
            CompositionLocalProvider(LocalContentColor provides DeckColors.fg) {
                content()
            }
            val scrim = (1f - dimLevel).coerceIn(0f, 1f)
            if (scrim > 0f) {
                Box(
                    modifier = Modifier
                        .matchParentSize()
                        .background(Color.Black.copy(alpha = scrim))
                )
            }
        }
    }
}
