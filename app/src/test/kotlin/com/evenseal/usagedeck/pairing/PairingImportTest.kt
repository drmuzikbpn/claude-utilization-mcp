// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck.pairing

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class PairingImportTest {
    private val context: Context = ApplicationProvider.getApplicationContext()
    private val dir = File(context.filesDir, "import-test").apply { mkdirs() }
    private val external = File(context.filesDir, "import-test-external").apply { mkdirs() }
    private val import = PairingImport(listOf(dir))
    private val fp = "eeeb5db71defbf5a8dcd133e886b617f68a2cdfb8853e0b46ac1da446bdc1a27"
    private val link = "usagedeck://pair?v=2&name=mbp&addrs=192.0.2.20&port=47292&fp=$fp&code=AbCdEfGhIjKlMnOpQrSt_-\n"

    private fun drop(text: String, into: File = dir) = File(into, PairingImport.FILE_NAME).writeText(text)

    @Test
    fun `no file is a no-op`() {
        assertEquals(PairingImport.Result.Nothing, import.consume())
    }

    @Test
    fun `a v2 link is handed back for redeeming and the file removed`() {
        drop(link)

        val result = import.consume() as PairingImport.Result.Redeem

        assertEquals("mbp", result.invite.name)
        assertFalse(File(dir, PairingImport.FILE_NAME).exists())
    }

    @Test
    fun `the old json pairing is refused, never stored, and the file still removed`() {
        drop("""{"v":1,"name":"mbp","addr":"192.0.2.10","port":47291,"token":"secret-bearer"}""")

        val result = import.consume() as PairingImport.Result.Rejected

        assertTrue(result.reason.contains("claude-usage pair"))
        assertFalse(result.reason.contains("secret-bearer"))
        assertFalse(File(dir, PairingImport.FILE_NAME).exists())
    }

    @Test
    fun `a malformed link is rejected and the file removed`() {
        drop("usagedeck://pair?v=2&name=mbp")
        assertTrue(import.consume() is PairingImport.Result.Rejected)
        assertFalse(File(dir, PairingImport.FILE_NAME).exists())
    }

    @Test
    fun `a file that cannot be deleted is not imported`() {
        drop(link)
        val stubborn = PairingImport(listOf(dir), delete = { false })

        val result = stubborn.consume() as PairingImport.Result.Rejected

        assertTrue(result.reason.contains("could not be deleted"))
    }

    @Test
    fun `an oversized file is refused without being read`() {
        drop(link + "x".repeat(PairingImport.MAX_BYTES.toInt()))
        assertTrue((import.consume() as PairingImport.Result.Rejected).reason.contains("too large"))
        assertFalse(File(dir, PairingImport.FILE_NAME).exists())
    }

    @Test
    fun `a release build watches only its private files dir`() {
        assertEquals(listOf(dir), PairingImport.watched(dir, external, debuggable = false))
        assertEquals(listOf(dir, external), PairingImport.watched(dir, external, debuggable = true))
        assertEquals(listOf(dir), PairingImport.watched(dir, null, debuggable = true))
    }

    @Test
    fun `a file dropped in the external dir of a release build is left alone`() {
        drop(link, into = external)

        val release = PairingImport(PairingImport.watched(dir, external, debuggable = false))

        assertEquals(PairingImport.Result.Nothing, release.consume())
        assertTrue(File(external, PairingImport.FILE_NAME).delete())
    }

    @Test
    fun `names from a pairing are made safe to log`() {
        assertEquals("mbpforged line", PairingImport.loggable("mbp\nforged\u0007 line"))
        assertEquals(64, PairingImport.loggable("x".repeat(500)).length)
    }
}
