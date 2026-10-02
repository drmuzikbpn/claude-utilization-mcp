package com.evenseal.usagedeck.core.pairing

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class HostValidationTest {
    @Test
    fun `accepts IPv4 literals and DNS names`() {
        listOf("100.101.102.103", "192.168.1.20", "alans-mbp.local", "mbp.tail0fake.ts.net", "localhost").forEach {
            assertTrue("'$it' should be valid", HostValidation.isValid(it))
        }
    }

    @Test
    fun `rejects broken addresses`() {
        listOf("", "100.1.1", "256.1.1.1", "1.2.3.4.5", "-a.local", "a-.local", "a..b", "a b", "::1", "x".repeat(254))
            .forEach { assertFalse("'$it' should be invalid", HostValidation.isValid(it)) }
    }
}
