// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck.kiosk

import android.content.Context
import android.content.SharedPreferences
import android.os.SystemClock
import android.provider.Settings
import android.util.Base64
import com.evenseal.usagedeck.core.Clock
import java.security.MessageDigest
import java.security.SecureRandom
import java.time.Instant
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.PBEKeySpec

/**
 * Time that only moves forward, for the lockout. The wall clock is a setting — anyone who reaches
 * the system's date screen, or a network time jump, can move it — so it must never decide when a
 * lockout ends. [elapsedMillis] restarts from zero at boot; [bootCount] tells one boot from the next.
 */
interface Uptime {
    fun elapsedMillis(): Long

    fun bootCount(): Int
}

class AndroidUptime(private val context: Context) : Uptime {
    override fun elapsedMillis(): Long = SystemClock.elapsedRealtime()

    override fun bootCount(): Int =
        runCatching { Settings.Global.getInt(context.contentResolver, Settings.Global.BOOT_COUNT, 0) }.getOrDefault(0)
}

/**
 * The maintenance-exit PIN (spec §4): optional, six digits, five wrong attempts buy a five-minute
 * lockout that doubles on every further round. With no PIN the corner gate opens on the hold alone.
 *
 * - **Changing or removing it needs the current one.** [set] only works while no PIN exists;
 *   afterwards [change] and [clear] run the current PIN through [verify] — so guessing by
 *   "changing" meets the same counters and lockout as guessing at the gate, and nobody at the
 *   Settings screen can replace or remove a PIN they do not know.
 * - **Stored with PBKDF2-HMAC-SHA256** (the strongest KDF on API 29 without a new dependency),
 *   salted, inside the encrypted prefs. Six digits are only a million possibilities, so the KDF
 *   buys time against an offline copy rather than safety; the lockout is what protects the gate.
 *   A PIN stored by an older build as one salted SHA-256 still verifies and is rewritten with
 *   PBKDF2 the first time it is entered correctly.
 * - **The lockout runs on [Uptime]**, not the wall clock. A reboot cannot be compared across, so
 *   it restarts the current lockout in full instead of ending it.
 */
class ExitPin(
    private val prefs: SharedPreferences,
    private val clock: Clock,
    private val uptime: Uptime,
    private val iterations: Int = PBKDF2_ITERATIONS
) {
    sealed interface Result {
        object Ok : Result

        /** Wrong PIN; [remaining] attempts left before the next lockout. */
        data class Wrong(val remaining: Int) : Result

        /**
         * Locked out. [until] is for display only — "now" on the wall clock plus what is left on
         * the monotonic one. Attempts made in the window are not counted.
         */
        data class LockedOut(val until: Instant) : Result
    }

    fun isSet(): Boolean = prefs.contains(KEY_HASH) && prefs.contains(KEY_SALT)

    /**
     * Sets the first PIN.
     *
     * @throws IllegalArgumentException when [pin] is not exactly six digits.
     * @throws IllegalStateException when a PIN already exists: use [change].
     */
    @Synchronized
    fun set(pin: String) {
        requireWellFormed(pin)
        check(!isSet()) { "a PIN is already set; changing it needs the current one" }
        store(pin)
    }

    /**
     * Replaces the PIN, if [current] is right. Anything but [Result.Ok] means nothing changed,
     * and a wrong [current] has been counted exactly as a wrong attempt at the gate.
     *
     * @throws IllegalArgumentException when [new] is not exactly six digits (no attempt is spent).
     */
    @Synchronized
    fun change(current: String, new: String): Result {
        requireWellFormed(new)
        val verdict = verify(current)
        if (verdict == Result.Ok) store(new)
        return verdict
    }

    /**
     * Removes the PIN, if [current] is right, so the gate opens on the hold alone. Anything but
     * [Result.Ok] means nothing changed; a wrong [current] counts as a wrong attempt.
     */
    @Synchronized
    fun clear(current: String): Result {
        val verdict = verify(current)
        if (verdict == Result.Ok) {
            prefs.edit().remove(KEY_SALT).remove(KEY_HASH).remove(KEY_KDF).remove(KEY_ITERATIONS).apply()
        }
        return verdict
    }

    @Synchronized
    fun verify(pin: String): Result {
        lockRemainingMillis()?.let { return Result.LockedOut(clock.now().plusMillis(it)) }

        val salt = prefs.getString(KEY_SALT, null)?.decode()
        val expected = prefs.getString(KEY_HASH, null)?.decode()
        val legacy = prefs.getString(KEY_KDF, null) != KDF_NAME
        val matches = salt != null && expected != null && MessageDigest.isEqual(
            expected,
            if (legacy) sha256(salt, pin) else pbkdf2(salt, pin, prefs.getInt(KEY_ITERATIONS, iterations))
        )

        if (matches) {
            prefs.edit().putInt(KEY_FAILURES, 0).putInt(KEY_ROUND, 0).clearLock().apply()
            // The one moment the PIN is known: move an old SHA-256 record to PBKDF2.
            if (legacy) store(pin)
            return Result.Ok
        }

        val failures = prefs.getInt(KEY_FAILURES, 0) + 1
        if (failures < MAX_ATTEMPTS) {
            prefs.edit().putInt(KEY_FAILURES, failures).apply()
            return Result.Wrong(MAX_ATTEMPTS - failures)
        }

        val round = prefs.getInt(KEY_ROUND, 0) + 1
        val duration = lockoutSeconds(round) * MILLIS
        prefs.edit().putInt(KEY_FAILURES, 0).putInt(KEY_ROUND, round).lock(duration).apply()
        return Result.LockedOut(clock.now().plusMillis(duration))
    }

    /** Milliseconds of lockout left, or null when the gate is open. */
    private fun lockRemainingMillis(): Long? {
        migrateWallClockLock()
        val duration = prefs.getLong(KEY_LOCK_DURATION, 0L)
        if (duration <= 0L) return null
        val now = uptime.elapsedMillis()
        val since = prefs.getLong(KEY_LOCK_SINCE, 0L)
        val sameBoot = prefs.getInt(KEY_LOCK_BOOT, -1) == uptime.bootCount() && now >= since
        if (!sameBoot) {
            // The counter restarted: how much had elapsed is unknowable, so none of it counts.
            prefs.edit().lock(duration).apply()
            return duration
        }
        val remaining = since + duration - now
        if (remaining > 0L) return remaining
        prefs.edit().clearLock().apply()
        return null
    }

    /** A lockout written by a build that used the wall clock: keep what is left of it, within reason. */
    private fun migrateWallClockLock() {
        val until = prefs.getLong(KEY_LOCKED_UNTIL_WALL, 0L)
        if (until <= 0L) return
        val remaining = (until - clock.now().toEpochMilli()).coerceAtMost(lockoutSeconds(MAX_LOCKOUT_ROUNDS) * MILLIS)
        val editor = prefs.edit().remove(KEY_LOCKED_UNTIL_WALL)
        if (remaining > 0L) editor.lock(remaining)
        editor.apply()
    }

    private fun SharedPreferences.Editor.lock(durationMillis: Long): SharedPreferences.Editor =
        putLong(KEY_LOCK_DURATION, durationMillis)
            .putLong(KEY_LOCK_SINCE, uptime.elapsedMillis())
            .putInt(KEY_LOCK_BOOT, uptime.bootCount())

    private fun SharedPreferences.Editor.clearLock(): SharedPreferences.Editor =
        remove(KEY_LOCK_DURATION).remove(KEY_LOCK_SINCE).remove(KEY_LOCK_BOOT).remove(KEY_LOCKED_UNTIL_WALL)

    /** Writes the PIN's record and nothing else: failure counters and a lockout are left alone. */
    private fun store(pin: String) {
        val salt = ByteArray(SALT_BYTES).also { SecureRandom().nextBytes(it) }
        prefs.edit()
            .putString(KEY_SALT, salt.encode())
            .putString(KEY_HASH, pbkdf2(salt, pin, iterations).encode())
            .putString(KEY_KDF, KDF_NAME)
            .putInt(KEY_ITERATIONS, iterations)
            .apply()
    }

    private fun requireWellFormed(pin: String) {
        require(pin.length == PIN_LENGTH && pin.all { it in '0'..'9' }) {
            "PIN must be exactly $PIN_LENGTH digits"
        }
    }

    private fun pbkdf2(salt: ByteArray, pin: String, rounds: Int): ByteArray {
        val spec = PBEKeySpec(pin.toCharArray(), salt, rounds, HASH_BITS)
        return try {
            SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).encoded
        } finally {
            spec.clearPassword()
        }
    }

    private fun sha256(salt: ByteArray, pin: String): ByteArray = MessageDigest.getInstance("SHA-256").run {
        update(salt)
        digest(pin.toByteArray(Charsets.UTF_8))
    }

    private fun ByteArray.encode(): String = Base64.encodeToString(this, Base64.NO_WRAP)

    private fun String.decode(): ByteArray = Base64.decode(this, Base64.NO_WRAP)

    companion object {
        const val PIN_LENGTH = 6

        /** About a quarter of a second on the Nexus 5X; entering a PIN can afford that. */
        const val PBKDF2_ITERATIONS = 120_000

        private const val MAX_ATTEMPTS = 5
        private const val SALT_BYTES = 16
        private const val HASH_BITS = 256
        private const val BASE_LOCKOUT_SECONDS = 300L
        private const val MAX_LOCKOUT_ROUNDS = 8
        private const val MILLIS = 1000L
        private const val KDF_NAME = "pbkdf2-hmac-sha256"

        private const val KEY_SALT = "exit_pin_salt"
        private const val KEY_HASH = "exit_pin_hash"
        private const val KEY_KDF = "exit_pin_kdf"
        private const val KEY_ITERATIONS = "exit_pin_iterations"
        private const val KEY_FAILURES = "exit_pin_failures"
        private const val KEY_ROUND = "exit_pin_round"
        private const val KEY_LOCK_DURATION = "exit_pin_lock_duration_ms"
        private const val KEY_LOCK_SINCE = "exit_pin_lock_since_elapsed"
        private const val KEY_LOCK_BOOT = "exit_pin_lock_boot"

        /** Epoch milliseconds, written by builds that timed the lockout on the wall clock. */
        private const val KEY_LOCKED_UNTIL_WALL = "exit_pin_locked_until"

        private fun lockoutSeconds(round: Int): Long =
            BASE_LOCKOUT_SECONDS shl (round.coerceIn(1, MAX_LOCKOUT_ROUNDS) - 1)
    }
}
