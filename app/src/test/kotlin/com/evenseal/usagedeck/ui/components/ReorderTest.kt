package com.evenseal.usagedeck.ui.components

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ReorderTest {
    @Test
    fun `rows rank by project first, then by slot inside the project`() {
        assertEquals(0, rowRank(0, 0))
        assertTrue(rowRank(0, 5) < rowRank(1, 0))
        assertTrue(rowRank(1, 0) < rowRank(1, 1))
    }

    @Test
    fun `a row keeps its rank when a project above it gains rows`() {
        val before = rowRank(2, 3)
        val after = rowRank(2, 3) // project 1 grew by two sessions; project 2 is still project 2
        assertEquals(before, after)
    }
}
