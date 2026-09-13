package com.evenseal.usagedeck.kiosk

import android.app.Activity
import android.app.ActivityManager
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import android.os.PowerManager
import android.os.UserManager
import android.provider.Settings
import android.util.Log
import com.evenseal.usagedeck.MainActivity

/**
 * Owns every Device Owner policy the kiosk needs.
 *
 * Every call is guarded by [isDeviceOwner]: on a phone that has not had
 * `dpm set-device-owner` run against it (the emulator, and the dev phone before provisioning)
 * each entry point is a silent no-op rather than a [SecurityException].
 */
class KioskManager(private val context: Context) {
    private val dpm: DevicePolicyManager =
        context.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager

    private val admin: ComponentName = ComponentName(context, DeviceAdminReceiver::class.java)

    val isDeviceOwner: Boolean
        get() = runCatching { dpm.isDeviceOwnerApp(context.packageName) }.getOrDefault(false)

    /** True once the user has granted the battery-optimisation exemption (see [requestDozeExemption]). */
    val dozeExempt: Boolean
        get() {
            val power = context.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return false
            return runCatching { power.isIgnoringBatteryOptimizations(context.packageName) }
                .getOrDefault(false)
        }

    /**
     * Applies the whole kiosk policy set. Safe to call repeatedly; the Device Owner APIs are
     * idempotent.
     */
    fun applyPolicies() {
        if (!isDeviceOwner) return
        policy("setLockTaskPackages") {
            dpm.setLockTaskPackages(admin, arrayOf(context.packageName, TAILSCALE_PACKAGE))
        }
        policy("setLockTaskFeatures") {
            dpm.setLockTaskFeatures(admin, DevicePolicyManager.LOCK_TASK_FEATURE_NONE)
        }
        policy("setKeyguardDisabled") { dpm.setKeyguardDisabled(admin, true) }
        policy("stayOnWhilePluggedIn") {
            dpm.setGlobalSetting(admin, Settings.Global.STAY_ON_WHILE_PLUGGED_IN, STAY_ON_ALL_SOURCES)
        }
        policy("setStatusBarDisabled") { dpm.setStatusBarDisabled(admin, true) }
        policy("disallowSafeBoot") { dpm.addUserRestriction(admin, UserManager.DISALLOW_SAFE_BOOT) }
        RUNTIME_PERMISSIONS.forEach { permission ->
            policy("grant $permission") {
                dpm.setPermissionGrantState(
                    admin,
                    context.packageName,
                    permission,
                    DevicePolicyManager.PERMISSION_GRANT_STATE_GRANTED
                )
            }
        }
        policy("persistentHome") {
            dpm.addPersistentPreferredActivity(
                admin,
                homeIntentFilter(),
                ComponentName(context, MainActivity::class.java)
            )
        }
    }

    /**
     * Enters lock task. Device Owner cannot pin an app that is not whitelisted, so this is a no-op
     * unless [applyPolicies] has run, and a no-op when lock task is already active.
     */
    fun startLockTask(activity: Activity) {
        if (!isDeviceOwner) return
        if (lockTaskActive()) return
        policy("startLockTask") { activity.startLockTask() }
    }

    /** Leaves lock task for the maintenance window. No-op when lock task is not active. */
    fun stopLockTask(activity: Activity) {
        if (!lockTaskActive()) return
        policy("stopLockTask") { activity.stopLockTask() }
    }

    /**
     * Device Owner cannot write the battery whitelist directly on API 29, so the exemption is a
     * one-tap system dialog documented in `docs/device-setup.md`. Returns false when the intent
     * cannot be launched, so the caller can leave the setup checklist item open.
     */
    fun requestDozeExemption(activity: Activity): Boolean {
        if (dozeExempt) return true
        val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
            .setData(Uri.parse("package:${context.packageName}"))
        return runCatching { activity.startActivity(intent) }.isSuccess
    }

    private fun lockTaskActive(): Boolean {
        val am = context.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager ?: return false
        return runCatching { am.lockTaskModeState != ActivityManager.LOCK_TASK_MODE_NONE }
            .getOrDefault(false)
    }

    private inline fun policy(name: String, block: () -> Unit) {
        try {
            block()
        } catch (e: SecurityException) {
            Log.w(TAG, "kiosk policy '$name' rejected", e)
        } catch (e: IllegalStateException) {
            Log.w(TAG, "kiosk policy '$name' unavailable", e)
        } catch (e: UnsupportedOperationException) {
            Log.w(TAG, "kiosk policy '$name' unsupported", e)
        }
    }

    companion object {
        const val TAILSCALE_PACKAGE = "com.tailscale.ipn"

        /**
         * Android 10 refuses `getScanResults` and `getConfiguredNetworks` without location
         * permission, and silently returns an empty list rather than throwing — so on the real
         * phone the wifi screen was simply blank. Device Owner can grant these outright; there is
         * nobody standing at a docked kiosk to answer a runtime prompt.
         */
        val RUNTIME_PERMISSIONS = listOf(
            android.Manifest.permission.ACCESS_FINE_LOCATION,
            android.Manifest.permission.CAMERA
        )

        /** `STAY_ON_WHILE_PLUGGED_IN` bitmask for AC + USB + wireless. */
        const val STAY_ON_ALL_SOURCES = "7"

        private const val TAG = "UsageDeckKiosk"

        fun homeIntentFilter(): IntentFilter = IntentFilter(Intent.ACTION_MAIN).apply {
            addCategory(Intent.CATEGORY_HOME)
            addCategory(Intent.CATEGORY_DEFAULT)
        }
    }
}
