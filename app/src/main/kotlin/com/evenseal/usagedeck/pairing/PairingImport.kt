// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck.pairing

import com.evenseal.usagedeck.core.pairing.PairingInvite
import java.io.File

/**
 * Sideloaded pairing: a `pairing-import.json` holding the `usagedeck://pair?...` link that
 * `claude-usage pair` prints, dropped into one of [dirs], is consumed once — exactly as if the
 * link had been scanned as a QR. Only that link is accepted: it carries a one-time code, never
 * the bearer.
 *
 * The file is deleted before its contents are used, whether or not they parse, and an import
 * whose file cannot be deleted is refused: a code that could be replayed from disk, or a file
 * that would be offered again on every poll, must not pair anything. Nothing is stored here —
 * the link comes back as [Result.Redeem] for [PairingImports] to redeem, after asking first if
 * it would replace a machine.
 */
class PairingImport(private val dirs: List<File>, private val delete: (File) -> Boolean = File::delete) {
    sealed interface Result {
        object Nothing : Result

        data class Rejected(val reason: String) : Result

        data class Redeem(val invite: PairingInvite) : Result
    }

    /** Whether a file is waiting, without touching it. */
    fun waiting(): Boolean = find() != null

    fun consume(): Result {
        val file = find() ?: return Result.Nothing
        val raw = if (file.length() > MAX_BYTES) null else runCatching { file.readText() }.getOrNull()
        if (!delete(file) || file.exists()) {
            return Result.Rejected("the import file could not be deleted, so it was not used")
        }
        if (raw == null) return Result.Rejected("the import file is unreadable or too large")
        return PairingInvite.parse(raw).fold(
            onSuccess = { Result.Redeem(it) },
            onFailure = { Result.Rejected(it.message ?: "not a pairing link") }
        )
    }

    private fun find(): File? = dirs.map { File(it, FILE_NAME) }.firstOrNull { it.isFile }

    companion object {
        const val FILE_NAME = "pairing-import.json"

        /** A pairing link is a few hundred bytes. */
        const val MAX_BYTES = 8L * 1024

        private const val LOGGABLE_LENGTH = 64

        /**
         * Where a build looks for the file. The app's private files dir always — only the app
         * itself, or `run-as` on a debuggable build, can write there. The external files dir is
         * writable by anything with `adb` (and, before Android 11, by other apps holding the
         * storage permission), so only a [debuggable] build watches it; a release build pairs by
         * scanning the QR.
         */
        fun watched(filesDir: File, externalFilesDir: File?, debuggable: Boolean): List<File> =
            if (debuggable) listOfNotNull(filesDir, externalFilesDir) else listOf(filesDir)

        /**
         * [text] from a pairing (a machine name, a rejection reason, a daemon hint) made safe for
         * logcat: control characters dropped so it cannot forge log lines, and length capped.
         */
        fun loggable(text: String): String = text.filterNot(Char::isISOControl).take(LOGGABLE_LENGTH)
    }
}
