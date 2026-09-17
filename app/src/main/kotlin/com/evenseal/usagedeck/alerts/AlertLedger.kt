package com.evenseal.usagedeck.alerts

import android.content.SharedPreferences

/**
 * Remembers which limit alerts have already been announced, so each one fires **once per window**.
 *
 * Two things made the deck nag: the evaluator treats a limit it has never seen as a fresh crossing,
 * and a self-update restarts the process several times a day — so a 7-day window sitting at 96 %
 * re-announced itself on every restart until the reset. The window's own `resetsAt` is the identity
 * here: a new window is a new alert, the same window is never announced twice, and dropping back
 * under the threshold forgets the key so a genuine re-crossing still speaks up.
 */
class AlertLedger(private val prefs: SharedPreferences) {
    /** True when [key] has not been announced for [window] yet; records it in the same breath. */
    fun markFired(key: String, window: Long): Boolean {
        if (prefs.getLong(key, NEVER) == window) return false
        prefs.edit().putLong(key, window).apply()
        return true
    }

    /** Forgets [key], so the next crossing of that threshold announces itself again. */
    fun forget(key: String) {
        if (prefs.contains(key)) prefs.edit().remove(key).apply()
    }

    private companion object {
        const val NEVER = Long.MIN_VALUE
    }
}
