package com.evenseal.usagedeck.kiosk

import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * Device Admin component named by `dpm set-device-owner com.evenseal.usagedeck/.kiosk.DeviceAdminReceiver`.
 *
 * It carries no behaviour of its own: every policy is applied through [KioskManager], which needs
 * this receiver only as the admin [android.content.ComponentName].
 */
class DeviceAdminReceiver : android.app.admin.DeviceAdminReceiver() {
    override fun onEnabled(context: Context, intent: Intent) {
        super.onEnabled(context, intent)
        Log.i(TAG, "device admin enabled")
        KioskManager(context).applyPolicies()
    }

    override fun onDisabled(context: Context, intent: Intent) {
        super.onDisabled(context, intent)
        Log.i(TAG, "device admin disabled")
    }

    private companion object {
        const val TAG = "UsageDeckAdmin"
    }
}
