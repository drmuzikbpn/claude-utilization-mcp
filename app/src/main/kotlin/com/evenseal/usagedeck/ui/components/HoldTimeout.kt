package com.evenseal.usagedeck.ui.components

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalViewConfiguration
import androidx.compose.ui.platform.ViewConfiguration

/**
 * Runs [content] with the platform long-press threshold replaced by the gesture grammar's hold
 * ([PauseButtonDefaults.HOLD_MILLIS]), so every hold on the deck — pause buttons, the bottom bar,
 * the rename long-press — fires at the same moment.
 */
@Composable
fun HoldTimeout(content: @Composable () -> Unit) {
    val viewConfiguration = LocalViewConfiguration.current
    val holdConfiguration = remember(viewConfiguration) {
        object : ViewConfiguration by viewConfiguration {
            override val longPressTimeoutMillis: Long get() = PauseButtonDefaults.HOLD_MILLIS
        }
    }
    CompositionLocalProvider(LocalViewConfiguration provides holdConfiguration, content = content)
}
