package com.evenseal.usagedeck.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.evenseal.usagedeck.core.model.UserView
import com.evenseal.usagedeck.ui.theme.DeckColors
import com.evenseal.usagedeck.ui.theme.DeckType

/** Edits the display name for one person. Saving a blank name goes back to what the daemon reports. */
@Composable
fun RenameDialog(user: UserView, current: String, onSave: (String) -> Unit, onDismiss: () -> Unit) {
    var entry by remember(user.key) { mutableStateOf(current) }
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = DeckColors.surface,
        titleContentColor = DeckColors.fg,
        textContentColor = DeckColors.muted,
        title = { Text(text = "Rename ${current.ifEmpty { user.displayName }}", fontFamily = DeckType.text) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    text = user.identity,
                    fontFamily = DeckType.mono,
                    fontSize = 11.sp
                )
                OutlinedTextField(
                    modifier = Modifier.fillMaxWidth().semantics { contentDescription = RENAME_FIELD },
                    value = entry,
                    onValueChange = { entry = it.take(NAME_LENGTH) },
                    singleLine = true,
                    placeholder = { Text(user.displayName, color = DeckColors.dim) }
                )
            }
        },
        confirmButton = {
            TextButton(onClick = { onSave(entry) }) {
                Text(RENAME_SAVE, color = DeckColors.accent, fontFamily = DeckType.text)
            }
        },
        dismissButton = {
            Row {
                if (current.isNotEmpty()) {
                    TextButton(onClick = { onSave("") }) {
                        Text(RENAME_RESET, color = DeckColors.muted, fontFamily = DeckType.text)
                    }
                }
                TextButton(onClick = onDismiss) {
                    Text("Cancel", color = DeckColors.muted, fontFamily = DeckType.text)
                }
            }
        }
    )
}

/** `alan@… · Even Seal Productions`: enough to tell one account's two organisations apart. */
val UserView.identity: String
    get() = listOfNotNull(emailAddress ?: machineIds.joinToString().ifEmpty { null }, organizationName)
        .joinToString(" · ")

const val RENAME_FIELD = "display name field"
const val RENAME_SAVE = "Save name"
const val RENAME_RESET = "Use daemon name"

private const val NAME_LENGTH = 24
