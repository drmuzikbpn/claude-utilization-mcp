package com.evenseal.usagedeck.update

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.util.Log

/**
 * Receives the outcome of a [PackageInstaller] commit.
 *
 * A successful install replaces this very process, so the only outcome worth handling here is a
 * failure: it is logged and left for the next ten-minute check to retry, which is why a broken
 * release cannot brick the deck.
 */
class InstallResultReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION) return
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
        val message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)
        when (status) {
            PackageInstaller.STATUS_SUCCESS -> Log.i(TAG, "update installed")
            PackageInstaller.STATUS_PENDING_USER_ACTION -> Log.w(TAG, "install needs a prompt; not device owner?")
            else -> Log.w(TAG, "install failed ($status): $message")
        }
    }

    companion object {
        const val ACTION = "com.evenseal.usagedeck.INSTALL_RESULT"

        fun pendingIntent(context: Context, sessionId: Int): PendingIntent = PendingIntent.getBroadcast(
            context,
            sessionId,
            Intent(context, InstallResultReceiver::class.java).setAction(ACTION),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
        )

        private const val TAG = "UsageDeckUpdate"
    }
}
