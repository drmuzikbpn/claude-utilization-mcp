package com.evenseal.usagedeck.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.lifecycle.LifecycleService
import androidx.lifecycle.lifecycleScope
import com.evenseal.usagedeck.MainActivity
import com.evenseal.usagedeck.UsageDeckApp
import com.evenseal.usagedeck.core.alerts.Alert
import com.evenseal.usagedeck.core.alerts.AlertKind
import com.evenseal.usagedeck.core.model.TeamState
import java.time.Duration
import java.time.Instant
import java.time.ZoneId
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.scan
import kotlinx.coroutines.launch

/**
 * The process that keeps the deck alive: it owns the machine clients, the escalation timer and
 * the alert loop, so the stream survives the screen going off in battery mode (spec §5).
 */
class DeckService : LifecycleService() {
    private val graph: DeckGraph by lazy { (application as UsageDeckApp).graph }

    /** Last time each alert key was shown, for the per-key debounce. */
    private val lastRaisedAt = mutableMapOf<String, Instant>()

    /** Last time each still-critical limit was re-announced. */

    override fun onCreate() {
        super.onCreate()
        startForeground(NOTIFICATION_ID, buildNotification())

        graph.mode.start()
        graph.wifi.start()
        graph.startClients()
        graph.pause.start()
        graph.updateChecks = graph.updater
        graph.updater.start()

        lifecycleScope.launch { alertLoop() }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        super.onStartCommand(intent, flags, startId)
        return START_STICKY
    }

    override fun onDestroy() {
        graph.updater.stop()
        graph.updateChecks = null
        graph.pause.stop()
        graph.stopClients()
        graph.wifi.stop()
        graph.mode.stop()
        super.onDestroy()
    }

    /**
     * Evaluates every state transition and decides what actually reaches the user. A limit alert
     * speaks **once per window**: the ledger remembers it across process death, so a self-update
     * cannot turn one crossing into a notification every few hours for the rest of the week.
     * Falling back under a threshold forgets it, so a real re-crossing is still announced.
     */
    private suspend fun alertLoop() {
        graph.team
            .scan<TeamState, Pair<TeamState?, TeamState>>(null to TeamState()) { (_, prev), next ->
                prev to next
            }
            .collect { (prev, next) ->
                val now = graph.clock.now()
                graph.evaluator.evaluate(prev, next).forEach { alert -> raise(alert, now) }
                forgetSettledLimits(next)
            }
    }

    /** A limit back under a threshold clears its ledger entry, so crossing it again is news. */
    private fun forgetSettledLimits(state: TeamState) {
        val prefs = graph.settings.settings.value
        state.users.forEach { user ->
            user.limits.forEach { limit ->
                if (limit.percent < prefs.critical) graph.alerts.forget("${AlertKind.CRITICAL}|${user.key}|${limit.id}")
                if (limit.percent < prefs.warn) graph.alerts.forget("${AlertKind.WARN}|${user.key}|${limit.id}")
            }
        }
    }

    private fun raise(alert: Alert, now: Instant) {
        // A limit crossing is announced once for its window, whatever the process has forgotten.
        val window = alert.window
        if (window != null && !graph.alerts.markFired(alert.key, window)) return
        val last = lastRaisedAt[alert.key]
        if (last != null && Duration.between(last, now) < DEBOUNCE) return
        deliver(alert, now)
    }

    private fun deliver(alert: Alert, now: Instant) {
        lastRaisedAt[alert.key] = now
        val quiet = graph.settings.isQuiet(now.atZone(ZoneId.systemDefault()).toLocalTime())
        graph.notifier.raise(alert, graph.mode.mode.value, quiet, sound = graph.settings.settings.value.sound)
    }

    private fun buildNotification(): Notification {
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "Usage Deck", NotificationManager.IMPORTANCE_LOW)
        )
        val open = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE
        )
        return Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle("Usage Deck running")
            .setContentIntent(open)
            .setOngoing(true)
            .build()
    }

    companion object {
        private const val NOTIFICATION_ID = 1
        private const val CHANNEL_ID = "usage_deck_service"

        private val DEBOUNCE: Duration = Duration.ofSeconds(60)

        fun start(context: Context) {
            context.startService(Intent(context, DeckService::class.java))
        }
    }
}
