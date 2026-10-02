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
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.LinearProgressIndicator
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
import com.evenseal.usagedeck.pairing.QrScanActivity
import com.evenseal.usagedeck.pairing.ReplaceCheck
import com.evenseal.usagedeck.pairing.ScannedPairing
import com.evenseal.usagedeck.ui.theme.DeckColors
import com.evenseal.usagedeck.ui.theme.DeckType

/** What the pairing screen shows under the button; [busy] while a redeem or probe is running. */
data class PairingStatus(val message: String, val busy: Boolean = false)

/** The row a Re-pair card asked to replace, with every name it goes by. */
data class ReplaceTarget(val id: String, val names: List<String>)

/**
 * Spec §6.3, daemon §23.47. The preferred QR comes from `claude-usage pair` and carries a one-time
 * code that is redeemed over pinned HTTPS; the legacy `claude-usage configure pairing` QR is a
 * bearer token, so it is scanned off the Mac's own screen and rotated if it was ever photographed.
 */
@Composable
fun PairingScreen(
    onScanned: (ScannedPairing, replace: Boolean, report: (PairingStatus) -> Unit) -> Unit,
    onBack: () -> Unit,
    redeeming: Boolean = false,
    replacing: ReplaceTarget? = null
) {
    val context = LocalContext.current
    var status by remember { mutableStateOf<PairingStatus?>(null) }
    // A QR from a different machine than the card's: held until the user says what it is.
    var confirming by remember { mutableStateOf<ScannedPairing?>(null) }
    val accept: (ScannedPairing) -> Unit = { scanned ->
        if (replacing != null && ReplaceCheck.needsConfirm(replacing.names, scanned.name)) {
            confirming = scanned
        } else {
            onScanned(scanned, replacing != null) { status = it }
        }
    }

    val scan = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        if (result.resultCode != Activity.RESULT_OK) return@rememberLauncherForActivityResult
        val raw = result.data?.getStringExtra(QrScanActivity.EXTRA_PAYLOAD).orEmpty()
        ScannedPairing.parse(raw)
            .onSuccess(accept)
            .onFailure { status = PairingStatus(it.message ?: "That QR is not a pairing code.") }
    }
    // [redeeming] comes from the graph, so a rotated or re-entered screen still knows a code is
    // being redeemed and cannot start a second one.
    val busy = status?.busy == true || redeeming

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
                text = replacing?.let { "Re-pair ${it.names.firstOrNull() ?: "machine"}" } ?: "Pair a machine",
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
            text = "On the Mac: claude-usage pair\n(older daemons: claude-usage configure pairing)",
            color = DeckColors.muted,
            fontFamily = DeckType.mono,
            fontSize = 12.sp
        )

        TextButton(
            modifier = Modifier.padding(6.dp),
            enabled = !busy,
            onClick = { scan.launch(Intent(context, QrScanActivity::class.java)) }
        ) {
            Text("Scan QR", color = DeckColors.accent, fontFamily = DeckType.text, fontSize = 15.sp)
        }

        if (busy) {
            LinearProgressIndicator(
                modifier = Modifier.fillMaxWidth().padding(horizontal = 10.dp),
                color = DeckColors.accent,
                trackColor = DeckColors.surface
            )
        }

        status?.let {
            Text(
                modifier = Modifier.padding(10.dp),
                text = it.message,
                color = DeckColors.fg,
                fontFamily = DeckType.text,
                fontSize = 13.sp
            )
        }
    }

    val pending = confirming
    if (pending != null && replacing != null) {
        ReplaceConfirmDialog(
            oldName = replacing.names.firstOrNull() ?: "this machine",
            newName = pending.name,
            onReplace = {
                confirming = null
                onScanned(pending, true) { status = it }
            },
            onKeepBoth = {
                confirming = null
                onScanned(pending, false) { status = it }
            },
            onCancel = { confirming = null }
        )
    }
}

/** Asked when the QR scanned from a Re-pair card names a different machine than the card's. */
@Composable
fun ReplaceConfirmDialog(
    oldName: String,
    newName: String,
    onReplace: () -> Unit,
    onKeepBoth: () -> Unit,
    onCancel: () -> Unit
) {
    AlertDialog(
        onDismissRequest = onCancel,
        containerColor = DeckColors.surface,
        title = { Text("Replace $oldName with $newName?", color = DeckColors.fg, fontFamily = DeckType.text) },
        text = {
            Text(
                text = "This QR is from $newName, but you were re-pairing $oldName. Replace swaps " +
                    "$oldName for $newName; Keep both pairs $newName as another machine.",
                color = DeckColors.muted,
                fontFamily = DeckType.text,
                fontSize = 13.sp
            )
        },
        confirmButton = {
            TextButton(onClick = onReplace) { Text("Replace", color = DeckColors.warn) }
        },
        dismissButton = {
            TextButton(onClick = onKeepBoth) { Text("Keep both", color = DeckColors.muted) }
        }
    )
}
