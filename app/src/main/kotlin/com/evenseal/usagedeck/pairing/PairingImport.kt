package com.evenseal.usagedeck.pairing

import com.evenseal.usagedeck.core.pairing.PairingInvite
import java.io.File

/**
 * Sideloaded pairing: a `pairing-import.json` dropped into one of [dirs] — the private files dir
 * (adb `run-as` on a debug build, or the end-to-end test) or the app's external files dir
 * (`adb push` on a release build, which `run-as` cannot reach) — is consumed once at startup,
 * exactly as if its contents had been scanned as a QR. The file is deleted whether or not it
 * parsed, so a bad payload cannot be retried by accident and the token never lingers on disk.
 *
 * It may hold the v1 JSON, stored at once, or a v2 `usagedeck://pair?...` link, which needs the
 * network: that comes back as [Result.Redeem] for the caller to hand to [InvitePairing] off the
 * main thread. The code is held only in that result, never written anywhere.
 */
class PairingImport(private val dirs: List<File>, private val store: MachineStore) {
    constructor(filesDir: File, store: MachineStore) : this(listOf(filesDir), store)

    sealed interface Result {
        object Nothing : Result

        data class Imported(val name: String) : Result

        data class Rejected(val reason: String) : Result

        data class Redeem(val invite: PairingInvite) : Result
    }

    fun consume(): Result {
        val file = dirs.map { File(it, FILE_NAME) }.firstOrNull { it.isFile } ?: return Result.Nothing
        val raw = runCatching { file.readText() }.getOrElse { return Result.Rejected("unreadable") }
        file.delete()
        return ScannedPairing.parse(raw).fold(
            onSuccess = { scanned ->
                when (scanned) {
                    is ScannedPairing.Legacy -> {
                        store.pair(scanned.payload.toConfig())
                        Result.Imported(scanned.payload.name)
                    }
                    is ScannedPairing.Invite -> Result.Redeem(scanned.invite)
                }
            },
            onFailure = { Result.Rejected(it.message ?: "invalid payload") }
        )
    }

    companion object {
        const val FILE_NAME = "pairing-import.json"
    }
}
