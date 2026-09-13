package com.evenseal.usagedeck.core.update

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class VersionTest {
    @Test
    fun `parses the commit-stamped scheme with a leading v`() {
        val v = Version.parse("v0.1.417+3f9c2ab")!!
        assertEquals(0, v.major)
        assertEquals(1, v.minor)
        assertEquals(417, v.build)
        assertEquals("3f9c2ab", v.sha)
    }

    @Test
    fun `parses without the v and without a sha`() {
        assertEquals(Version(0, 1, 417, "3f9c2ab"), Version.parse("0.1.417+3f9c2ab"))
        assertEquals(Version(0, 1, 417, ""), Version.parse("0.1.417"))
    }

    @Test
    fun `garbage does not parse`() {
        assertNull(Version.parse("garbage"))
        assertNull(Version.parse(""))
        assertNull(Version.parse("0.1"))
        assertNull(Version.parse("v.x.y+z"))
    }

    @Test
    fun `build number orders versions and the sha is ignored`() {
        val older = Version.parse("0.1.417+zzzzzzz")!!
        val newer = Version.parse("0.1.418+aaaaaaa")!!
        assertTrue(newer > older)
        assertTrue(older < newer)
        assertEquals(0, Version.parse("0.1.418+aaaaaaa")!!.compareTo(Version.parse("0.1.418+bbbbbbb")!!))
    }

    @Test
    fun `major and minor beat build`() {
        assertTrue(Version.parse("0.2.1")!! > Version.parse("0.1.999")!!)
        assertTrue(Version.parse("1.0.0")!! > Version.parse("0.9.999")!!)
    }
}
