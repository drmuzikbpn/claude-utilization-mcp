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
    private fun fixture(name: String) = Fixtures.text(name)

    @Test
    fun `sessions fixture maps three sessions with pause and lastTool`() {
        val dto = DaemonJson.decodeFromString<SessionsDto>(fixture("sessions.json"))
        assertEquals(812L, dto.rev)
        val s = dto.sessions.map { it.toModel() }
        assertEquals(3, s.size)

        // worktree of a repo: the project key is the shared gitCommonDir, not the worktree cwd
        assertEquals("foo", s[0].projectName)
        assertEquals("/Users/alan/code/foo/.git", s[0].projectKey)
        assertEquals("foo-wt2", s[0].worktree)
        assertEquals(LastTool("Bash", Instant.parse("2026-09-13T14:02:50Z")), s[0].lastTool)
        assertEquals(PauseMode.HARD, s[0].pause!!.mode)
        assertEquals("r_k3m7qz4ub2ah6ptc", s[0].pause!!.ruleId)
        assertEquals(listOf(4242, 4251, 4252), s[0].pause!!.frozenPids)
        assertEquals(Instant.parse("2026-09-13T14:03:10Z"), s[0].pause!!.since)
        assertTrue(s[0].canHardPause)

        // the main worktree of the same repo groups under the same key
        assertEquals("/Users/alan/code/foo/.git", s[1].projectKey)
        assertNull(s[1].worktree)
        assertNull(s[1].pause)
        assertNull(s[1].lastTool)

        assertEquals(Discovered.TRANSCRIPT, s[2].discovered)
        assertFalse(s[2].alive)
        assertFalse(s[2].canHardPause)
        assertEquals("/Users/alan/code/notes", s[2].projectKey) // null gitCommonDir falls back to cwd
        assertEquals("notes", s[2].projectName)
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
        val e = DaemonJson.decodeFromString<ErrorEnvelopeDto>(Fixtures.errorBody("unauthorized")).error
        assertEquals("unauthorized", e.code)
        assertEquals(401, Fixtures.errorStatus("unauthorized"))
        assertTrue(e.message!!.startsWith("a valid Authorization"))
        assertTrue(e.hint!!.startsWith("mutating requests"))
    }

    @Test
    fun `every documented error case carries a code and a non-empty message`() {
        listOf("unauthorized", "untrusted_pid", "foreign_uid", "dead_session", "unknown_rule", "unknown_session")
            .forEach { name ->
                val e = DaemonJson.decodeFromString<ErrorEnvelopeDto>(Fixtures.errorBody(name)).error
                assertTrue(name, e.code.isNotBlank())
                assertTrue(name, e.message!!.isNotBlank())
            }
        assertEquals(409, Fixtures.errorStatus("untrusted_pid"))
        assertEquals(410, Fixtures.errorStatus("dead_session"))
        assertEquals(404, Fixtures.errorStatus("unknown_rule"))
        assertEquals(
            "conflict",
            DaemonJson.decodeFromString<ErrorEnvelopeDto>(Fixtures.errorBody("untrusted_pid")).error.code
        )
        assertEquals(
            "gone",
            DaemonJson.decodeFromString<ErrorEnvelopeDto>(Fixtures.errorBody("dead_session")).error.code
        )
    }

    @Test
    fun `pause response and tokens groups parse`() {
        val p = DaemonJson.decodeFromString<PauseResponseDto>(fixture("pause-response.json"))
        assertEquals("usage-deck:9f21c4ab", p.rule.toModel().reason)
        assertEquals(PauseMode.HARD, p.rule.toModel().mode)
        assertEquals("session:3f1c0a52-9d64-4f2e-8b71-2c5a0d9e4411", p.rule.toModel().scope)
        assertEquals(listOf("3f1c0a52-9d64-4f2e-8b71-2c5a0d9e4411"), p.affected)

        val t = DaemonJson.decodeFromString<TokensDto>(fixture("tokens-project.json"))
        assertEquals("/Users/alan/code/calendarpa", t.groups.single().toModel().label)
    }

    @Test
    fun `pause rules and resume response parse the three scope shapes`() {
        val rules = DaemonJson.decodeFromString<RulesDto>(fixture("pause-rules.json"))
        assertEquals(814L, rules.rev)
        assertEquals(
            listOf(
                "session:3f1c0a52-9d64-4f2e-8b71-2c5a0d9e4411",
                "project:/Users/alan/code/foo/.git",
                "all"
            ),
            rules.rules.map { it.toModel().scope }
        )
        assertEquals(PauseMode.HARD, rules.rules[0].toModel().mode)
        assertEquals("cli", rules.rules[1].toModel().createdBy)
        assertEquals("", rules.rules[2].toModel().reason)

        val resume = DaemonJson.decodeFromString<ResumeResponseDto>(fixture("resume-response.json"))
        assertEquals(listOf("r_k3m7qz4ub2ah6ptc"), resume.removed)
        assertEquals(listOf("3f1c0a52-9d64-4f2e-8b71-2c5a0d9e4411"), resume.resumed)
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
