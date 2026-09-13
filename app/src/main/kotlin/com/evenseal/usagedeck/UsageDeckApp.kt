package com.evenseal.usagedeck

import android.app.Application
import android.content.Context
import com.evenseal.usagedeck.pairing.encryptedPrefs
import com.evenseal.usagedeck.service.DeckGraph
import java.util.UUID

/**
 * Process-wide singletons. The graph is wired by hand; there is no DI framework in this app.
 */
class UsageDeckApp : Application() {
    /** Built lazily so tests that only need the Application do not spin up clients. */
    val graph: DeckGraph by lazy { DeckGraph(this) }

    /**
     * Stable per-phone id, minted on first run. Every pause this phone creates carries
     * `reason = "usage-deck:$installId"`, and only rules with that exact reason ever escalate.
     */
    val installId: String get() = installIdOf(this)

    /** The `reason` string the daemon stores on every pause rule this phone creates. */
    val pauseReason: String get() = "usage-deck:$installId"

    companion object {
        private const val PREFS_NAME = "usage_deck"
        private const val KEY_INSTALL_ID = "install_id"

        /** Mints the install id on first read and remembers it for the life of the process. */
        @Synchronized
        fun installIdOf(context: Context): String {
            cached?.let { return it }
            val prefs = encryptedPrefs(context, PREFS_NAME)
            val id = prefs.getString(KEY_INSTALL_ID, null) ?: UUID.randomUUID().toString().also {
                prefs.edit().putString(KEY_INSTALL_ID, it).apply()
            }
            cached = id
            return id
        }

        private var cached: String? = null
    }
}
