package com.evenseal.usagedeck.ui.pairing

import android.app.Activity
import android.content.Intent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.evenseal.usagedeck.pairing.PairingPayload
import com.evenseal.usagedeck.pairing.QrScanActivity
import com.evenseal.usagedeck.ui.theme.DeckColors
import com.evenseal.usagedeck.ui.theme.DeckType

/**
 * Spec §6.3. The warning is the point of this screen: the QR is a bearer token, so it is scanned
 * off the Mac's own screen and rotated if it was ever photographed.
 */
@Composable
fun PairingScreen(onPaired: (PairingPayload, onResult: (String) -> Unit) -> Unit, onBack: () -> Unit) {
    val context = LocalContext.current
    var message by remember { mutableStateOf<String?>(null) }

    val scan = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        if (result.resultCode != Activity.RESULT_OK) return@rememberLauncherForActivityResult
        val raw = result.data?.getStringExtra(QrScanActivity.EXTRA_PAYLOAD).orEmpty()
        PairingPayload.parse(raw)
            .onSuccess { payload -> onPaired(payload) { message = it } }
            .onFailure { message = it.message ?: "That QR is not a pairing code." }
    }

    Column(modifier = Modifier.fillMaxSize().background(DeckColors.bg)) {
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
                text = "Pair a machine",
                color = DeckColors.fg,
                fontFamily = DeckType.text,
                fontWeight = FontWeight.SemiBold,
                fontSize = 16.sp
            )
        }

        Text(
            modifier = Modifier.padding(10.dp),
            text = QrScanActivity.WARNING,
            color = DeckColors.warn,
            fontFamily = DeckType.text,
            fontSize = 13.sp
        )

        Text(
            modifier = Modifier.padding(horizontal = 10.dp),
            text = "On the Mac: claude-usage configure pairing",
            color = DeckColors.muted,
            fontFamily = DeckType.mono,
            fontSize = 12.sp
        )

        TextButton(
            modifier = Modifier.padding(6.dp),
            onClick = { scan.launch(Intent(context, QrScanActivity::class.java)) }
        ) {
            Text("Scan QR", color = DeckColors.accent, fontFamily = DeckType.text, fontSize = 15.sp)
        }

        message?.let {
            Text(
                modifier = Modifier.padding(10.dp),
                text = it,
                color = DeckColors.fg,
                fontFamily = DeckType.text,
                fontSize = 13.sp
            )
        }
    }
}
