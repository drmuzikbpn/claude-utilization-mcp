package com.evenseal.usagedeck.ui

import com.evenseal.usagedeck.ui.project.oneSigFig
import com.evenseal.usagedeck.ui.project.share
import org.junit.Assert.assertEquals
import org.junit.Test

class ProjectMathTest {
    @Test
    fun `share is a rounded percentage of the machine's day`() {
        assertEquals("61%", share(1_900_000, 3_114_754))
        assertEquals("100%", share(10, 10))
        assertEquals("50%", share(5, 10))
    }

    @Test
    fun `share is a dash when the machine reported nothing today`() {
        assertEquals("—", share(1_900_000, 0))
        assertEquals("—", share(0, 0))
    }

    @Test
    fun `share never exceeds what the numbers say`() {
        // The daemon can report a project total ahead of the machine roll-up mid-refresh.
        assertEquals("120%", share(12, 10))
    }

    @Test
    fun `one significant figure rounds the chart's top label`() {
        assertEquals(40_000L, oneSigFig(38_000.0))
        assertEquals(4_000L, oneSigFig(4_200.0))
        assertEquals(1_000L, oneSigFig(1_000.0))
        assertEquals(2_000_000L, oneSigFig(1_900_000.0))
    }

    @Test
    fun `one significant figure of nothing is zero`() {
        assertEquals(0L, oneSigFig(0.0))
        assertEquals(0L, oneSigFig(-5.0))
    }
}
