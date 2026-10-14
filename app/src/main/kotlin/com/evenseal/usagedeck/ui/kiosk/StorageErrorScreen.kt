// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck.ui.kiosk

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.evenseal.usagedeck.ui.theme.DeckColors
import com.evenseal.usagedeck.ui.theme.DeckType

/**
 * All the deck shows when the AndroidKeyStore cannot open its encrypted store. There is nothing
 * to tap: the tokens are either safe behind a key that is gone, or absent, and the deck will not
 * start again on an unencrypted copy.
 */
@Composable
fun StorageErrorScreen() {
    Column(
        modifier = Modifier.fillMaxSize().background(DeckColors.bg).padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp, alignment = androidx.compose.ui.Alignment.CenterVertically)
    ) {
        Text(
            text = "Secure storage is unavailable",
            color = DeckColors.warn,
            fontFamily = DeckType.text,
            fontWeight = FontWeight.SemiBold,
            fontSize = 20.sp
        )
        Text(
            text = "This phone's keystore could not open Usage Deck's encrypted store, and the deck " +
                "will not keep pairing tokens unencrypted, so it has not started.",
            color = DeckColors.fg,
            fontFamily = DeckType.text,
            fontSize = 14.sp
        )
        Text(
            text = "Restart the phone. If this screen comes back, the keystore was reset: clear the " +
                "app's data over adb and pair each machine again with `claude-usage pair`.",
            color = DeckColors.muted,
            fontFamily = DeckType.text,
            fontSize = 13.sp
        )
    }
}
