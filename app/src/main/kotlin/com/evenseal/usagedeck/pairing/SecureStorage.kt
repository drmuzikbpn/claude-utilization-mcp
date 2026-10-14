// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck.pairing

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.evenseal.usagedeck.BuildConfig
import java.io.IOException
import java.security.GeneralSecurityException

/** The AndroidKeyStore could not provide the key that protects [name]; nothing was opened. */
class SecureStorageException(val name: String, cause: Throwable) :
    Exception("secure storage for '$name' is unavailable", cause)

object SecureStorage {
    /**
     * Whether a store may fall back to plain SharedPreferences when the keystore is unavailable.
     * True only in debuggable builds — Robolectric has no AndroidKeyStore, and neither do some
     * emulator images. A release build never falls back: see [encryptedPrefs].
     */
    @Volatile
    var plaintextFallbackAllowed: Boolean = BuildConfig.DEBUG
}

/**
 * Opens [name] as `EncryptedSharedPreferences`.
 *
 * It **fails closed**. If the AndroidKeyStore cannot produce or read the master key — a wiped or
 * corrupted keystore — a release build throws [SecureStorageException] rather than quietly keeping
 * bearer tokens and the exit PIN in a plaintext file, and the deck shows a storage error instead
 * of running. Only a debuggable build ([SecureStorage.plaintextFallbackAllowed]) falls back to
 * plain prefs, so unit tests and the emulator still work.
 */
internal fun encryptedPrefs(context: Context, name: String): SharedPreferences {
    val app = context.applicationContext
    val failure = try {
        val key = MasterKey.Builder(app)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        return EncryptedSharedPreferences.create(
            app,
            name,
            key,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
    } catch (e: GeneralSecurityException) {
        e
    } catch (e: IOException) {
        e
    }
    if (!SecureStorage.plaintextFallbackAllowed) throw SecureStorageException(name, failure)
    Log.w("UsageDeckPrefs", "keystore unavailable; debug build falling back to plain prefs for $name", failure)
    return app.getSharedPreferences(name, Context.MODE_PRIVATE)
}
