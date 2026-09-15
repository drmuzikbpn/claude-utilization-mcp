package com.evenseal.usagedeck.kiosk

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.evenseal.usagedeck.MainActivity

/**
 * Re-arms the kiosk after a maintenance exit, and after a self-update.
 *
 * The alarm is owned by the app, not the activity, so the window closes even if the technician
 * left Usage Deck for another app — and a reboot inside the window boots straight back into the
 * locked launcher, because `MainActivity` is the persistent HOME activity (spec §4). Installing a
 * release kills the process and Android does not restart a HOME activity by itself, so
 * `MY_PACKAGE_REPLACED` brings the deck back too; without it the first unattended update left the
 * phone sitting on the stock launcher.
 */
class LockTaskReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_RELOCK && intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        val relaunch = Intent(context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        runCatching { context.startActivity(relaunch) }
    }

    companion object {
        const val ACTION_RELOCK = "com.evenseal.usagedeck.RELOCK"

        /** The maintenance window from spec §4. */
        const val WINDOW_MILLIS = 10 * 60 * 1000L

        private const val REQUEST_CODE = 42

        fun scheduleRelock(context: Context, atMillis: Long) {
            val alarms = context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return
            runCatching { alarms.setExact(AlarmManager.RTC_WAKEUP, atMillis, pendingIntent(context)) }
        }

        fun cancelRelock(context: Context) {
            val alarms = context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return
            runCatching { alarms.cancel(pendingIntent(context)) }
        }

        private fun pendingIntent(context: Context): PendingIntent = PendingIntent.getBroadcast(
            context,
            REQUEST_CODE,
            Intent(context, LockTaskReceiver::class.java).setAction(ACTION_RELOCK),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
    }
}
