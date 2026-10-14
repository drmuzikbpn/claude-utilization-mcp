// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck

import android.content.Context
import android.content.pm.ApplicationInfo
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.test.core.app.ApplicationProvider
import com.evenseal.usagedeck.pairing.SecureStorage
import com.evenseal.usagedeck.pairing.SecureStorageException
import com.evenseal.usagedeck.pairing.encryptedPrefs
import com.evenseal.usagedeck.service.DeckService
import java.io.File
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/**
 * Robolectric has no AndroidKeyStore, which is exactly the failure a real phone would have if its
 * keystore were wiped — so these tests see the release behaviour by switching the fallback off.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29])
class SecureStorageTest {
    @get:Rule
    val compose = createEmptyComposeRule()

    private val app = ApplicationProvider.getApplicationContext<UsageDeckApp>()

    @After
    fun restore() {
        SecureStorage.plaintextFallbackAllowed = BuildConfig.DEBUG
    }

    @Test
    fun `without a keystore a release build refuses to open the store`() {
        SecureStorage.plaintextFallbackAllowed = false

        assertThrows(SecureStorageException::class.java) { encryptedPrefs(app, "refused") }
        assertTrue(app.getSharedPreferences("refused", Context.MODE_PRIVATE).all.isEmpty())
        assertTrue(!File(app.filesDir.parentFile, "shared_prefs/refused.xml").exists())
    }

    @Test
    fun `a debug build keeps the plaintext fallback so tests and the emulator run`() {
        SecureStorage.plaintextFallbackAllowed = true

        encryptedPrefs(app, "fallback").edit().putString("k", "v").commit()

        assertEquals("v", app.getSharedPreferences("fallback", Context.MODE_PRIVATE).getString("k", null))
    }

    @Test
    fun `the app reports the failure instead of building a graph on plaintext`() {
        SecureStorage.plaintextFallbackAllowed = false

        assertNotNull(app.storageFailure)
        assertThrows(SecureStorageException::class.java) { app.graph }
    }

    @Test
    fun `the deck shows a storage error and starts nothing when the store cannot be opened`() {
        SecureStorage.plaintextFallbackAllowed = false

        Robolectric.buildActivity(MainActivity::class.java).setup()

        compose.onNodeWithText("Secure storage is unavailable").assertExists()
        compose.onNodeWithText("will not keep pairing tokens unencrypted", substring = true).assertExists()
        assertNull(shadowOf(app).nextStartedService)
    }

    @Test
    fun `the service stops itself rather than run without a store`() {
        SecureStorage.plaintextFallbackAllowed = false

        val service = Robolectric.buildService(DeckService::class.java).create().get()

        assertTrue(shadowOf(service).isStoppedBySelf)
    }

    @Test
    fun `backups are off`() {
        assertEquals(0, app.applicationInfo.flags and ApplicationInfo.FLAG_ALLOW_BACKUP)
    }

    @Test
    fun `the extraction rules exclude every storage domain from cloud backup and device transfer`() {
        val rules = File("src/main/res/xml/data_extraction_rules.xml").readText()
        val domains = listOf("root", "file", "database", "sharedpref", "external")
        listOf("cloud-backup", "device-transfer").forEach { section ->
            val body = rules.substringAfter("<$section").substringBefore("</$section>")
            domains.forEach { domain ->
                assertTrue("$section must exclude $domain", body.contains("""<exclude domain="$domain""""))
            }
            assertTrue("$section must include nothing", !body.contains("<include"))
        }
        val legacy = File("src/main/res/xml/backup_rules.xml").readText()
        domains.forEach { assertTrue(legacy.contains("""<exclude domain="$it"""")) }
        val manifest = File("src/main/AndroidManifest.xml").readText()
        assertTrue(manifest.contains("""android:dataExtractionRules="@xml/data_extraction_rules""""))
        assertTrue(manifest.contains("""android:fullBackupContent="@xml/backup_rules""""))
    }
}
