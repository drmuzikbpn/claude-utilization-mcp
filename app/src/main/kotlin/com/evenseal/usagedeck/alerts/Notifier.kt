package com.evenseal.usagedeck.alerts

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.VibrationEffect
import android.os.Vibrator
import com.evenseal.usagedeck.core.alerts.Alert
import com.evenseal.usagedeck.core.alerts.AlertKind
import com.evenseal.usagedeck.kiosk.DeckMode
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * Turns an [Alert] into something the room notices: a full-screen overlay while docked, a
 * heads-up notification on battery, and a haptic in both — unless quiet hours are on, which
 * silences the haptic but never the visual (spec §5, §10).
 */
class Notifier(
    private val context: Context,
    private val scope: CoroutineScope = CoroutineScope(Dispatchers.Main.immediate)
) {
    internal val manager: NotificationManager =
        context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

    private val vibrator: Vibrator? = context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator

    private val _overlay = MutableStateFlow<Alert?>(null)
    val overlay: StateFlow<Alert?> = _overlay.asStateFlow()

    private var clearJob: Job? = null

    init {
        AlertKind.entries.forEach { kind ->
            manager.createNotificationChannel(
                NotificationChannel(channelId(kind), channelName(kind), importanceOf(kind))
            )
        }
    }

    fun raise(alert: Alert, mode: DeckMode, quiet: Boolean) {
        if (!quiet) vibrate(alert.kind)
        if (mode == DeckMode.DOCK) {
            showOverlay(alert)
        } else {
            notify(alert)
        }
    }

    /** Lets the overlay be dismissed by touch before the 8 s timer runs out. */
    fun dismissOverlay() {
        clearJob?.cancel()
        clearJob = null
        _overlay.value = null
    }

    private fun showOverlay(alert: Alert) {
        clearJob?.cancel()
        _overlay.value = alert
        clearJob = scope.launch {
            delay(OVERLAY_MILLIS)
            _overlay.value = null
        }
    }

    private fun notify(alert: Alert) {
        val notification = Notification.Builder(context, channelId(alert.kind))
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle(alert.title)
            .setContentText(alert.body)
            .setAutoCancel(true)
            .build()
        manager.notify(alert.key.hashCode(), notification)
    }

    private fun vibrate(kind: AlertKind) {
        val v = vibrator ?: return
        if (!v.hasVibrator()) return
        val pattern = patternOf(kind)
        runCatching { v.vibrate(VibrationEffect.createWaveform(pattern, NO_REPEAT)) }
    }

    companion object {
        const val OVERLAY_MILLIS = 8_000L

        private const val NO_REPEAT = -1
        private const val CHANNEL_PREFIX = "usage_deck_"

        fun channelId(kind: AlertKind) = CHANNEL_PREFIX + kind.name

        /** Spec §10: each kind has its own feel, so the room can tell them apart without looking. */
        fun patternOf(kind: AlertKind): LongArray = when (kind) {
            AlertKind.WARN -> longArrayOf(0, 80)
            AlertKind.CRITICAL -> longArrayOf(0, 80, 80, 80, 80, 80)
            AlertKind.FROZEN -> longArrayOf(0, 400)
            AlertKind.UNREACHABLE -> longArrayOf(0, 80, 120, 80)
        }

        private fun channelName(kind: AlertKind): String = when (kind) {
            AlertKind.WARN -> "Usage warnings"
            AlertKind.CRITICAL -> "Usage critical"
            AlertKind.FROZEN -> "Frozen sessions"
            AlertKind.UNREACHABLE -> "Unreachable machines"
        }

        private fun importanceOf(kind: AlertKind): Int = when (kind) {
            AlertKind.CRITICAL, AlertKind.FROZEN -> NotificationManager.IMPORTANCE_HIGH
            else -> NotificationManager.IMPORTANCE_DEFAULT
        }
    }
}
