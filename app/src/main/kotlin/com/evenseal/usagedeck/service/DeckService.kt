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
    private val lastCriticalAt = mutableMapOf<String, Instant>()

    override fun onCreate() {
        super.onCreate()
        startForeground(NOTIFICATION_ID, buildNotification())

        graph.mode.start()
        graph.wifi.start()
        graph.startClients()
        graph.pause.start()

        lifecycleScope.launch { alertLoop() }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        super.onStartCommand(intent, flags, startId)
        return START_STICKY
    }

    override fun onDestroy() {
        graph.pause.stop()
        graph.stopClients()
        graph.wifi.stop()
        graph.mode.stop()
        super.onDestroy()
    }

    /**
     * Evaluates every state transition and decides what actually reaches the user: a key that
     * fired inside the debounce window is dropped, and a limit sitting above critical is
     * re-announced every ten minutes rather than once and never again.
     */
    private suspend fun alertLoop() {
        graph.team
            .scan<TeamState, Pair<TeamState?, TeamState>>(null to TeamState()) { (_, prev), next ->
                prev to next
            }
            .collect { (prev, next) ->
                val now = graph.clock.now()
                graph.evaluator.evaluate(prev, next).forEach { alert -> raise(alert, now) }
                repeatCriticals(next, now)
            }
    }

    private fun repeatCriticals(state: TeamState, now: Instant) {
        val critical = graph.settings.settings.value.critical
        val stillCritical = state.users.flatMap { user ->
            user.limits.filter { it.percent >= critical }.map { limit ->
                Alert(
                    kind = AlertKind.CRITICAL,
                    key = "${AlertKind.CRITICAL}|${user.key}|${limit.id}",
                    title = "Usage critical",
                    body = "${user.displayName} still at ${limit.percent}%"
                )
            }
        }
        val live = stillCritical.map { it.key }.toSet()
        lastCriticalAt.keys.retainAll(live)

        stillCritical.forEach { alert ->
            val last = lastCriticalAt[alert.key]
            if (last == null) {
                // The crossing itself was already reported by the evaluator; start the clock here.
                lastCriticalAt[alert.key] = now
            } else if (Duration.between(last, now) >= CRITICAL_REPEAT) {
                lastCriticalAt[alert.key] = now
                deliver(alert, now)
            }
        }
    }

    private fun raise(alert: Alert, now: Instant) {
        val last = lastRaisedAt[alert.key]
        if (last != null && Duration.between(last, now) < DEBOUNCE) return
        deliver(alert, now)
    }

    private fun deliver(alert: Alert, now: Instant) {
        lastRaisedAt[alert.key] = now
        val quiet = graph.settings.isQuiet(now.atZone(ZoneId.systemDefault()).toLocalTime())
        graph.notifier.raise(alert, graph.mode.mode.value, quiet)
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
        private val CRITICAL_REPEAT: Duration = Duration.ofMinutes(10)

        fun start(context: Context) {
            context.startService(Intent(context, DeckService::class.java))
        }
    }
}
