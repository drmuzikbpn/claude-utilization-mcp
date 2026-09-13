package com.evenseal.usagedeck.ui

import com.evenseal.usagedeck.core.Clock
import com.evenseal.usagedeck.core.daemon.DaemonApi
import com.evenseal.usagedeck.core.daemon.HealthDto
import com.evenseal.usagedeck.core.daemon.MachineClient
import com.evenseal.usagedeck.core.daemon.PauseResponseDto
import com.evenseal.usagedeck.core.daemon.ResumeResponseDto
import com.evenseal.usagedeck.core.daemon.RulesDto
import com.evenseal.usagedeck.core.daemon.SessionsResult
import com.evenseal.usagedeck.core.daemon.SummaryDto
import com.evenseal.usagedeck.core.daemon.TokensDto
import com.evenseal.usagedeck.core.model.BurnHistory
import com.evenseal.usagedeck.core.model.MachineConfig
import com.evenseal.usagedeck.core.model.PauseMode
import java.time.Instant
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.emptyFlow
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The UI builds burn keys without holding a `MachineClient`. If Track A ever changes the key
 * scheme, this test fails rather than the sparklines silently going flat.
 */
class BurnKeysContractTest {
    private val config = MachineConfig("m1", "mbp", "100.1.1.1", 8787, "t")

    private val client = MachineClient(
        config = config,
        api = NoopApi,
        eventSource = { emptyFlow() },
        burn = BurnHistory(),
        clock = Clock { Instant.EPOCH },
        scope = CoroutineScope(Dispatchers.Unconfined),
        screenOn = MutableStateFlow(true)
    )

    @Test
    fun `session key matches the client`() {
        assertEquals(client.burnKeyForSession("s1"), BurnKeys.session(config.id, "s1"))
    }

    @Test
    fun `project key matches the client`() {
        assertEquals(client.burnKeyForProject("/repo"), BurnKeys.project(config.id, "/repo"))
    }

    @Test
    fun `machine key matches the client`() {
        assertEquals(client.burnKeyForMachine(), BurnKeys.machine(config.id))
    }

    /** The client is never started here, so nothing on this api is ever called. */
    private object NoopApi : DaemonApi {
        override suspend fun health(): HealthDto = error("unused")

        override suspend fun summary(): SummaryDto = error("unused")

        override suspend fun sessions(ifNoneMatch: String?): SessionsResult = error("unused")

        override suspend fun tokensByProjectToday(): TokensDto = error("unused")

        override suspend fun pause(scope: String, mode: PauseMode, reason: String): PauseResponseDto = error("unused")

        override suspend fun resume(scope: String): ResumeResponseDto = error("unused")

        override suspend fun rules(): RulesDto = error("unused")
    }
}
