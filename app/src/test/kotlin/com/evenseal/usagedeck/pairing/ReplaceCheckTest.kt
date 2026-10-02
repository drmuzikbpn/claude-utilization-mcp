package com.evenseal.usagedeck.pairing

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ReplaceCheckTest {
    @Test
    fun `the same machine needs no confirmation`() {
        assertFalse(ReplaceCheck.needsConfirm(listOf("studio", "studio.local"), "Studio"))
        assertFalse(ReplaceCheck.needsConfirm(listOf("studio.tail0fake.ts.net"), "studio"))
    }

    @Test
    fun `a different machine asks first`() {
        assertTrue(ReplaceCheck.needsConfirm(listOf("studio"), "alans-mbp"))
    }

    @Test
    fun `nothing to replace never asks`() {
        assertFalse(ReplaceCheck.needsConfirm(emptyList(), "alans-mbp"))
    }
}
