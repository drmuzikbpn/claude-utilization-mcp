import Foundation
import Testing
@testable import UsageCore

struct DeckSettingsTests {
    private let utc = TimeZone(identifier: "UTC")!

    private func at(_ hour: Int, _ minute: Int = 0) -> Date {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = utc
        return calendar.date(from: DateComponents(year: 2026, month: 9, day: 13, hour: hour, minute: minute))!
    }

    @Test func defaultsMatchTheDeck() {
        let s = DeckSettings()
        #expect(s.warn == 80)
        #expect(s.critical == 95)
        #expect(s.escalationSeconds == 90)
        #expect(s.quietStartMinutes == 23 * 60)
        #expect(s.quietEndMinutes == 7 * 60)
        #expect(s.use24h)
        #expect(s.thresholds == AlertThresholds(warn: 80, critical: 95))
    }

    @Test func quietHoursWrapPastMidnight() {
        var s = DeckSettings()
        s.quietHours = true
        #expect(s.isQuiet(at: at(23, 30), timeZone: utc))
        #expect(s.isQuiet(at: at(3), timeZone: utc))
        #expect(!s.isQuiet(at: at(7), timeZone: utc))
        #expect(!s.isQuiet(at: at(12), timeZone: utc))
        #expect(s.isQuiet(at: at(23), timeZone: utc))
    }

    @Test func quietHoursInsideOneDayAndOff() {
        var s = DeckSettings()
        s.quietHours = true
        s.quietStartMinutes = 13 * 60
        s.quietEndMinutes = 14 * 60
        #expect(s.isQuiet(at: at(13, 30), timeZone: utc))
        #expect(!s.isQuiet(at: at(14), timeZone: utc))
        s.quietHours = false
        #expect(!s.isQuiet(at: at(13, 30), timeZone: utc))
        s.quietHours = true
        s.quietEndMinutes = s.quietStartMinutes
        #expect(!s.isQuiet(at: at(13), timeZone: utc))
    }

    @Test func clampingKeepsCriticalAboveWarn() {
        var s = DeckSettings()
        s.warn = 120
        s.critical = 10
        s.escalationSeconds = 5
        let c = s.clamped()
        #expect(c.warn == DeckSettings.warnRange.upperBound)
        #expect(c.critical == c.warn + 1)
        #expect(c.escalationSeconds == DeckSettings.escalationChoices.compactMap(\.self).min())
    }

    @Test func roundTripsThroughDefaultsAndSurvivesGarbage() throws {
        let defaults = try #require(UserDefaults(suiteName: "deck-settings-\(UUID().uuidString)"))
        let store = DeckSettingsStore(defaults: defaults)
        #expect(store.load() == DeckSettings())
        var s = DeckSettings()
        s.warn = 70
        s.escalationSeconds = nil
        s.names = UserNames(["k": "Sam"])
        store.save(s)
        #expect(store.load() == s)
        defaults.set(Data("nope".utf8), forKey: DeckSettingsStore.key)
        #expect(store.load() == DeckSettings())
    }
}

struct DeviceRegistryTests {
    private func makeRegistry() throws -> DeviceRegistry {
        try DeviceRegistry(defaults: #require(UserDefaults(suiteName: "deck-registry-\(UUID().uuidString)")))
    }

    @Test func upsertReplacesByIdAndKeepsOrder() throws {
        let registry = try makeRegistry()
        registry.upsert(record(id: "a", addrs: ["10.0.0.1"]))
        registry.upsert(record(id: "b", addrs: ["10.0.0.2"]))
        registry.upsert(record(id: "a", name: "renamed", addrs: ["10.0.0.3"]))
        let loaded = registry.load()
        #expect(loaded.map(\.id) == ["a", "b"])
        #expect(loaded.first?.name == "renamed")
        registry.remove("a")
        #expect(registry.load().map(\.id) == ["b"])
    }

    @Test func persistsNoSecrets() throws {
        let defaults = try #require(UserDefaults(suiteName: "deck-registry-\(UUID().uuidString)"))
        let registry = DeviceRegistry(defaults: defaults)
        registry.upsert(record(id: "a", addrs: ["10.0.0.1"]))
        let raw = try #require(defaults.data(forKey: DeviceRegistry.key))
        let text = String(decoding: raw, as: UTF8.self)
        #expect(!text.contains("token"))
    }

    @Test func installIdIsGeneratedOnceAndKept() throws {
        let defaults = try #require(UserDefaults(suiteName: "deck-install-\(UUID().uuidString)"))
        let first = InstallID.load(defaults)
        #expect(UUID(uuidString: first) != nil)
        #expect(InstallID.load(defaults) == first)
    }
}

struct AddressMergeTests {
    @Test func appendsNewTlsAddressesAfterThePairedOnes() {
        let merged = AddressMerge.merge(
            paired: ["192.168.1.20", "studio.local"],
            reported: ["192.168.1.31", "100.64.0.7"]
        )
        #expect(merged == ["192.168.1.20", "studio.local", "192.168.1.31", "100.64.0.7"])
    }

    @Test func neverDropsThePairedNamesAndIgnoresDuplicatesAndJunk() {
        let merged = AddressMerge.merge(
            paired: ["Studio.local", "192.168.1.20"],
            reported: ["studio.local", "192.168.1.20", "", "not a host", "127.0.0.1"]
        )
        #expect(merged == ["Studio.local", "192.168.1.20", "127.0.0.1"])
    }

    @Test func nothingReportedChangesNothing() {
        #expect(AddressMerge.merge(paired: ["a.local"], reported: []) == ["a.local"])
    }
}

struct PairingInputTests {
    @Test func aV2LinkIsAnInvite() {
        let link = "usagedeck://pair?v=2&name=studio&addrs=192.168.1.20&port=47292&fp=\(String(repeating: "ab", count: 32))"
            + "&code=abcdefghijklmnopqrstuv"
        guard case let .invite(invite) = PairingInput.classify(link) else {
            Issue.record("expected an invite")
            return
        }
        #expect(invite.name == "studio")
    }

    @Test func aV1JsonPasteIsExplainedAsAndroid() {
        let json = #"{"v":1,"name":"studio","addr":"100.64.0.7","port":47291,"token":"secret-value"}"#
        guard case let .rejected(message) = PairingInput.classify(json) else {
            Issue.record("expected a rejection")
            return
        }
        #expect(message == PairingInput.androidMessage)
        #expect(!message.contains("secret-value"))
    }

    @Test func junkCarriesTheParserMessage() {
        guard case let .rejected(message) = PairingInput.classify("hello") else {
            Issue.record("expected a rejection")
            return
        }
        #expect(message.contains("claude-usage pair"))
    }
}

struct PauseVisualTests {
    private let hard = PauseState(mode: .hard, ruleId: "r", scope: "session:s1", since: t0.addingTimeInterval(-125), frozenPids: [1])
    private let soft = PauseState(mode: .soft, ruleId: "r", scope: "session:s1", since: t0, frozenPids: [])

    private func team(_ sessions: [Session], health: Health = .fresh, rules: [PauseRule] = []) -> TeamState {
        TeamState(devices: [device("d1", health: health, sessions: sessions, rules: rules)])
    }

    @Test func idleSoftFrozenFromTheSession() {
        let target = PauseTarget.session(deviceId: "d1", sessionId: "s1")
        #expect(PauseVisuals.visual(target, team: team([session("s1")]), now: t0) == .idle)
        #expect(PauseVisuals.visual(target, team: team([session("s1", pause: soft)]), now: t0) == .soft(countdown: nil))
        #expect(PauseVisuals.visual(target, team: team([session("s1", pause: hard)]), now: t0) == .frozen(elapsed: "2m"))
    }

    @Test func escalationCountdownShowsOnASoftPause() {
        let target = PauseTarget.session(deviceId: "d1", sessionId: "s1")
        let escalation = Escalation(deviceId: "d1", scope: "session:s1", fireAt: t0.addingTimeInterval(42))
        let visual = PauseVisuals.visual(target, team: team([session("s1", pause: soft)]), now: t0, escalation: escalation)
        #expect(visual == .soft(countdown: "0:42"))
    }

    @Test func inFlightBeatsEverythingAndCarriesTheDirection() {
        let target = PauseTarget.session(deviceId: "d1", sessionId: "s1")
        let busy: Set = ["d1|session:s1"]
        #expect(PauseVisuals.visual(target, team: team([session("s1")]), now: t0, inFlight: busy) == .inFlight(pausing: true))
        #expect(PauseVisuals.visual(target, team: team([session("s1", pause: soft)]), now: t0, inFlight: busy) == .inFlight(pausing: false))
        #expect(PauseVisuals
            .visual(target, team: team([session("s1")], health: .dead), now: t0, inFlight: busy) == .inFlight(pausing: true))
    }

    @Test func deadDeviceDisables() {
        let target = PauseTarget.session(deviceId: "d1", sessionId: "s1")
        #expect(PauseVisuals.visual(target, team: team([session("s1")], health: .dead), now: t0) == .disabled)
    }

    @Test func projectTakesTheMostSevereSessionAndAllReadsRules() {
        let project = PauseTarget.project(deviceId: "d1", projectKey: "/g/.git")
        let state = team([session("s1", pause: soft), session("s2", pause: hard)])
        #expect(PauseVisuals.visual(project, team: state, now: t0) == .frozen(elapsed: "2m"))

        let rule = PauseRule(id: "r", scope: "all", mode: .soft, reason: nil, createdAt: t0, createdBy: "cli")
        #expect(PauseVisuals.visual(.all, team: team([session("s1")], rules: [rule]), now: t0) == .soft(countdown: nil))
        #expect(PauseVisuals.visual(.all, team: team([session("s1")]), now: t0) == .idle)
        #expect(PauseVisuals.visual(.all, team: team([session("s1")]), now: t0, inFlight: ["d1|all"]) == .inFlight(pausing: true))
        #expect(PauseVisuals.visual(.all, team: team([], health: .dead), now: t0) == .disabled)
    }

    @Test func pausedMeansSoftOrFrozen() {
        #expect(PauseVisual.soft(countdown: nil).isPaused)
        #expect(PauseVisual.frozen(elapsed: "1m").isPaused)
        #expect(!PauseVisual.idle.isPaused)
        #expect(!PauseVisual.disabled.isPaused)
    }
}

struct HomeEmptyTests {
    @Test func noDevicesThenConnectingThenNoSessionsThenData() {
        #expect(HomeEmpty.of(TeamState()) == .noDevices)

        var waiting = DeviceState(record: record(id: "d1", addrs: ["10.0.0.1"]))
        waiting.health = .dead
        #expect(HomeEmpty.of(TeamState(devices: [waiting])) == .connecting)

        let quiet = device("d1", user: alan)
        #expect(HomeEmpty.of(TeamState(devices: [quiet])) == .noSessions(deviceNames: ["d1"]))

        let busy = device("d1", user: alan, sessions: [session("s1")])
        #expect(HomeEmpty.of(TeamState(devices: [busy])) == nil)
    }

    @Test func usersWithDataSkipsDevicesThatNeverArrived() {
        var waiting = DeviceState(record: record(id: "d2", addrs: ["10.0.0.1"]))
        waiting.health = .dead
        let team = TeamState(devices: [device("d1", user: alan), waiting])
        #expect(team.usersWithData.map(\.key) == ["uuid-alan"])
    }
}

struct ProjectMathTests {
    @Test func shareOfTodayIsHonestAboutZero() {
        #expect(ProjectMath.share(projectToday: 250, deviceToday: 1000) == "25%")
        #expect(ProjectMath.share(projectToday: 250, deviceToday: 0) == "—")
    }

    @Test func cacheShareAndRoundGridline() {
        #expect(ProjectMath.cacheShare(Tokens(input: 10, output: 10, cacheCreate: 30, cacheRead: 50)) == 80)
        #expect(ProjectMath.cacheShare(.zero) == 0)
        #expect(ProjectMath.oneSigFig(38210) == 40000)
        #expect(ProjectMath.oneSigFig(0) == 0)
        #expect(ProjectMath.oneSigFig(7.2) == 7)
    }
}

struct DeckAlertsTests {
    @Test func frozenAlertsWaitUntilTheDeviceHasArrived() {
        let hard = PauseState(mode: .hard, ruleId: "r", scope: "session:s1", since: t0, frozenPids: [1])
        let next = TeamState(devices: [device("d1", user: alan, sessions: [session("s1", pause: hard)])])
        let evaluator = AlertEvaluator()

        let onLaunch = DeckAlerts.admissible(evaluator.evaluate(previous: nil, next: next), previous: nil, listenedFor: nil)
        #expect(onLaunch.isEmpty)

        let before = TeamState(devices: [device("d1", user: alan, sessions: [session("s1")])])
        let live = DeckAlerts.admissible(evaluator.evaluate(previous: before, next: next), previous: before, listenedFor: 600)
        #expect(live.map(\.kind) == [.frozen])
    }

    /// Back from the background the last heartbeat is minutes old, but only because this iPhone
    /// stopped listening. "Has not checked in" is news only after two minutes of listening.
    @Test func unreachableNeedsTwoMinutesOfActuallyListening() {
        var was = device("d1", user: alan)
        was.health = .fresh
        var now = was
        now.health = .dead
        let before = TeamState(devices: [was])
        let raised = AlertEvaluator().evaluate(previous: before, next: TeamState(devices: [now]))
        #expect(raised.map(\.kind) == [.unreachable])

        #expect(DeckAlerts.admissible(raised, previous: before, listenedFor: 3).isEmpty)
        #expect(DeckAlerts.admissible(raised, previous: before, listenedFor: nil).isEmpty)
        #expect(DeckAlerts.admissible(raised, previous: before, listenedFor: Aging.dead).map(\.kind) == [.unreachable])
    }

    @Test func limitAlertsPassOnFirstSight() {
        let next = TeamState(devices: [device("d1", user: alan, limits: [limit("session", 97)], limitsFetchedAt: t0)])
        let alerts = DeckAlerts.admissible(AlertEvaluator().evaluate(previous: nil, next: next), previous: nil, listenedFor: nil)
        #expect(alerts.map(\.kind) == [.critical])
    }
}

struct SnapshotDiffTests {
    private func snapshot(_ percent: Int, rate: Double = 0, at: Date = t0) -> WatchSnapshot {
        WatchSnapshot(
            generatedAt: at,
            accounts: [.init(
                key: "k",
                name: "Alan",
                fiveHour: .init(percent: percent, resetsAt: nil, status: .ok),
                sevenDay: nil,
                fetchedAt: t0,
                health: .fresh
            )],
            projects: [.init(
                deviceId: "d1",
                key: "p",
                name: "p",
                todayTokens: nil,
                liveTokens: 0,
                ratePerMin: rate,
                burn: [],
                sessions: [],
                pause: nil
            )]
        )
    }

    @Test func contentIgnoresTheGenerationTime() {
        #expect(SnapshotDiff.sameContent(snapshot(10), snapshot(10, at: t0.addingTimeInterval(5))))
        #expect(!SnapshotDiff.sameContent(snapshot(10), snapshot(10, rate: 3)))
        #expect(!SnapshotDiff.sameContent(nil, snapshot(10)))
    }

    @Test func anUnchangedSnapshotIsStillDueOnceItsHeartbeatHasAged() {
        // The watch and the widgets age data by generatedAt; an unchanged snapshot that is never
        // re-sent would read as stale while the numbers are perfectly current.
        let sent = snapshot(10)
        #expect(!SnapshotDiff.isDue(last: sent, next: snapshot(10, at: t0.addingTimeInterval(5)), heartbeat: 20))
        #expect(SnapshotDiff.isDue(last: sent, next: snapshot(10, at: t0.addingTimeInterval(20)), heartbeat: 20))
        #expect(SnapshotDiff.isDue(last: sent, next: snapshot(11, at: t0.addingTimeInterval(1)), heartbeat: 20))
        #expect(SnapshotDiff.isDue(last: nil, next: sent, heartbeat: 20))
        #expect(!SnapshotDiff.isDue(
            last: sent,
            next: snapshot(10, rate: 3, at: t0.addingTimeInterval(1)),
            heartbeat: 20,
            headlineOnly: true
        ))
        #expect(SnapshotDiff.isDue(
            last: sent,
            next: snapshot(10, rate: 3, at: t0.addingTimeInterval(600)),
            heartbeat: 600,
            headlineOnly: true
        ))
    }

    @Test func headlineIgnoresRatesButNotPercent() {
        #expect(SnapshotDiff.sameHeadline(snapshot(10), snapshot(10, rate: 3)))
        #expect(!SnapshotDiff.sameHeadline(snapshot(10), snapshot(11)))
        #expect(!SnapshotDiff.sameHeadline(nil, snapshot(10)))
    }
}
