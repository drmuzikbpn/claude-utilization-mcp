package com.evenseal.usagedeck

import android.app.Application
import com.evenseal.usagedeck.pairing.encryptedPrefs
import java.util.UUID

/**
 * Process-wide singletons. The graph is wired by hand; there is no DI framework in this app.
 */
class UsageDeckApp : Application() {
    private val prefs by lazy { encryptedPrefs(this, PREFS_NAME) }

    /**
     * Stable per-phone id, minted on first run. Every pause this phone creates carries
     * `reason = "usage-deck:$installId"`, and only rules with that exact reason ever escalate.
     */
    val installId: String by lazy {
        prefs.getString(KEY_INSTALL_ID, null) ?: UUID.randomUUID().toString().also {
            prefs.edit().putString(KEY_INSTALL_ID, it).apply()
        }
    }

    /** The `reason` string the daemon stores on every pause rule this phone creates. */
    val pauseReason: String get() = "usage-deck:$installId"

    private companion object {
        const val PREFS_NAME = "usage_deck"
        const val KEY_INSTALL_ID = "install_id"
    }
}
