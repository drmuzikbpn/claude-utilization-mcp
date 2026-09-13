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
}
