package com.evenseal.usagedeck.settings

import android.content.SharedPreferences
import com.evenseal.usagedeck.core.alerts.AlertThresholds
import com.evenseal.usagedeck.core.pause.PauseSettings
import java.time.LocalTime
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn

/** Everything the Settings screen owns (spec §11.5). */
data class Settings(
    val warn: Int = 80,
    val critical: Int = 95,
    /** null turns soft→hard escalation off entirely. */
    val escalationSeconds: Int? = 90,
    val quietStart: LocalTime = LocalTime.of(23, 0),
    val quietEnd: LocalTime = LocalTime.of(7, 0),
    val nightDim: Float = 0.35f,
    val pinSet: Boolean = false
)

/**
 * Settings persisted in plain prefs — none of this is a credential, and the kiosk needs them
 * before the keystore is warm.
 */
class SettingsStore(private val prefs: SharedPreferences) {
    private val _settings = MutableStateFlow(load())
    val settings: StateFlow<Settings> = _settings.asStateFlow()

    /** The slice `AlertEvaluator` wants. */
    val thresholds: StateFlow<AlertThresholds> = derive { AlertThresholds(it.warn, it.critical) }

    /** The slice `PauseController` wants. */
    val pauseSettings: StateFlow<PauseSettings> = derive { PauseSettings(it.escalationSeconds) }

    fun update(f: (Settings) -> Settings) {
        val next = f(_settings.value)
        prefs.edit()
            .putInt(KEY_WARN, next.warn)
            .putInt(KEY_CRITICAL, next.critical)
            .putInt(KEY_ESCALATION, next.escalationSeconds ?: ESCALATION_OFF)
            .putString(KEY_QUIET_START, next.quietStart.toString())
            .putString(KEY_QUIET_END, next.quietEnd.toString())
            .putFloat(KEY_NIGHT_DIM, next.nightDim)
            .putBoolean(KEY_PIN_SET, next.pinSet)
            .apply()
        _settings.value = next
    }

    /**
     * Quiet hours wrap midnight by default (23:00–07:00): the window is `[start, end)` when it
     * does not wrap, and `[start, 24:00) ∪ [00:00, end)` when it does. start == end means off.
     */
    fun isQuiet(now: LocalTime): Boolean {
        val s = _settings.value
        val start = s.quietStart
        val end = s.quietEnd
        return when {
            start == end -> false
            start.isBefore(end) -> !now.isBefore(start) && now.isBefore(end)
            else -> !now.isBefore(start) || now.isBefore(end)
        }
    }

    private fun <T> derive(f: (Settings) -> T): StateFlow<T> = _settings.map(f).stateIn(
        CoroutineScope(Dispatchers.Unconfined),
        SharingStarted.Eagerly,
        f(_settings.value)
    )

    private fun load(): Settings {
        val defaults = Settings()
        if (!prefs.contains(KEY_WARN)) return defaults
        val escalation = prefs.getInt(KEY_ESCALATION, defaults.escalationSeconds ?: ESCALATION_OFF)
        return Settings(
            warn = prefs.getInt(KEY_WARN, defaults.warn),
            critical = prefs.getInt(KEY_CRITICAL, defaults.critical),
            escalationSeconds = escalation.takeIf { it != ESCALATION_OFF },
            quietStart = prefs.timeOf(KEY_QUIET_START, defaults.quietStart),
            quietEnd = prefs.timeOf(KEY_QUIET_END, defaults.quietEnd),
            nightDim = prefs.getFloat(KEY_NIGHT_DIM, defaults.nightDim),
            pinSet = prefs.getBoolean(KEY_PIN_SET, defaults.pinSet)
        )
    }

    private fun SharedPreferences.timeOf(key: String, fallback: LocalTime): LocalTime {
        val raw = getString(key, null) ?: return fallback
        return runCatching { LocalTime.parse(raw) }.getOrDefault(fallback)
    }

    private companion object {
        const val ESCALATION_OFF = -1

        const val KEY_WARN = "warn"
        const val KEY_CRITICAL = "critical"
        const val KEY_ESCALATION = "escalation_seconds"
        const val KEY_QUIET_START = "quiet_start"
        const val KEY_QUIET_END = "quiet_end"
        const val KEY_NIGHT_DIM = "night_dim"
        const val KEY_PIN_SET = "pin_set"
    }
}
