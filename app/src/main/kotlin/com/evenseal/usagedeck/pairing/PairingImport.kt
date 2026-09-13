package com.evenseal.usagedeck.pairing

import java.io.File

/**
 * Sideloaded pairing: a `pairing-import.json` dropped into the app's private files dir (by adb
 * `run-as` on a debug build, or by the end-to-end test) is consumed once at startup, exactly as
 * if its contents had been scanned as a QR. The file is deleted whether or not it parsed, so a
 * bad payload cannot be retried by accident and the token never lingers on disk.
 */
class PairingImport(private val filesDir: File, private val store: MachineStore) {
    sealed interface Result {
        object Nothing : Result

        data class Imported(val name: String) : Result

        data class Rejected(val reason: String) : Result
    }

    fun consume(): Result {
        val file = File(filesDir, FILE_NAME)
        if (!file.isFile) return Result.Nothing
        val raw = runCatching { file.readText() }.getOrElse { return Result.Rejected("unreadable") }
        file.delete()
        return PairingPayload.parse(raw).fold(
            onSuccess = { payload ->
                val existing = store.machines.value.firstOrNull { it.addr == payload.addr && it.port == payload.port }
                if (existing != null) store.remove(existing.id)
                store.add(payload.toConfig())
                Result.Imported(payload.name)
            },
            onFailure = { Result.Rejected(it.message ?: "invalid payload") }
        )
    }

    companion object {
        const val FILE_NAME = "pairing-import.json"
    }
}
