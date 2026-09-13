package com.evenseal.usagedeck.pause

import android.content.Context
import android.content.SharedPreferences
import androidx.test.core.app.ApplicationProvider
import com.evenseal.usagedeck.core.pause.Escalation
import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class PrefsEscalationStoreTest {
    private lateinit var prefs: SharedPreferences
    private lateinit var store: PrefsEscalationStore

    private val a = Escalation("m1", "session:abc", Instant.parse("2026-09-13T10:01:30Z"))
    private val b = Escalation("m2", "all", Instant.parse("2026-09-13T10:02:00Z"))

    @Before
    fun setUp() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        prefs = context.getSharedPreferences("escalations_test", Context.MODE_PRIVATE)
        prefs.edit().clear().commit()
        store = PrefsEscalationStore(prefs)
    }

    @Test
    fun `loads empty before anything is saved`() {
        assertTrue(store.load().isEmpty())
    }

    @Test
    fun `save then load round-trips every field`() {
        store.save(listOf(a, b))
        assertEquals(listOf(a, b), store.load())
    }

    @Test
    fun `a fresh store over the same prefs sees the saved list`() {
        store.save(listOf(a))
        assertEquals(listOf(a), PrefsEscalationStore(prefs).load())
    }

    @Test
    fun `saving an empty list clears the persisted escalations`() {
        store.save(listOf(a, b))
        store.save(emptyList())
        assertTrue(PrefsEscalationStore(prefs).load().isEmpty())
    }

    @Test
    fun `unreadable json degrades to empty rather than crashing the service`() {
        prefs.edit().putString("escalations", "{not json").commit()
        assertTrue(store.load().isEmpty())
    }
}
