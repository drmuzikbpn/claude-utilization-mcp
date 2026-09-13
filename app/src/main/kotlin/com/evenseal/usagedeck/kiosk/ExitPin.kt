package com.evenseal.usagedeck.kiosk

import android.content.SharedPreferences
import android.util.Base64
import com.evenseal.usagedeck.core.Clock
import java.security.MessageDigest
import java.security.SecureRandom
import java.time.Instant

/**
 * The maintenance-exit PIN (spec §4): six digits, stored as a salted SHA-256 in the encrypted
 * prefs, five wrong attempts buy a five-minute lockout that doubles on every further round.
 */
class ExitPin(
    private val prefs: SharedPreferences,
    private val clock: Clock
) {
    sealed interface Result {
        object Ok : Result

        /** Wrong PIN; [remaining] attempts left before the next lockout. */
        data class Wrong(val remaining: Int) : Result

        /** Locked out until [until]; attempts made in the window are not counted. */
        data class LockedOut(val until: Instant) : Result
    }

    fun isSet(): Boolean = prefs.contains(KEY_HASH) && prefs.contains(KEY_SALT)

    /** @throws IllegalArgumentException when [pin] is not exactly six digits. */
    fun set(pin: String) {
        require(pin.length == PIN_LENGTH && pin.all { it in '0'..'9' }) {
            "PIN must be exactly $PIN_LENGTH digits"
        }
        val salt = ByteArray(SALT_BYTES).also { SecureRandom().nextBytes(it) }
        prefs.edit()
            .putString(KEY_SALT, salt.encode())
            .putString(KEY_HASH, hash(salt, pin).encode())
            .putInt(KEY_FAILURES, 0)
            .putInt(KEY_ROUND, 0)
            .remove(KEY_LOCKED_UNTIL)
            .apply()
    }

    fun verify(pin: String): Result {
        val lockedUntil = prefs.getLong(KEY_LOCKED_UNTIL, 0L)
        val now = clock.now()
        if (lockedUntil > 0L && now.isBefore(Instant.ofEpochMilli(lockedUntil))) {
            return Result.LockedOut(Instant.ofEpochMilli(lockedUntil))
        }

        val salt = prefs.getString(KEY_SALT, null)?.decode()
        val expected = prefs.getString(KEY_HASH, null)?.decode()
        val matches = salt != null && expected != null &&
            MessageDigest.isEqual(expected, hash(salt, pin))

        if (matches) {
            prefs.edit()
                .putInt(KEY_FAILURES, 0)
                .putInt(KEY_ROUND, 0)
                .remove(KEY_LOCKED_UNTIL)
                .apply()
            return Result.Ok
        }

        val failures = prefs.getInt(KEY_FAILURES, 0) + 1
        if (failures < MAX_ATTEMPTS) {
            prefs.edit().putInt(KEY_FAILURES, failures).remove(KEY_LOCKED_UNTIL).apply()
            return Result.Wrong(MAX_ATTEMPTS - failures)
        }

        val round = prefs.getInt(KEY_ROUND, 0) + 1
        val until = now.plusSeconds(lockoutSeconds(round))
        prefs.edit()
            .putInt(KEY_FAILURES, 0)
            .putInt(KEY_ROUND, round)
            .putLong(KEY_LOCKED_UNTIL, until.toEpochMilli())
            .apply()
        return Result.LockedOut(until)
    }

    private fun hash(salt: ByteArray, pin: String): ByteArray = MessageDigest.getInstance("SHA-256").run {
        update(salt)
        digest(pin.toByteArray(Charsets.UTF_8))
    }

    private fun ByteArray.encode(): String = Base64.encodeToString(this, Base64.NO_WRAP)

    private fun String.decode(): ByteArray = Base64.decode(this, Base64.NO_WRAP)

    private companion object {
        const val PIN_LENGTH = 6
        const val MAX_ATTEMPTS = 5
        const val SALT_BYTES = 16
        const val BASE_LOCKOUT_SECONDS = 300L
        const val MAX_LOCKOUT_ROUNDS = 8

        const val KEY_SALT = "exit_pin_salt"
        const val KEY_HASH = "exit_pin_hash"
        const val KEY_FAILURES = "exit_pin_failures"
        const val KEY_ROUND = "exit_pin_round"
        const val KEY_LOCKED_UNTIL = "exit_pin_locked_until"

        fun lockoutSeconds(round: Int): Long = BASE_LOCKOUT_SECONDS shl (round.coerceIn(1, MAX_LOCKOUT_ROUNDS) - 1)
    }
}
