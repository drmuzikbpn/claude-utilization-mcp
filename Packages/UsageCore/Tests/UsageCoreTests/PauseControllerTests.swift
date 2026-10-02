import Foundation
import Synchronization
import Testing
@testable import UsageCore

/// A scripted daemon: records every call, optionally fails a number of them.
final class FakeAPI: DaemonAPI {
    struct Script {
        var calls: [String] = []
        var failures = 0
        var failWith = DaemonError.network
        /// Resume calls for these scopes always throw `failWith`.
        var refuseResume: Set<String> = []
        var summary = SummaryDTO()
        var sessions: SessionsResult = .unchanged
        var tokens = TokensDTO()
        var health = HealthDTO()
        var down = false
    }

    let deviceId: String
    let script = Mutex(Script())

    init(_ deviceId: String) {
        self.deviceId = deviceId
    }

    var calls: [String] {
        script.withLock { $0.calls }
    }

    func edit(_ change: (inout Script) -> Void) {
        script.withLock { change(&$0) }
    }

    private func gate(_ call: String) throws {
        try script.withLock { s in
            s.calls.append(call)
            if s.down {
                throw DaemonError.network
            }
            if s.failures > 0 {
                s.failures -= 1
                throw s.failWith
            }
        }
    }

    func health() async throws -> HealthDTO {
        try gate("health")
        return script.withLock { $0.health }
    }

    func summary() async throws -> SummaryDTO {
        try gate("summary")
        return script.withLock { $0.summary }
    }

    func sessions(ifNoneMatch: String?) async throws -> SessionsResult {
        try gate("sessions:\(ifNoneMatch ?? "-")")
        return script.withLock { $0.sessions }
    }

    func tokensByProjectToday() async throws -> TokensDTO {
        try gate("tokens")
        return script.withLock { $0.tokens }
    }

    func pause(scope: String, mode: PauseMode, reason: String) async throws -> PauseResponseDTO {
        try gate("pause:\(scope):\(mode.rawValue):\(reason)")
        return PauseResponseDTO(rule: PauseRuleDTO(
            id: "r-\(deviceId)",
            scope: scope,
            mode: mode.rawValue,
            reason: reason,
            createdAt: "2026-09-13T14:00:00Z"
        ))
    }

    func resume(scope: String) async throws -> ResumeResponseDTO {
        let refused = script.withLock { s -> DaemonError? in
            s.refuseResume.contains(scope) ? s.failWith : nil
        }
        if let refused {
            script.withLock { $0.calls.append("resume:\(scope)") }
            throw refused
        }
        try gate("resume:\(scope)")
        return ResumeResponseDTO()
    }

    func rules() async throws -> RulesDTO {
        try gate("rules")
        return RulesDTO()
    }
}

@MainActor
final class PauseFixture {
    let clock = ManualClock(t0)
    var team = TeamState()
    var escalationSeconds: Int? = 90
    let store = InMemoryEscalationStore()
    var apis: [String: FakeAPI] = [:]
    lazy var controller = PauseController(
        team: { [unowned self] in team },
        apis: { [unowned self] id in apis[id] },
        installId: "abc",
        store: store,
        clock: clock,
        escalationSeconds: { [unowned self] in escalationSeconds },
        retryDelay: .milliseconds(1)
    )

    init(_ devices: [DeviceState], escalationSeconds: Int? = 90, restore: [Escalation] = []) {
        team = TeamState(devices: devices)
        self.escalationSeconds = escalationSeconds
        for d in devices {
            apis[d.id] = FakeAPI(d.id)
        }
        if !restore.isEmpty {
            store.save(restore)
        }
    }

    func api(_ id: String) -> FakeAPI {
        apis[id]!
    }
}

let reason = "usage-deck:abc"

func rule(_ scope: String, reason ruleReason: String? = "usage-deck:abc", mode: PauseMode = .soft) -> PauseRule {
    PauseRule(id: "r-1", scope: scope, mode: mode, reason: ruleReason, createdAt: t0, createdBy: "dashboard")
}

@MainActor
struct PauseControllerTests {
    @Test func softSessionPostsToItsOwnDeviceWithTheInstallReason() async {
        let f = PauseFixture([device("m1", sessions: [session("s1")]), device("m2")])
        let outcomes = await f.controller.soft(.session(deviceId: "m1", sessionId: "s1"))
        #expect(outcomes == [PauseOutcome(deviceId: "m1", ok: true, error: nil)])
        #expect(f.api("m1").calls == ["pause:session:s1:soft:\(reason)"])
        #expect(f.api("m2").calls.isEmpty)
        #expect(f.controller.inFlight.isEmpty)
    }

    @Test func aProjectScopeGoesToOneDeviceOnly() async {
        let f = PauseFixture([device("m1", sessions: [session("s1")]), device("m2")])
        await f.controller.soft(.project(deviceId: "m1", projectKey: "/g/.git"))
        #expect(f.api("m1").calls == ["pause:project:/g/.git:soft:\(reason)"])
        #expect(f.api("m2").calls.isEmpty)
    }

    @Test func softSchedulesAnEscalationThatFiresHardAfter90Seconds() async throws {
        let f = PauseFixture([device("m1", sessions: [session("s1")])])
        await f.controller.soft(.session(deviceId: "m1", sessionId: "s1"))
        let pending = try #require(f.controller.pending.first)
        #expect(pending == Escalation(deviceId: "m1", scope: "session:s1", fireAt: t0.addingTimeInterval(90)))
        #expect(f.controller.escalation(for: .session(deviceId: "m1", sessionId: "s1")) != nil)
        #expect(f.store.load().count == 1)

        // The daemon echoes the rule back through the team state.
        let soft = PauseState(mode: .soft, ruleId: "r-1", scope: "session:s1", since: t0, frozenPids: [])
        f.team = TeamState(devices: [device("m1", sessions: [session("s1", pause: soft)], rules: [rule("session:s1")])])
        await f.controller.tick()
        #expect(!f.api("m1").calls.contains("pause:session:s1:hard:\(reason)"), "not due yet")

        f.clock.advance(seconds: 90)
        await f.controller.tick()
        #expect(f.api("m1").calls.contains("pause:session:s1:hard:\(reason)"))
        #expect(f.controller.pending.isEmpty)
        #expect(f.store.load().isEmpty)
    }

    @Test func resumeCancelsAPendingEscalation() async {
        let f = PauseFixture([device("m1", sessions: [session("s1")])])
        await f.controller.soft(.session(deviceId: "m1", sessionId: "s1"))
        await f.controller.resume(.session(deviceId: "m1", sessionId: "s1"))
        #expect(f.controller.pending.isEmpty)
        #expect(f.store.load().isEmpty)
        #expect(f.api("m1").calls.contains("resume:session:s1"))
        f.clock.advance(seconds: 300)
        await f.controller.tick()
        #expect(!f.api("m1").calls.contains { $0.contains(":hard:") })
    }

    @Test func aRuleVanishingFromTheTeamCancelsTheEscalation() async {
        let f = PauseFixture([device("m1", sessions: [session("s1")])])
        await f.controller.soft(.session(deviceId: "m1", sessionId: "s1"))
        f.team = TeamState(devices: [device("m1", sessions: [session("s1")], rules: [rule("session:s1")])])
        await f.controller.tick()
        #expect(f.controller.pending.count == 1)

        // Somebody resumed from the CLI: the rule disappears.
        f.team = TeamState(devices: [device("m1", sessions: [session("s1")])])
        await f.controller.tick()
        #expect(f.controller.pending.isEmpty)
        #expect(f.store.load().isEmpty)
        f.clock.advance(seconds: 300)
        await f.controller.tick()
        #expect(!f.api("m1").calls.contains { $0.contains(":hard:") })
    }

    @Test func aForeignSoftPauseNeverEscalates() async {
        let foreign = PauseState(mode: .soft, ruleId: "r-cli", scope: "session:s1", since: t0, frozenPids: [])
        let f = PauseFixture([device("m1", sessions: [session("s1", pause: foreign)], rules: [rule("session:s1", reason: "cli")])])
        f.clock.advance(seconds: 600)
        await f.controller.tick()
        #expect(f.controller.pending.isEmpty)
        #expect(f.api("m1").calls.isEmpty)
    }

    @Test func escalationOffDisablesScheduling() async {
        let f = PauseFixture([device("m1", sessions: [session("s1")])], escalationSeconds: nil)
        await f.controller.soft(.session(deviceId: "m1", sessionId: "s1"))
        #expect(f.controller.pending.isEmpty)
        f.clock.advance(seconds: 600)
        await f.controller.tick()
        #expect(!f.api("m1").calls.contains { $0.contains(":hard:") })
    }

    @Test func allFansOutToLiveDevicesOnlyAndRetriesOnce() async {
        let f = PauseFixture([
            device("m1", health: .fresh, sessions: [session("s1")]),
            device("m2", health: .stale),
            device("m3", health: .dead),
        ])
        f.api("m2").edit { $0.failures = 1 }
        let outcomes = await f.controller.soft(.all)
        #expect(outcomes.map(\.deviceId) == ["m1", "m2"])
        #expect(outcomes.allSatisfy { $0.ok })
        #expect(f.api("m1").calls.count == 1)
        #expect(f.api("m2").calls.count == 2, "the failed device is retried exactly once")
        #expect(f.api("m3").calls.isEmpty)
        #expect(f.controller.lastOutcomes == outcomes)
    }

    @Test func allReportsTheDeviceThatStaysDown() async {
        let f = PauseFixture([device("m1"), device("m2")])
        f.api("m2").edit { $0.failures = 2 }
        let outcomes = await f.controller.soft(.all)
        #expect(outcomes.filter { !$0.ok } == [PauseOutcome(deviceId: "m2", ok: false, error: "Device unreachable.")])
        #expect(f.controller.pending.map(\.deviceId) == ["m1"])
    }

    @Test func hardOnATranscriptSessionIsRefusedLocally() async {
        let f = PauseFixture([device("m1", sessions: [session("s1", discovered: .transcript, pid: nil)])])
        let outcome = await f.controller.hard(.session(deviceId: "m1", sessionId: "s1")).first
        #expect(outcome?.ok == false)
        #expect(outcome?.error == DaemonError.defaults["conflict"])
        #expect(f.api("m1").calls.isEmpty)
    }

    @Test func tapOnAPausedTargetResumes() async {
        let paused = PauseState(mode: .soft, ruleId: "r-1", scope: "session:s1", since: t0, frozenPids: [])
        let f = PauseFixture([device("m1", sessions: [session("s1", pause: paused)], rules: [rule("session:s1")])])
        #expect(f.controller.isPaused(.session(deviceId: "m1", sessionId: "s1")))
        await f.controller.tap(.session(deviceId: "m1", sessionId: "s1"))
        #expect(f.api("m1").calls == ["resume:session:s1"])
    }

    @Test func tapOnAnUnpausedTargetSoftPauses() async {
        let f = PauseFixture([device("m1", sessions: [session("s1")])])
        #expect(!f.controller.isPaused(.session(deviceId: "m1", sessionId: "s1")))
        await f.controller.tap(.session(deviceId: "m1", sessionId: "s1"))
        #expect(f.api("m1").calls == ["pause:session:s1:soft:\(reason)"])
    }

    @Test func resumingAProjectAlsoLiftsTheSessionRulesUnderIt() async {
        let frozen = PauseState(mode: .hard, ruleId: "r-2", scope: "session:s1", since: t0, frozenPids: [42])
        let f = PauseFixture([device(
            "m1",
            sessions: [session("s1", pause: frozen), session("s2")],
            rules: [rule("session:s1"), rule("session:s1")]
        )])
        let project = PauseTarget.project(deviceId: "m1", projectKey: "/g/.git")
        #expect(f.controller.isPaused(project))
        await f.controller.tap(project)
        #expect(f.api("m1").calls == ["resume:\(project.scope)", "resume:session:s1"])
    }

    @Test func aNestedResumeThatFailsDoesNotStopTheOthersOrFailTheProject() async {
        let f = PauseFixture([device("m1", sessions: [session("s1"), session("s2")], rules: [rule("session:s1"), rule("session:s2")])])
        f.api("m1").edit {
            $0.refuseResume = ["session:s1"]
            $0.failWith = DaemonError(code: "not_found", httpStatus: 404, hint: "No such rule")
        }
        let project = PauseTarget.project(deviceId: "m1", projectKey: "/g/.git")
        let outcome = await f.controller.resume(project).first
        #expect(outcome?.ok == true)
        #expect(f.api("m1").calls == ["resume:\(project.scope)", "resume:session:s1", "resume:session:s2"])
    }

    @Test func aProjectResumeReportsTheProjectsOwnRefusal() async {
        let f = PauseFixture([device("m1", sessions: [session("s1")], rules: [rule("session:s1")])])
        let project = PauseTarget.project(deviceId: "m1", projectKey: "/g/.git")
        f.api("m1").edit {
            $0.refuseResume = [project.scope]
            $0.failWith = DaemonError(code: "conflict", httpStatus: 409, hint: "Daemon is updating")
        }
        let outcome = await f.controller.resume(project).first
        #expect(outcome?.ok == false)
        #expect(outcome?.error == "Daemon is updating")
        #expect(f.api("m1").calls.contains("resume:session:s1"))
    }

    @Test func aFailedResumeKeepsThePendingEscalation() async {
        let f = PauseFixture([device("m1", sessions: [session("s1")])])
        await f.controller.soft(.session(deviceId: "m1", sessionId: "s1"))
        f.api("m1").edit { $0.refuseResume = ["session:s1"] }
        await f.controller.resume(.session(deviceId: "m1", sessionId: "s1"))
        #expect(f.controller.pending.count == 1)
    }

    @Test func holdHardFreezesAHookSessionAndNeverSchedules() async {
        let f = PauseFixture([device("m1", sessions: [session("s1")])])
        await f.controller.hold(.session(deviceId: "m1", sessionId: "s1"))
        #expect(f.api("m1").calls == ["pause:session:s1:hard:\(reason)"])
        #expect(f.controller.pending.isEmpty)
    }

    @Test func pendingEscalationsRestoreFromTheStoreAndOverdueOnesFireImmediately() async {
        let overdue = Escalation(deviceId: "m1", scope: "session:s1", fireAt: t0.addingTimeInterval(-5))
        let f = PauseFixture([device("m1", sessions: [session("s1")], rules: [rule("session:s1")])], restore: [overdue])
        await f.controller.tick()
        #expect(f.api("m1").calls.contains("pause:session:s1:hard:\(reason)"))
        #expect(f.controller.pending.isEmpty)
    }

    @Test func anEscalationWhoseDeviceIsDeadAtFireTimeIsDropped() async {
        let overdue = Escalation(deviceId: "m1", scope: "session:s1", fireAt: t0.addingTimeInterval(-5))
        let f = PauseFixture([device("m1", health: .dead, sessions: [session("s1")], rules: [rule("session:s1")])], restore: [overdue])
        await f.controller.tick()
        #expect(f.api("m1").calls.isEmpty)
        #expect(f.controller.pending.isEmpty)
        #expect(f.store.load().isEmpty)
    }

    @Test func a409SurfacesTheDaemonsMessage() async {
        let f = PauseFixture([device("m1", sessions: [session("s1")])])
        f.api("m1").edit {
            $0.failures = 1
            $0.failWith = DaemonError(code: "conflict", httpStatus: 409, hint: "That session has no trusted pid")
        }
        let outcome = await f.controller.hard(.session(deviceId: "m1", sessionId: "s1")).first
        #expect(outcome?.ok == false)
        #expect(outcome?.error == "That session has no trusted pid")
    }

    @Test func anUnknownDeviceYieldsANetworkOutcome() async {
        let f = PauseFixture([device("m1")])
        let outcome = await f.controller.soft(.session(deviceId: "nope", sessionId: "s1")).first
        #expect(outcome == PauseOutcome(deviceId: "nope", ok: false, error: DaemonError.defaults["network"]))
        #expect(f.controller.escalation(for: .session(deviceId: "nope", sessionId: "s1")) == nil)
    }

    @Test func theTimerLoopFiresWithoutManualTicks() async throws {
        let overdue = Escalation(deviceId: "m1", scope: "session:s1", fireAt: t0.addingTimeInterval(-5))
        let f = PauseFixture([device("m1", sessions: [session("s1")], rules: [rule("session:s1")])], restore: [overdue])
        f.controller.start(interval: .milliseconds(5))
        defer { f.controller.stop() }
        for _ in 0 ..< 200 where f.api("m1").calls.isEmpty {
            try await Task.sleep(for: .milliseconds(5))
        }
        #expect(f.api("m1").calls == ["pause:session:s1:hard:\(reason)"])
    }
}

struct PauseTargetTests {
    @Test func scopeStringsFollowTheDaemonGrammar() {
        #expect(PauseTarget.session(deviceId: "m1", sessionId: "s1").scope == "session:s1")
        #expect(PauseTarget.project(deviceId: "m1", projectKey: "/g/.git").scope == "project:/g/.git")
        #expect(PauseTarget.all.scope == "all")
        #expect(PauseTarget.all.deviceId == nil)
    }

    @Test func storesRoundTrip() throws {
        let list = [Escalation(deviceId: "m1", scope: "all", fireAt: t0)]
        let memory = InMemoryEscalationStore()
        #expect(memory.load().isEmpty)
        memory.save(list)
        #expect(memory.load() == list)

        let defaults = try #require(UserDefaults(suiteName: "esc-\(UUID().uuidString)"))
        let persisted = UserDefaultsEscalationStore(defaults: defaults)
        persisted.save(list)
        #expect(UserDefaultsEscalationStore(defaults: defaults).load() == list, "survives a relaunch")
        persisted.save([])
        #expect(persisted.load().isEmpty)
    }
}
