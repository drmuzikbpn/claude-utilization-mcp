import Foundation
import Testing
@testable import UsageCore

struct HighestTests {
    struct Acct: HeadlineAccount {
        var accountKey: String
        var fiveHourPercent: Int?
        var sevenDayPercent: Int?
    }

    @Test func picksTheAccountClosestToAnyLimit() {
        let accounts = [
            Acct(accountKey: "a", fiveHourPercent: 40, sevenDayPercent: 70),
            Acct(accountKey: "b", fiveHourPercent: 88, sevenDayPercent: 10),
        ]
        #expect(Highest.pick(accounts)?.accountKey == "b")
    }

    @Test func tiesGoToTheHigherOtherHeadlineThenToTheEarlierAccount() {
        let a = Acct(accountKey: "a", fiveHourPercent: 80, sevenDayPercent: 10)
        let b = Acct(accountKey: "b", fiveHourPercent: 30, sevenDayPercent: 80)
        let c = Acct(accountKey: "c", fiveHourPercent: 80, sevenDayPercent: 30)
        #expect(Highest.pick([a, b, c])?.accountKey == "b")
        #expect(Highest.pick([b, c])?.accountKey == "b")
        #expect(Highest.pick([c, b])?.accountKey == "c")
    }

    @Test func anAccountWithoutReadingsStillWinsWhenAlone() {
        #expect(Highest.pick([Acct(accountKey: "a")])?.accountKey == "a")
        #expect(Highest.pick([Acct]()) == nil)
        #expect(Highest.pick([Acct(accountKey: "a"), Acct(accountKey: "b", fiveHourPercent: 0)])?.accountKey == "b")
    }

    @Test func aFixedChoiceThatIsGoneFallsBackToHighest() {
        let accounts = [Acct(accountKey: "a", fiveHourPercent: 10), Acct(accountKey: "b", fiveHourPercent: 90)]
        #expect(Highest.resolve(.account(key: "a"), in: accounts)?.accountKey == "a")
        #expect(Highest.resolve(.account(key: "gone"), in: accounts)?.accountKey == "b")
        #expect(Highest.resolve(.highest, in: accounts)?.accountKey == "b")
    }

    @Test func worksOnLiveUsersAndLabelsWithAnInitial() {
        let team = TeamState(devices: [
            device("m1", user: alan, limits: [limit("session", 10)], limitsFetchedAt: t0),
            device("m2", user: jamie, limits: [limit("weekly_all", 70)], limitsFetchedAt: t0),
        ])
        #expect(Highest.pick(team.users)?.key == "uuid-jamie")
        #expect(Highest.initial("jamie") == "J")
        #expect(Highest.initial("  ") == "?")
    }
}

struct WatchSnapshotTests {
    func bigTeam(projects: Int, sessionsEach: Int) -> TeamState {
        let sessions = (0 ..< projects).flatMap { p in
            (0 ..< sessionsEach).map { s in
                session(
                    "session-\(p)-\(s)-\(UUID().uuidString)",
                    cwd: "/Users/alan/code/project-with-a-long-name-\(p)/worktree-\(s)",
                    projectKey: "/Users/alan/code/project-with-a-long-name-\(p)/.git",
                    projectName: "project-with-a-long-name-\(p)",
                    worktree: "worktree-\(s)",
                    tokens: Tokens(input: Int64(1000 * (projects - p) + s))
                )
            }
        }
        return TeamState(devices: [device(
            "m1",
            user: alan,
            limits: [limit("session", 42), limit("weekly_all", 81)],
            limitsFetchedAt: t0,
            sessions: sessions
        )])
    }

    @Test func buildsFromTheTeamWithRenamesAndNoSecrets() throws {
        var d = device(
            "m1",
            user: alan,
            limits: [limit("session", 42, resetsAt: t0.addingTimeInterval(3600)), limit("weekly_all", 81)],
            limitsFetchedAt: t0,
            sessions: [session("s1")],
            rules: [rule("all")]
        )
        d.needsRepair = true
        let snapshot = WatchSnapshot.make(
            team: TeamState(devices: [d]),
            escalations: [Escalation(deviceId: "m1", scope: "all", fireAt: t0)],
            names: UserNames(["uuid-alan": "Boss"]),
            now: t0
        )
        let account = try #require(snapshot.accounts.first)
        #expect(account.name == "Boss")
        #expect(account.initial == "B")
        #expect(account.fiveHour == WatchSnapshot.Headline(percent: 42, resetsAt: t0.addingTimeInterval(3600), status: .ok))
        #expect(account.sevenDay?.percent == 81)
        #expect(snapshot.devices.first?.needsRepair == true)
        #expect(snapshot.allPaused)
        #expect(snapshot.projects.first?.sessions.first?.canHardPause == true)
        #expect(snapshot.liveSessionCount == 1)
        #expect(snapshot.escalations.count == 1)

        let json = try String(decoding: WatchSnapshotCodec.encode(snapshot), as: UTF8.self)
        #expect(!json.contains("192.168.1.20"), "no addresses")
        #expect(!json.contains("fingerprint"))
        #expect(!json.lowercased().contains("token\""), "no token field")
    }

    @Test func roundTripsThroughTheCodec() throws {
        let snapshot = WatchSnapshot.make(team: bigTeam(projects: 3, sessionsEach: 2), escalations: [], now: t0)
        #expect(try WatchSnapshotCodec.decode(WatchSnapshotCodec.encode(snapshot)) == snapshot)
    }

    @Test func sharedStoreRoundTripsAndToleratesAMissingFile() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = SharedSnapshotStore(directory: dir)
        #expect(store.read() == nil)
        let snapshot = WatchSnapshot.make(team: bigTeam(projects: 2, sessionsEach: 1), escalations: [], now: t0)
        store.write(snapshot)
        #expect(store.read() == snapshot)
    }

    @Test func keepsTheTop20ProjectsInOrder() throws {
        let snapshot = WatchSnapshot.make(team: bigTeam(projects: 30, sessionsEach: 1), escalations: [], now: t0)
        let decoded = try WatchSnapshotCodec.decode(WatchSnapshotCodec.encode(snapshot))
        #expect(decoded.projects.count == 20)
        #expect(decoded.projects.map(\.key) == Array(snapshot.projects.prefix(20)).map(\.key))
    }

    @Test func trimsAHugeTeamUnder60KBKeepingAccountsAndTheBusiestProjects() throws {
        let burn = BurnHistory()
        let team = bigTeam(projects: 200, sessionsEach: 40)
        for p in team.projects {
            for i in 0 ..< 30 {
                burn.record(
                    DeviceReducer.burnKey(deviceId: "m1", project: p.key),
                    at: t0.addingTimeInterval(Double(i) * 600),
                    cumulative: Int64(i * 1000)
                )
            }
        }
        let snapshot = WatchSnapshot.make(team: team, escalations: [], burn: burn, now: t0.addingTimeInterval(18000))
        let data = try WatchSnapshotCodec.encode(snapshot)
        #expect(data.count < WatchSnapshotCodec.byteLimit)
        let decoded = try WatchSnapshotCodec.decode(data)
        #expect(decoded.accounts == snapshot.accounts)
        #expect(!decoded.projects.isEmpty)
        #expect(decoded.projects.first?.key == snapshot.projects.first?.key)
        #expect(decoded.projects.allSatisfy { $0.burn.isEmpty }, "sparklines go first")
    }

    @Test func aTinyBudgetShedsSessionsThenProjectsButNeverAccounts() throws {
        let snapshot = WatchSnapshot.make(team: bigTeam(projects: 20, sessionsEach: 5), escalations: [], now: t0)
        let data = try WatchSnapshotCodec.encode(snapshot, limit: 1500)
        let decoded = try WatchSnapshotCodec.decode(data)
        #expect(data.count < 1500)
        #expect(decoded.projects.count < snapshot.projects.count)
        #expect(decoded.projects.allSatisfy { $0.sessions.isEmpty })
        #expect(decoded.accounts.count == 1)
    }

    @Test func noDevicesIsTheEmptyState() {
        #expect(!WatchSnapshot.make(team: TeamState(), escalations: [], now: t0).hasDevices)
        #expect(!WatchSnapshot.empty.hasDevices)
    }
}

struct WatchWireTests {
    @Test func requestsRoundTripThroughThePlistDictionary() throws {
        let requests: [WatchRequest] = [
            .refresh,
            .pause(.session(deviceId: "m1", sessionId: "s1"), mode: .hard),
            .pause(.all, mode: .soft),
            .resume(.project(deviceId: "m1", projectKey: "/g/.git")),
        ]
        for request in requests {
            let dictionary = try WatchWire.pack(request)
            #expect(WatchWire.unpack(WatchRequest.self, from: dictionary) == request)
        }
    }

    @Test func repliesCarrySnapshotBytesAndOutcomes() throws {
        let reply = WatchReply(snapshot: Data([1, 2]), outcomes: [PauseOutcome(deviceId: "m1", ok: false, error: "Device unreachable.")])
        #expect(try WatchWire.unpack(WatchReply.self, from: WatchWire.pack(reply)) == reply)
    }

    @Test func snapshotsTravelUnderTheirOwnKey() throws {
        let snapshot = WatchSnapshot(
            generatedAt: t0,
            accounts: [WatchSnapshot.Account(key: "k", name: "Alan", fiveHour: nil, sevenDay: nil, fetchedAt: nil, health: .fresh)]
        )
        #expect(try WatchWire.unpackSnapshot(from: WatchWire.packSnapshot(snapshot)) == snapshot)
    }

    @Test func aNewerWireVersionOrGarbageIsIgnored() {
        #expect(WatchWire.unpack(WatchRequest.self, from: ["v": 2, "body": Data()]) == nil)
        #expect(WatchWire.unpack(WatchRequest.self, from: ["v": 1, "body": Data("nope".utf8)]) == nil)
        #expect(WatchWire.unpackSnapshot(from: [:]) == nil)
    }
}

struct ComplicationPolicyTests {
    func snapshot(five: Int?, status: LimitStatus = .ok, key: String = "k") -> WatchSnapshot {
        WatchSnapshot(generatedAt: t0, accounts: [WatchSnapshot.Account(
            key: key,
            name: "Alan",
            fiveHour: five.map { WatchSnapshot.Headline(percent: $0, resetsAt: nil, status: status) },
            sevenDay: nil,
            fetchedAt: nil,
            health: .fresh
        )])
    }

    @Test func transfersOnlyOnAFivePointMoveOrAStatusChange() {
        #expect(ComplicationPolicy.shouldTransfer(previous: nil, next: snapshot(five: 10)))
        #expect(!ComplicationPolicy.shouldTransfer(previous: snapshot(five: 10), next: snapshot(five: 14)))
        #expect(ComplicationPolicy.shouldTransfer(previous: snapshot(five: 10), next: snapshot(five: 15)))
        #expect(ComplicationPolicy.shouldTransfer(previous: snapshot(five: 79), next: snapshot(five: 80, status: .warn)))
        #expect(ComplicationPolicy.shouldTransfer(previous: snapshot(five: nil), next: snapshot(five: 1)))
        #expect(ComplicationPolicy.shouldTransfer(previous: snapshot(five: 10), next: snapshot(five: 10, key: "other")))
    }
}

struct SetupCheckTests {
    func status(_ check: SetupCheck, _ id: String) -> SetupCheck.Status? {
        check.items.first { $0.id == id }?.status
    }

    @Test func aFullyInstalledDaemonIsAllGoodWithUnknownMCPNeutral() throws {
        let health = try Fixtures.decode(HealthDTO.self, "health-v2.json")
        let check = SetupCheck.evaluate(health: health, error: nil, limitsFresh: true)
        #expect(check.allGood)
        #expect(status(check, "mcp") == .neutral)
        #expect(status(check, "statusline") == .ok)
    }

    @Test func aDaemonWithoutTheInstallBlockNeedsAnUpdate() throws {
        let check = try SetupCheck.evaluate(health: Fixtures.decode(HealthDTO.self, "health.json"), error: nil, limitsFresh: true)
        #expect(status(check, "version") == .failing)
        #expect(check.items.first { $0.id == "version" }?.fix == "claude-usage update")
    }

    @Test func noLimitsYetIsNeutralNotRed() throws {
        let check = try SetupCheck.evaluate(health: Fixtures.decode(HealthDTO.self, "health-v2.json"), error: nil, limitsFresh: false)
        #expect(status(check, "limits") == .neutral)
        #expect(check.allGood)
    }

    @Test func unreachableSaysWhetherToRepair() {
        let gone = SetupCheck.evaluate(health: nil, error: .network, limitsFresh: false)
        #expect(!gone.allGood)
        let rejected = SetupCheck.evaluate(health: nil, error: DaemonError(code: "unauthorized"), limitsFresh: false)
        #expect(rejected.items.first?.fix == "Re-pair this device")
    }

    @Test func missingHooksAndAForeignStatusLineFail() {
        let health = HealthDTO(user: UserDTO(accountUuid: "a"), install: InstallDTO(hooks: false, statusline: "other", mcp: false))
        let check = SetupCheck.evaluate(health: health, error: nil, limitsFresh: true)
        #expect(status(check, "hooks") == .failing)
        #expect(status(check, "statusline") == .failing)
        #expect(status(check, "mcp") == .failing)
        #expect(status(check, "spend") == .neutral)
    }
}
