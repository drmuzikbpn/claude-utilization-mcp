package com.evenseal.usagedeck.alerts

import kotlin.math.abs
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ChimeTest {
    @Test
    fun `the chime is short quiet and ends in silence`() {
        val pcm = Chime.pcm()
        assertEquals((44_100 * 0.16).toInt() * 2, pcm.size)
        val peak = pcm.maxOf { abs(it.toInt()) }
        assertTrue("peak $peak should stay well under full scale", peak < Short.MAX_VALUE * 0.35)
        assertTrue(abs(pcm.last().toInt()) < 200)
        assertEquals(0, pcm.first().toInt())
    }
}
