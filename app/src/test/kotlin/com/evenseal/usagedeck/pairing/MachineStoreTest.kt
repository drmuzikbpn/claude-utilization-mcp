// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck.pairing

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.evenseal.usagedeck.core.model.MachineConfig
import com.evenseal.usagedeck.core.pairing.PairingInvite
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class MachineStoreTest {
    private lateinit var context: Context
    private lateinit var store: MachineStore

    private val mbp = MachineConfig("m1", "macbook-pro-10", "192.0.2.1", 8787, "tok-1", fp = "1".repeat(64))
    private val mini = MachineConfig("m2", "mac-mini", "192.0.2.2", 8787, "tok-2", fp = "2".repeat(64))

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        store = MachineStore.open(context)
        store.machines.value.forEach { store.remove(it.id) }
    }

    @Test
    fun `starts empty`() {
        assertTrue(store.machines.value.isEmpty())
    }

    @Test
    fun `add then remove round-trips`() {
        store.add(mbp)
        store.add(mini)
        assertEquals(listOf("m1", "m2"), store.machines.value.map { it.id })

        store.remove("m1")
        assertEquals(listOf("m2"), store.machines.value.map { it.id })
    }

    @Test
    fun `add persists every field across a reopen`() {
        store.add(mbp)

        val reopened = MachineStore.open(context)
        val loaded = reopened.machines.value.single()
        assertEquals(mbp, loaded)
        assertEquals("https://192.0.2.1:8787", loaded.baseUrl)
    }

    @Test
    fun `adding the same id twice replaces rather than duplicates`() {
        store.add(mbp)
        store.add(mbp.copy(addr = "100.9.9.9"))
        assertEquals(1, store.machines.value.size)
        assertEquals("100.9.9.9", store.machines.value.single().addr)
    }

    @Test
    fun `rename changes only the name and survives a reopen`() {
        store.add(mbp)
        store.rename("m1", "Adam's laptop")

        assertEquals("Adam's laptop", store.machines.value.single().name)
        assertEquals("tok-1", store.machines.value.single().token)
        assertEquals("Adam's laptop", MachineStore.open(context).machines.value.single().name)
    }

    @Test
    fun `rename of an unknown id is a no-op`() {
        store.add(mbp)
        store.rename("nope", "ghost")
        assertEquals(listOf(mbp), store.machines.value)
    }

    @Test
    fun `remove of an unknown id is a no-op`() {
        store.add(mbp)
        store.remove("nope")
        assertEquals(listOf(mbp), store.machines.value)
    }

    private val pinned = MachineConfig(
        "m3",
        "studio",
        "192.168.1.30",
        47292,
        "tok-3",
        fp = "a".repeat(64),
        addrs = listOf("192.168.1.30", "studio.local", "100.1.1.3")
    )

    @Test
    fun `a pinned machine persists its fingerprint and addresses`() {
        store.add(pinned)
        val loaded = MachineStore.open(context).machines.value.single()
        assertEquals(pinned, loaded)
        assertEquals("https://192.168.1.30:47292", loaded.baseUrl)
    }

    private fun legacyPrefs(name: String) = context.getSharedPreferences(name, Context.MODE_PRIVATE).also {
        it.edit()
            .putString(
                "machines",
                """[{"id":"m1","name":"mbp","addr":"192.0.2.44","port":8787,"token":"old-bearer"}]"""
            )
            .commit()
    }

    @Test
    fun `a row from the retired plain-http pairing is kept, unpinned, so it can ask for a re-pair`() {
        val loaded = MachineStore(legacyPrefs("legacy-rows")).machines.value.single()

        assertEquals("m1", loaded.id)
        assertEquals("mbp", loaded.name)
        assertFalse(loaded.isPinned)
    }

    @Test
    fun `a retired row's bearer is scrubbed from memory and from disk on first load`() {
        val prefs = legacyPrefs("legacy-scrub")

        assertEquals("", MachineStore(prefs).machines.value.single().token)
        assertFalse(prefs.getString("machines", "")!!.contains("old-bearer"))
    }

    private val invite = PairingInvite("studio-new", pinned.addrs, 47292, "c".repeat(64), "AbCdEfGhIjKlMnOpQrSt_-")

    @Test
    fun `wouldReplace names the row a link would overwrite, before anything is redeemed`() {
        store.add(mbp)
        assertNull(store.wouldReplace(invite))

        store.add(pinned)
        assertEquals("m3", store.wouldReplace(invite)?.id)
        assertEquals(
            "m3",
            store.wouldReplace(PairingInvite("x", listOf("192.0.2.99"), 1, pinned.fp!!, invite.code))?.id
        )
    }

    @Test
    fun `a pairing that may not replace is added beside the row it matches`() {
        store.add(pinned)

        val stored = store.pair(pinned.copy(id = "new", token = "tok-new"), mayReplace = false)

        assertEquals("new", stored.id)
        assertEquals(listOf("m3", "new"), store.machines.value.map { it.id })
        assertEquals("tok-3", store.machines.value.first().token)
    }

    @Test
    fun `pairing the same key again replaces the row, keeping its id but taking the daemon's name`() {
        store.add(mbp)
        store.add(pinned)
        store.add(mini)
        store.rename("m3", "Studio upstairs")

        val stored = store.pair(pinned.copy(id = "m4", name = "studio-renamed", addr = "100.1.1.3", token = "tok-new"))

        assertEquals(listOf("m1", "m3", "m2"), store.machines.value.map { it.id })
        assertEquals(stored, store.machines.value[1])
        assertEquals("tok-new", stored.token)
        assertEquals("100.1.1.3", stored.addr)
        assertEquals("studio-renamed", stored.name)
        assertEquals("m3", stored.id)
    }

    @Test
    fun `pairing the same address and port again replaces the row`() {
        store.add(mbp)
        store.pair(mbp.copy(id = "m9", token = "tok-new"))
        assertEquals(listOf("m1"), store.machines.value.map { it.id })
        assertEquals("tok-new", store.machines.value.single().token)
    }

    @Test
    fun `a v2 pairing replaces the v1 row for one of its addresses`() {
        val legacy = MachineConfig("old", "studio", "100.1.1.3", 47291, "tok-old")
        store.add(legacy)
        store.add(mini)
        store.pair(pinned)
        assertEquals(listOf("old", "m2"), store.machines.value.map { it.id })
        assertEquals("a".repeat(64), store.machines.value.first().fp)
    }

    @Test
    fun `the v1 upgrade ignores the port, since the legacy row is on the http port`() {
        store.add(MachineConfig("old", "studio", "192.168.1.30", 47291, "tok-old"))
        store.pair(pinned)
        assertEquals(listOf("old"), store.machines.value.map { it.id })
        assertEquals(47292, store.machines.value.single().port)
    }

    @Test
    fun `a loopback legacy row is never taken for the machine a v2 pairing lists on loopback`() {
        val local = MachineConfig("emu", "this-mac", "127.0.0.1", 47291, "tok-local")
        val named = MachineConfig("emu2", "this-mac", "localhost", 47291, "tok-local2")
        store.add(local)
        store.add(named)

        store.pair(pinned.copy(addrs = pinned.addrs + listOf("localhost", "127.0.0.1")))

        assertEquals(listOf("emu", "emu2", "m3"), store.machines.value.map { it.id })
    }

    @Test
    fun `a pairing matching several rows keeps the first one's id and drops the rest`() {
        store.add(MachineConfig("old", "studio", "100.1.1.3", 47291, "tok-old"))
        store.add(pinned.copy(id = "dup"))
        store.pair(pinned.copy(id = "new"))
        assertEquals(listOf("old"), store.machines.value.map { it.id })
    }

    @Test
    fun `concurrent writers never drop a row`() {
        val threads = (0 until 8).map { t ->
            Thread { repeat(25) { i -> store.add(mbp.copy(id = "t$t-$i")) } }
        }
        threads.forEach { it.start() }
        threads.forEach { it.join() }

        assertEquals(200, store.machines.value.size)
        assertEquals(200, MachineStore.open(context).machines.value.size)
    }

    @Test
    fun `pairing an unrelated machine adds a row`() {
        store.add(mbp)
        store.pair(pinned)
        assertEquals(listOf("m1", "m3"), store.machines.value.map { it.id })
    }

    @Test
    fun `replace swaps the given row even when the key and address both changed`() {
        store.add(mbp)
        store.add(pinned)
        val rekeyed = pinned.copy(
            id = "new",
            addr = "192.168.1.99",
            addrs = listOf("192.168.1.99"),
            fp = "b".repeat(64)
        )

        val stored = store.replace("m3", rekeyed)

        assertEquals(listOf("m1", "m3"), store.machines.value.map { it.id })
        assertEquals("b".repeat(64), stored.fp)
        assertEquals(stored, store.machines.value[1])
    }

    @Test
    fun `replace also drops a different row that is the same machine`() {
        store.add(pinned)
        store.add(mini)
        store.replace("m2", pinned.copy(id = "new", token = "tok-new"))

        assertEquals(listOf("m2"), store.machines.value.map { it.id })
        assertEquals("tok-new", store.machines.value.single().token)
    }

    @Test
    fun `replace of a row that is gone pairs normally`() {
        store.add(mbp)
        store.replace("vanished", pinned)
        assertEquals(listOf("m1", "m3"), store.machines.value.map { it.id })
    }
}
