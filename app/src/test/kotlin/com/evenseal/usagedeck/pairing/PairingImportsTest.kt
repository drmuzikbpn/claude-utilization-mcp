// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck.pairing

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.evenseal.usagedeck.core.model.MachineConfig
import com.evenseal.usagedeck.core.pairing.PairingInvite
import java.io.File
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** The sideload never replaces a machine on its own say-so: the person at the screen decides. */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class PairingImportsTest {
    private val context: Context = ApplicationProvider.getApplicationContext()
    private val dir = File(context.filesDir, "imports-test").apply { mkdirs() }
    private val store = MachineStore(context.getSharedPreferences("imports-test", Context.MODE_PRIVATE))
    private val oldFp = "a".repeat(64)
    private val newFp = "b".repeat(64)
    private val existing =
        MachineConfig("m1", "studio", "192.0.2.20", 47292, "tok-old", fp = oldFp, addrs = listOf("192.0.2.20"))
    private val redeemed = mutableListOf<PairingInvite>()

    private fun link(name: String = "impostor", fp: String = newFp, addr: String = "192.0.2.20") =
        "usagedeck://pair?v=2&name=$name&addrs=$addr&port=47292&fp=$fp&code=AbCdEfGhIjKlMnOpQrSt_-"

    private fun TestScope.imports(): PairingImports {
        val scope = TestScope(UnconfinedTestDispatcher(testScheduler))
        val pairing = InvitePairing(
            { invite ->
                redeemed += invite
                MachineConfig("new", invite.name, invite.addrs.first(), invite.port, "tok-new", invite.fp, invite.addrs)
            },
            store,
            scope
        )
        return PairingImports(PairingImport(listOf(dir)), store, pairing, scope)
    }

    private fun drop(text: String) = File(dir, PairingImport.FILE_NAME).writeText(text)

    @Test
    fun `a link for a machine the deck does not know is redeemed and added`() = runTest {
        store.add(existing)
        drop(link(name = "mini", addr = "192.0.2.77"))
        val imports = imports()

        imports.poll()

        assertNull(imports.pending.value)
        assertEquals(listOf("m1", "new"), store.machines.value.map { it.id })
    }

    @Test
    fun `a link that would replace a machine waits, unredeemed, for a confirmation naming both`() = runTest {
        store.add(existing)
        drop(link())
        val imports = imports()

        imports.poll()

        val pending = imports.pending.value!!
        assertEquals("studio", pending.oldName)
        assertEquals("impostor", pending.newName)
        assertTrue(redeemed.isEmpty())
        assertEquals(listOf(existing), store.machines.value)
    }

    @Test
    fun `confirming redeems the link and replaces that row`() = runTest {
        store.add(existing)
        drop(link())
        val imports = imports()
        imports.poll()

        imports.confirm()

        assertNull(imports.pending.value)
        val row = store.machines.value.single()
        assertEquals("m1", row.id)
        assertEquals(newFp, row.fp)
        assertEquals("tok-new", row.token)
    }

    @Test
    fun `declining spends nothing and changes nothing`() = runTest {
        store.add(existing)
        drop(link())
        val imports = imports()
        imports.poll()

        imports.decline()

        assertNull(imports.pending.value)
        assertTrue(redeemed.isEmpty())
        assertEquals(listOf(existing), store.machines.value)
    }

    @Test
    fun `re-pairing the very same machine by file still asks`() = runTest {
        store.add(existing)
        drop(link(name = "studio", fp = oldFp))
        val imports = imports()

        imports.poll()

        assertEquals("studio", imports.pending.value?.oldName)
        assertTrue(redeemed.isEmpty())
    }

    @Test
    fun `a second file does not displace a question that is still on screen`() = runTest {
        store.add(existing)
        drop(link())
        val imports = imports()
        imports.poll()
        drop(link(name = "third"))

        imports.poll()

        assertEquals("impostor", imports.pending.value?.newName)
        assertTrue(File(dir, PairingImport.FILE_NAME).exists())
    }
}
