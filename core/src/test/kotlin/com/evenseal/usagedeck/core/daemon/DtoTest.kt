package com.evenseal.usagedeck.core.daemon

import com.evenseal.usagedeck.core.model.Discovered
import com.evenseal.usagedeck.core.model.LastTool
import com.evenseal.usagedeck.core.model.LimitStatus
import com.evenseal.usagedeck.core.model.PauseMode
import java.time.Instant
import kotlinx.serialization.decodeFromString
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DtoTest {
    private fun fixture(name: String) = javaClass.getResource("/fixtures/$name")!!.readText()

    @Test
    fun `sessions fixture maps three sessions with pause and lastTool`() {
        val dto = DaemonJson.decodeFromString<SessionsDto>(fixture("sessions.json"))
        assertEquals(42L, dto.rev)
        val s = dto.sessions.map { it.toModel() }
        assertEquals(3, s.size)
        assertEquals("calendarpa", s[0].projectName)
        assertEquals("/Users/alan/code/calendarpa/.git", s[0].projectKey)
        assertEquals(LastTool("Read", Instant.parse("2026-09-13T14:01:58Z")), s[0].lastTool)
        assertEquals("billing", s[1].worktree)
        assertEquals(PauseMode.SOFT, s[1].pause!!.mode)
        assertEquals(Discovered.TRANSCRIPT, s[2].discovered)
        assertFalse(s[2].canHardPause)
        assertEquals("/Users/alan/code/audioleveler", s[2].projectKey) // null gitCommonDir falls back to cwd
    }

    @Test
    fun `summary fixture maps limits with status by id and null resetsAt`() {
        val dto = DaemonJson.decodeFromString<SummaryDto>(fixture("summary.json"))
        val limits = dto.toLimits()
        assertEquals(LimitStatus.WARN, limits.first { it.id == "weekly_all" }.status)
        assertNull(limits.first { it.id == "weekly_scoped:fable" }.resetsAt)
        assertEquals("fable", limits.first { it.id == "weekly_scoped:fable" }.scopeModel)
        assertEquals(4200000L, dto.today.toModel().input)
    }

    @Test
    fun `unknown limit status defaults to OK and unknown keys are ignored`() {
        val json =
            """{"limits":{"limits":[{"id":"x","kind":"x","group":"g","percent":1,"severity":"weird",""" +
                """"resetsAt":null,"scope":null,"isActive":false,"future":1}],""" +
                """"fetchedAt":null,"stale":false,"error":null,""" +
                """"legacyWindows":{},"raw":{}},"status":{"byId":{},"overall":"ok"},""" +
                """"today":{"input":0,"output":0,"cacheCreate":0,"cacheRead":0,"messages":0},"extra":true}"""
        val dto = DaemonJson.decodeFromString<SummaryDto>(json)
        assertEquals(LimitStatus.OK, dto.toLimits().single().status)
    }

    @Test
    fun `status falls back to thresholds when no status map covers the id`() {
        val warn = LimitDto(id = "weekly_all", kind = "weekly_all", percent = 81)
        val critical = LimitDto(id = "session", kind = "session", percent = 96)
        val ok = LimitDto(id = "weekly_scoped:fable", kind = "weekly_scoped", percent = 10)
        val odd = LimitDto(id = "odd", kind = "session", percent = 1, severity = "elevated")
        val t = ThresholdsDto()
        assertEquals(LimitStatus.WARN, statusFor(warn, t))
        assertEquals(LimitStatus.CRITICAL, statusFor(critical, t))
        assertEquals(LimitStatus.OK, statusFor(ok, t))
        assertEquals(LimitStatus.WARN, statusFor(odd, t))
    }

    @Test
    fun `error envelope parses`() {
        val e = DaemonJson.decodeFromString<ErrorEnvelopeDto>(fixture("error-401.json")).error
        assertEquals("unauthorized", e.code)
        assertTrue(e.hint!!.startsWith("Re-run"))
    }

    @Test
    fun `pause response and tokens groups parse`() {
        val p = DaemonJson.decodeFromString<PauseResponseDto>(fixture("pause-rule.json"))
        assertEquals("usage-deck:abc", p.rule.toModel().reason)
        val t = DaemonJson.decodeFromString<TokensDto>(fixture("tokens-project.json"))
        assertEquals("/Users/alan/code/calendarpa", t.groups.single().toModel().label)
    }

    @Test
    fun `health fixture maps user and deferred update`() {
        val dto = DaemonJson.decodeFromString<HealthDto>(fixture("health.json"))
        assertEquals("alans-mbp", dto.name)
        assertEquals("Alan", dto.user!!.toModel().displayName)
        val update = dto.update!!.toModel()
        assertEquals("deferred", update.state)
        assertEquals("hard_frozen_sessions", update.deferredReason)
    }
}
