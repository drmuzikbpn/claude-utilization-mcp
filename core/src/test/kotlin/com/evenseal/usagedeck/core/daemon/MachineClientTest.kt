package com.evenseal.usagedeck.core.daemon

import com.evenseal.usagedeck.core.FakeClock
import com.evenseal.usagedeck.core.model.BurnHistory
import com.evenseal.usagedeck.core.model.Health
import com.evenseal.usagedeck.core.model.MachineConfig
import com.evenseal.usagedeck.core.model.MachineState
import com.evenseal.usagedeck.core.model.PauseMode
import java.time.Instant
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class MachineClientTest {
    private val t0 = Instant.parse("2026-09-13T14:00:00Z")
    private val cfg = MachineConfig("m1", "alans-mbp", "100.68.1.2", 47291, "tok")

    private class FakeApi : DaemonApi {
        val calls = mutableListOf<String>()
        var summaryDto = SummaryDto()
        var sessionsDto = SessionsDto()
        var tokensDto = TokensDto()
        var sessionsEtag: String? = "W/\"9\""
        var failSummary: DaemonException? = null

        override suspend fun health(): HealthDto {
            calls += "health"
            return HealthDto()
        }

        override suspend fun summary(): SummaryDto {
            calls += "summary"
            failSummary?.let { throw it }
            return summaryDto
        }

        override suspend fun sessions(ifNoneMatch: String?): SessionsResult {
            calls += "sessions:$ifNoneMatch"
            return SessionsResult.Changed(sessionsDto, sessionsEtag)
        }

        override suspend fun tokensByProjectToday(): TokensDto {
            calls += "tokens"
            return tokensDto
        }

        override suspend fun pause(scope: String, mode: PauseMode, reason: String): PauseResponseDto {
            calls += "pause:$scope"
            throw DaemonException("not_found", 404, null, null)
        }

        override suspend fun resume(scope: String): ResumeResponseDto {
            calls += "resume:$scope"
            return ResumeResponseDto()
        }

        override suspend fun rules(): RulesDto {
            calls += "rules"
            return RulesDto()
        }
    }

    private class Fixture(val scope: TestScope) {
        val clock = FakeClock(Instant.parse("2026-09-13T14:00:00Z"))
        val api = FakeApi()
        val burn = BurnHistory()
        val events = MutableSharedFlow<Any>(extraBufferCapacity = 64)
        val screenOn = MutableStateFlow(true)
        lateinit var client: MachineClient
    }

    private fun sessionDto(
        id: String,
        input: Long,
        cwd: String = "/Users/alan/code/calendarpa",
        git: String? = "/Users/alan/code/calendarpa/.git"
    ) = SessionDto(
        sessionId = id,
        pid = 1,
        alive = true,
        discovered = "hook",
        cwd = cwd,
        project = ProjectRefDto(git, "calendarpa"),
        startedAt = "2026-09-13T11:00:00Z",
        lastActivityAt = "2026-09-13T11:00:00Z",
        tokens = TokensCountsDto(input = input)
    )

    private fun snapshot(
        sessions: List<SessionDto> = emptyList(),
        rules: List<PauseRuleDto> = emptyList(),
        todayInput: Long = 100,
        percent: Int = 42,
        rev: Long = 7,
        fetchedAt: String? = "2026-09-13T12:00:00Z"
    ) = DaemonEvent.Snapshot(
        name = "alans-mbp",
        version = "0.1.417+3f9c2ab",
        user = UserDto(emailAddress = "alan@example.com", displayName = "Alan"),
        limits = listOf(LimitDto(id = "session", kind = "session", group = "session", percent = percent)),
        status = StatusDto(byId = mapOf("session" to "ok"), overall = "ok"),
        thresholds = ThresholdsDto(),
        today = TokensCountsDto(input = todayInput),
        sessions = sessions,
        rules = rules,
        update = UpdateDto(state = "idle"),
        rev = rev,
        fetchedAt = fetchedAt
    )

    private fun rule(scope: String) = PauseRuleDto(
        id = "r-1",
        scope = scope,
        mode = "soft",
        reason = "usage-deck:abc",
        createdAt = "2026-09-13T14:00:00Z",
        createdBy = "dashboard"
    )

    private fun TestScope.fixture(): Fixture {
        val f = Fixture(this)
        f.client = MachineClient(
            config = cfg,
            api = f.api,
            eventSource = { f.events },
            burn = f.burn,
            clock = f.clock,
            scope = backgroundScope,
            screenOn = f.screenOn,
            tickerMs = 1000
        )
        f.client.start()
        runCurrent()
        return f
    }

    @Test
    fun `snapshot populates state and marks SSE`() = runTest {
        val f = fixture()
        f.events.emit(Connection.Open)
        f.events.emit(snapshot(sessions = listOf(sessionDto("s1", 1000))))
        runCurrent()
        val s = f.client.state.value
        assertEquals("alans-mbp", s.name)
        assertEquals("0.1.417+3f9c2ab", s.version)
        assertEquals("Alan", s.user!!.displayName)
        assertEquals(1, s.limits.size)
        // The daemon's own fetch time, not this phone's clock: the team merge compares two
        // machines' copies of the same account, so a local stamp would make the last machine to
        // reconnect always look freshest.
        assertEquals(Instant.parse("2026-09-13T12:00:00Z"), s.limitsFetchedAt)
        assertEquals(100L, s.today.input)
        assertEquals(1, s.sessions.size)
        assertEquals("idle", s.update!!.state)
        assertEquals(7L, s.rev)
        assertEquals(MachineState.Transport.SSE, s.transport)
        assertEquals(Health.FRESH, s.health)
    }

    @Test
    fun `a snapshot without a fetch time leaves it unknown rather than claiming now`() = runTest {
        val f = fixture()
        f.events.emit(Connection.Open)
        f.events.emit(snapshot(fetchedAt = null))
        runCurrent()
        assertNull(f.client.state.value.limitsFetchedAt)
    }

    @Test
    fun `heartbeat refreshes lastHeartbeatAt and health goes fresh`() = runTest {
        val f = fixture()
        f.events.emit(Connection.Open)
        f.events.emit(snapshot())
        runCurrent()
        f.clock.advance(45)
        advanceTimeBy(45_000)
        runCurrent()
        assertEquals(Health.STALE, f.client.state.value.health)

        f.events.emit(DaemonEvent.Heartbeat(rev = 9, at = "2026-09-13T14:00:45.000Z"))
        runCurrent()
        assertEquals(f.clock.now(), f.client.state.value.lastHeartbeatAt)
        assertEquals(Health.FRESH, f.client.state.value.health)
        assertEquals("the heartbeat's rev advances the sessions revision", 9L, f.client.state.value.rev)
    }

    @Test
    fun `no heartbeat for 120s marks dead`() = runTest {
        val f = fixture()
        f.events.emit(Connection.Open)
        f.events.emit(snapshot())
        runCurrent()
        f.clock.advance(120)
        advanceTimeBy(120_000)
        runCurrent()
        assertEquals(Health.DEAD, f.client.state.value.health)
    }

    @Test
    fun `session update upserts and records burn`() = runTest {
        val f = fixture()
        f.events.emit(Connection.Open)
        f.events.emit(snapshot(sessions = listOf(sessionDto("s1", 1_000))))
        runCurrent()

        f.clock.advance(60)
        f.events.emit(DaemonEvent.SessionChange("update", sessionDto("s1", 4_000)))
        runCurrent()
        assertEquals(1, f.client.state.value.sessions.size)
        assertEquals(4_000L, f.client.state.value.sessions.single().tokens.input)
        assertEquals(3000.0, f.burn.ratePerMinute(f.client.burnKeyForSession("s1"), f.clock.now()), 0.01)
        assertEquals(
            3000.0,
            f.burn.ratePerMinute(f.client.burnKeyForProject("/Users/alan/code/calendarpa/.git"), f.clock.now()),
            0.01
        )

        f.events.emit(DaemonEvent.SessionChange("start", sessionDto("s2", 500)))
        runCurrent()
        assertEquals(2, f.client.state.value.sessions.size)
    }

    @Test
    fun `session end removes`() = runTest {
        val f = fixture()
        f.events.emit(Connection.Open)
        f.events.emit(snapshot(sessions = listOf(sessionDto("s1", 1_000), sessionDto("s2", 20))))
        runCurrent()
        assertEquals(2, f.client.state.value.sessions.size)

        f.events.emit(DaemonEvent.SessionChange("end", sessionDto("s1", 1_000)))
        runCurrent()
        assertEquals(listOf("s2"), f.client.state.value.sessions.map { it.sessionId })
    }

    @Test
    fun `spend replaces today total`() = runTest {
        val f = fixture()
        f.events.emit(Connection.Open)
        f.events.emit(snapshot(todayInput = 100))
        runCurrent()
        f.clock.advance(60)
        f.events.emit(
            DaemonEvent.Spend(TokensCountsDto(input = 3_100), TokensCountsDto(input = 3_000))
        )
        runCurrent()
        assertEquals(3_100L, f.client.state.value.today.input)
        assertEquals(3000.0, f.burn.ratePerMinute(f.client.burnKeyForMachine(), f.clock.now()), 0.01)
    }

    @Test
    fun `pause event replaces rules and refetches sessions`() = runTest {
        val f = fixture()
        f.api.sessionsDto = SessionsDto(rev = 9, sessions = listOf(sessionDto("s1", 1_000)))
        f.events.emit(Connection.Open)
        f.events.emit(snapshot())
        runCurrent()

        f.events.emit(DaemonEvent.Pause(listOf(rule("all")), listOf("s1")))
        runCurrent()
        assertEquals(1, f.client.state.value.rules.size)
        assertEquals(PauseMode.SOFT, f.client.state.value.rules.single().mode)
        assertTrue(f.api.calls.contains("sessions:null"))
        assertEquals(1, f.client.state.value.sessions.size)
    }

    @Test
    fun `limits and spend never move the sessions revision`() = runTest {
        val f = fixture()
        f.api.sessionsDto = SessionsDto(rev = 813, sessions = listOf(sessionDto("s1", 1_000)))
        f.events.emit(Connection.Open)
        f.events.emit(snapshot(rev = 812))
        runCurrent()
        assertEquals(812L, f.client.state.value.rev)

        f.events.emit(DaemonEvent.Limits(listOf(LimitDto(id = "session", kind = "session", percent = 99)), null, false))
        f.events.emit(DaemonEvent.Spend(TokensCountsDto(input = 99), TokensCountsDto(input = 9)))
        runCurrent()
        assertEquals("rev only moves on session or pause changes", 812L, f.client.state.value.rev)
        assertEquals(99, f.client.state.value.limits.single().percent)
        assertEquals(99L, f.client.state.value.today.input)

        // a pause does change it, via the sessions re-read it triggers
        f.events.emit(DaemonEvent.Pause(listOf(rule("all")), listOf("s1")))
        runCurrent()
        assertEquals(813L, f.client.state.value.rev)
    }

    @Test
    fun `update event replaces update state`() = runTest {
        val f = fixture()
        f.events.emit(Connection.Open)
        f.events.emit(snapshot())
        runCurrent()
        f.events.emit(DaemonEvent.Update(UpdateDto(state = "deferred", deferredReason = "hard_frozen_sessions")))
        runCurrent()
        assertEquals("deferred", f.client.state.value.update!!.state)
        assertEquals("hard_frozen_sessions", f.client.state.value.update!!.deferredReason)
    }

    @Test
    fun `two failed connects switch to polling and poll summary and sessions with etag`() = runTest {
        val f = fixture()
        val err = DaemonException("network", 0, "refused", null)
        f.events.emit(Connection.Closed(err))
        runCurrent()
        assertEquals(MachineState.Transport.DISCONNECTED, f.client.state.value.transport)
        // hint → message → per-code default
        assertEquals("refused", f.client.state.value.lastError)
        assertEquals(
            "Machine unreachable.",
            DaemonException("network", 0, null, null).userMessage()
        )

        advanceTimeBy(3_100)
        runCurrent()
        f.events.emit(Connection.Closed(err))
        runCurrent()

        assertEquals(MachineState.Transport.POLLING, f.client.state.value.transport)
        assertTrue(f.api.calls.contains("summary"))
        assertTrue(f.api.calls.contains("sessions:null"))

        // the etag from the first poll is sent on the next one
        advanceTimeBy(2_100)
        runCurrent()
        assertTrue(f.api.calls.contains("sessions:W/\"9\""))
    }

    @Test
    fun `polling interval is 2s when screen on and 30s when off`() = runTest {
        val f = fixture()
        val err = DaemonException("network", 0, "refused", null)
        f.events.emit(Connection.Closed(err))
        runCurrent()
        advanceTimeBy(3_100)
        runCurrent()
        f.events.emit(Connection.Closed(err))
        runCurrent()

        val afterFirstPoll = f.api.calls.count { it == "summary" }
        assertEquals(1, afterFirstPoll)
        advanceTimeBy(2_100)
        runCurrent()
        assertEquals(2, f.api.calls.count { it == "summary" })

        f.screenOn.value = false
        advanceTimeBy(2_100)
        runCurrent()
        assertEquals(3, f.api.calls.count { it == "summary" })
        advanceTimeBy(2_100)
        runCurrent()
        assertEquals("no extra poll within 2 s while the screen is off", 3, f.api.calls.count { it == "summary" })
        advanceTimeBy(30_100)
        runCurrent()
        assertEquals(4, f.api.calls.count { it == "summary" })
    }

    @Test
    fun `successful reconnect returns to SSE and replaces state from snapshot`() = runTest {
        val f = fixture()
        val err = DaemonException("network", 0, "refused", null)
        f.events.emit(Connection.Closed(err))
        runCurrent()
        advanceTimeBy(3_100)
        runCurrent()
        f.events.emit(Connection.Closed(err))
        runCurrent()
        assertEquals(MachineState.Transport.POLLING, f.client.state.value.transport)

        advanceTimeBy(6_100)
        runCurrent()
        f.events.emit(Connection.Open)
        f.events.emit(snapshot(sessions = listOf(sessionDto("s9", 7)), rev = 21))
        runCurrent()
        val pollsWhileDown = f.api.calls.count { it == "summary" }

        assertEquals(MachineState.Transport.SSE, f.client.state.value.transport)
        assertEquals(21L, f.client.state.value.rev)
        assertEquals(listOf("s9"), f.client.state.value.sessions.map { it.sessionId })
        assertNull(f.client.state.value.lastError)

        advanceTimeBy(10_000)
        runCurrent()
        assertEquals("polling stops once SSE is back", pollsWhileDown, f.api.calls.count { it == "summary" })
    }

    @Test
    fun `project tokens refresh every 30s`() = runTest {
        val f = fixture()
        f.events.emit(Connection.Open)
        f.events.emit(snapshot())
        runCurrent()
        // fetched once as soon as the client starts
        assertEquals(1, f.api.calls.count { it == "tokens" })
        assertTrue(f.client.state.value.projectTokens.isEmpty())

        f.api.tokensDto = TokensDto(
            groups = listOf(
                TokensGroupDto(key = "-Users-alan-code-calendarpa", label = "/Users/alan/code/calendarpa", input = 5)
            )
        )
        advanceTimeBy(30_100)
        runCurrent()
        assertEquals(2, f.api.calls.count { it == "tokens" })
        assertEquals(1, f.client.state.value.projectTokens.size)
        assertEquals("/Users/alan/code/calendarpa", f.client.state.value.projectTokens.single().label)
        assertEquals(5L, f.client.state.value.projectTokens.single().tokens.input)

        advanceTimeBy(30_100)
        runCurrent()
        assertEquals(3, f.api.calls.count { it == "tokens" })
    }

    @Test
    fun `polling errors land in lastError and never crash the client`() = runTest {
        val f = fixture()
        f.api.failSummary = DaemonException("unauthorized", 401, null, null)
        val err = DaemonException("network", 0, "refused", null)
        f.events.emit(Connection.Closed(err))
        runCurrent()
        advanceTimeBy(3_100)
        runCurrent()
        f.events.emit(Connection.Closed(err))
        runCurrent()
        assertEquals("Token rejected. Re-run pairing on the Mac.", f.client.state.value.lastError)
        assertNotNull(f.client.state.value)
    }
}
