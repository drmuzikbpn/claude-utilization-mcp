package com.evenseal.usagedeck.pairing

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.evenseal.usagedeck.core.model.MachineConfig
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class MachineStoreTest {
    private lateinit var context: Context
    private lateinit var store: MachineStore

    private val mbp = MachineConfig("m1", "macbook-pro-10", "100.1.1.1", 8787, "tok-1")
    private val mini = MachineConfig("m2", "mac-mini", "100.1.1.2", 8787, "tok-2")

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
        assertEquals("http://100.1.1.1:8787", loaded.baseUrl)
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
        store.rename("m1", "Alan's laptop")

        assertEquals("Alan's laptop", store.machines.value.single().name)
        assertEquals("tok-1", store.machines.value.single().token)
        assertEquals("Alan's laptop", MachineStore.open(context).machines.value.single().name)
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

    @Test
    fun `rows stored before v2 pairing still load, as plain http`() {
        context.getSharedPreferences("legacy-rows", Context.MODE_PRIVATE).edit()
            .putString("machines", """[{"id":"m1","name":"mbp","addr":"100.1.1.1","port":8787,"token":"t"}]""")
            .commit()
        val loaded = MachineStore(
            context.getSharedPreferences("legacy-rows", Context.MODE_PRIVATE)
        ).machines.value.single()
        assertEquals(MachineConfig("m1", "mbp", "100.1.1.1", 8787, "t"), loaded)
        assertEquals("http://100.1.1.1:8787", loaded.baseUrl)
    }

    @Test
    fun `pairing the same key again replaces the row, keeping its id and deck-side name`() {
        store.add(mbp)
        store.add(pinned)
        store.add(mini)
        store.rename("m3", "Studio upstairs")

        val stored = store.pair(pinned.copy(id = "m4", name = "studio", addr = "100.1.1.3", token = "tok-new"))

        assertEquals(listOf("m1", "m3", "m2"), store.machines.value.map { it.id })
        assertEquals(stored, store.machines.value[1])
        assertEquals("tok-new", stored.token)
        assertEquals("100.1.1.3", stored.addr)
        assertEquals("Studio upstairs", stored.name)
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
}
