package com.evenseal.usagedeck

import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.evenseal.usagedeck.core.model.MachineConfig
import com.evenseal.usagedeck.service.DeckGraph
import com.evenseal.usagedeck.ui.components.FROZEN_TAG
import com.evenseal.usagedeck.ui.components.PauseButtonDefaults
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicBoolean
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The one test that exercises the whole app against a daemon it did not write: the real
 * `MachineClient` SSE path, the real `PauseController`, the real `DeckService` and the real
 * Ledger — driven by a finger.
 *
 * The daemon here is a scripted `MockWebServer` rather than the `fakedaemon` module. Ktor CIO does
 * start and serve REST inside an Android process — `FakeDaemonOnDeviceTest` proves that — but its
 * `/v1/events` stream truncates the large `snapshot` frame on-device: the client receives
 * `event: snapshot` and the connection closes before the `data:` line. Until that is fixed the
 * on-device end-to-end has to script its own stream.
 */
@RunWith(AndroidJUnit4::class)
class EndToEndTest {
    @get:Rule
    val compose = createEmptyComposeRule()

    private lateinit var server: MockWebServer
    private lateinit var graph: DeckGraph
    private lateinit var scenario: ActivityScenario<MainActivity>
    private lateinit var config: MachineConfig

    /** Whatever this phone was already paired with, put back in [tearDown]. */
    private var preexisting: List<MachineConfig> = emptyList()

    /** Flipped once the pause has been seen, so the next snapshot shows the session frozen. */
    private val frozen = AtomicBoolean(false)
    private val pauseBodies = CopyOnWriteArrayList<String>()

    @Before
    fun setUp() {
        server = MockWebServer()
        server.dispatcher = daemon()
        server.start()

        config = MachineConfig("m", "fake", server.hostName, server.port, TOKEN)

        val app = InstrumentationRegistry.getInstrumentation()
            .targetContext.applicationContext as UsageDeckApp
        graph = app.graph
        // Take the real machines out of the way so row ordering is predictable, but remember
        // them: this test must never cost a provisioned phone its pairing.
        preexisting = graph.machineStore.machines.value
        preexisting.forEach { graph.machineStore.remove(it.id) }
        graph.machineStore.add(config)

        // Paired before the activity starts the service, exactly as on a phone that reboots into
        // a deck it was already paired with.
        scenario = ActivityScenario.launch(MainActivity::class.java)
        leaveLockTask()
    }

    @After
    fun tearDown() {
        leaveLockTask()
        scenario.close()
        graph.machineStore.remove(config.id)
        preexisting.forEach { graph.machineStore.add(it) }
        runCatching { server.shutdown() }
    }

    @Test
    fun theDeckStreamsTheDaemonPausesASessionAndShowsItFrozen() {
        // 1. The snapshot arrived over SSE and the Ledger rendered the daemon's project.
        awaitUi("the Ledger to show '$PROJECT'") {
            compose.onAllNodesWithText(PROJECT).fetchSemanticsNodes().isNotEmpty()
        }

        // 2. A tap on a session's pause control reaches the daemon as this phone's own rule.
        // In portrait the project starts collapsed; open it (the wide dock has no such header).
        compose.onAllNodesWithContentDescription("expand $PROJECT").fetchSemanticsNodes().firstOrNull()?.let {
            compose.onAllNodesWithContentDescription("expand $PROJECT")[0].performClick()
            compose.waitForIdle()
        }
        val controls = compose.onAllNodesWithContentDescription(
            PauseButtonDefaults.CONTENT_DESCRIPTION,
            useUnmergedTree = true
        )
        // In portrait [0] is the project header and the session is [1]; the wide dock has no header,
        // so the session control is simply the last one either way.
        controls[controls.fetchSemanticsNodes().lastIndex].performClick()

        awaitUi("the daemon to receive a pause for session:$SESSION_ID") {
            pauseBodies.any { it.contains("session:$SESSION_ID") }
        }
        val body = pauseBodies.first { it.contains("session:$SESSION_ID") }
        assertTrue("pause body was '$body'", body.contains("\"reason\":\"usage-deck:"))
        assertTrue("pause body was '$body'", body.contains("\"mode\":\"soft\""))

        // 3. The daemon reports the session hard-paused; the row must say so in words.
        frozen.set(true)
        awaitUi("the row to read '$FROZEN_TAG'") {
            compose.onAllNodesWithText(FROZEN_TAG).fetchSemanticsNodes().isNotEmpty()
        }
    }

    /**
     * On a provisioned phone this app really is Device Owner, so `MainActivity` pins itself and
     * the instrumentation can neither drive nor destroy it. Unpinning is a test-harness concern,
     * not a behaviour change: the deck re-pins on its next resume.
     */
    private fun leaveLockTask() {
        if (!graph.kiosk.isDeviceOwner) return
        runCatching { scenario.onActivity { graph.kiosk.stopLockTask(it) } }
    }

    /** Waits with a failure message that says what the deck actually thought was going on. */
    private fun awaitUi(what: String, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + TIMEOUT_MS
        while (System.currentTimeMillis() < deadline) {
            compose.waitForIdle()
            if (condition()) return
            Thread.sleep(POLL_MS)
        }
        val machine = graph.team.value.machines.firstOrNull()
        throw AssertionError(
            "Timed out waiting for $what. transport=${machine?.transport} health=${machine?.health} " +
                "sessions=${machine?.sessions?.size} lastError=${machine?.lastError} pauses=$pauseBodies"
        )
    }

    private fun daemon() = object : Dispatcher() {
        override fun dispatch(request: RecordedRequest): MockResponse {
            if (request.getHeader("Authorization") != "Bearer $TOKEN") {
                return MockResponse().setResponseCode(401)
                    .setBody("""{"error":{"code":"unauthorized","message":"bad token"}}""")
            }
            val path = request.path.orEmpty().substringBefore('?')
            return when (path) {
                "/v1/events" -> sse()
                "/health" -> json("""{"ok":true,"version":"$VERSION","uptimeMs":1,"pid":1}""")
                "/v1/summary" -> json(summaryJson())
                "/v1/sessions" -> json("""{"rev":$REV,"sessions":[${sessionJson()}]}""")
                "/v1/tokens" -> json("""{"ready":true,"groups":[]}""")
                "/v1/pause/rules" -> json("""{"rev":$REV,"rules":[]}""")
                "/v1/pause" -> {
                    pauseBodies += request.body.readUtf8()
                    json(
                        """{"rule":{"id":"r1","scope":"session:$SESSION_ID","mode":"soft",""" +
                            """"createdAt":"$WHEN","createdBy":"deck"},"affected":["$SESSION_ID"]}"""
                    )
                }
                else -> MockResponse().setResponseCode(404)
            }
        }
    }

    /**
     * One `snapshot` frame, then the stream ends. The client reconnects with backoff and gets a
     * fresh snapshot, which is exactly how the real daemon behaves on every connect — so flipping
     * [frozen] shows up on the next connection.
     */
    private fun sse(): MockResponse = MockResponse()
        .setHeader("Content-Type", "text/event-stream")
        .setBody("retry: 500\n\nid: $REV\nevent: snapshot\ndata: ${snapshotJson()}\n\n")

    private fun json(body: String) = MockResponse()
        .setHeader("Content-Type", "application/json")
        .setBody(body)

    private fun summaryJson() = flat(
        """
        {"limits":{"limits":[$LIMITS],"fetchedAt":"$WHEN","stale":false},
         "status":{"byId":{"session":"ok","weekly_all":"ok"},"overall":"ok"},
         "thresholds":{"warn":80,"critical":95},
         "today":{"input":3114754,"output":1200,"cacheCreate":0,"cacheRead":0,"messages":140}}
        """
    )

    private fun sessionJson(): String {
        val pause = if (frozen.get()) {
            ""","pause":{"mode":"hard","ruleId":"r-freeze","scope":"session:$SESSION_ID",""" +
                """"since":"$WHEN","frozenPids":[],"freezes":1}"""
        } else {
            ""
        }
        return flat(
            """
            {"sessionId":"$SESSION_ID","pid":4242,"alive":true,"discovered":"hook",
             "cwd":"/Users/alan/code/calendarpa",
             "project":{"gitCommonDir":"/Users/alan/code/calendarpa/.git","name":"$PROJECT"},
             "model":"claude-opus-5","startedAt":"$WHEN","lastActivityAt":"$WHEN",
             "tokens":{"input":18422,"output":5310,"cacheCreate":240118,"cacheRead":1904772,
                       "messages":143},
             "lastTool":{"name":"Bash","at":"$WHEN"}$pause}
            """
        )
    }

    private fun snapshotJson() = flat(
        """
        {"name":"fake-mbp","version":"$VERSION",
         "user":{"emailAddress":"alan@evensealproductions.com","accountUuid":"u1",
                 "displayName":"Alan"},
         "summary":${summaryJson()},
         "limits":{"limits":[$LIMITS],"fetchedAt":"$WHEN","stale":false},
         "sessions":[${sessionJson()}],
         "rules":{"rev":$REV,"rules":[]},
         "rev":$REV}
        """
    )

    private companion object {
        const val TOKEN = "fake-token"
        const val VERSION = "0.9.1+deadbee"
        const val SESSION_ID = "3f1c0a52-9d64-4f2e-8b71-2c5a0d9e4411"
        const val PROJECT = "calendarpa"
        const val WHEN = "2026-09-13T14:02:51.000Z"
        const val REV = 7

        const val TIMEOUT_MS = 30_000L
        const val POLL_MS = 200L

        /** An SSE `data:` line must be a single line, so the fixtures are laid out then flattened. */
        fun flat(json: String): String = json.trimIndent().lines().joinToString("") { it.trim() }

        val LIMITS = flat(
            """
            {"id":"session","kind":"session","group":"default","percent":42,"severity":"normal",
             "resetsAt":"2026-09-13T16:35:00.000Z","isActive":true},
            {"id":"weekly_all","kind":"weekly_all","group":"default","percent":18,
             "severity":"normal","resetsAt":"2026-09-17T08:00:00.000Z","isActive":true}
            """
        )
    }
}
