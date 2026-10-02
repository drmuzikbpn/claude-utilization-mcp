import Foundation
import Testing
@testable import UsageCore

struct TeamStateTests {
    @Test func theSameUserOnTwoDevicesCollapsesWithTheFreshestLimitsWinning() throws {
        let stale = device(
            "m1",
            user: alan,
            health: .stale,
            limits: [limit("weekly_all", 10)],
            limitsFetchedAt: t0.addingTimeInterval(-600)
        )
        var noName = alan
        noName.displayName = nil
        let fresh = device("m2", user: noName, limits: [limit("weekly_all", 81), limit("session", 42)], limitsFetchedAt: t0)
        let user = try #require(TeamState(devices: [stale, fresh]).users.first)
        #expect(TeamState(devices: [stale, fresh]).users.count == 1)
        #expect(user.key == "uuid-alan")
        #expect(user.displayName == "Alan")
        #expect(user.deviceIds == ["m1", "m2"])
        #expect(user.sevenDay?.percent == 81)
        #expect(user.fiveHour?.percent == 42)
        #expect(user.limitsFetchedAt == t0)
        #expect(user.health == .fresh)
    }

    @Test func blankUuidsFallThroughInsteadOfForgingASharedKey() {
        var a = alan
        a.accountUuid = ""
        a.organizationUuid = ""
        var b = a
        b.emailAddress = "sam@example.com"
        let team = TeamState(devices: [
            device("m1", user: a, limits: [limit("session", 1)], limitsFetchedAt: t0),
            device("m2", user: b, limits: [limit("session", 2)], limitsFetchedAt: t0),
        ])
        #expect(team.users.map(\.key) == ["alan@example.com", "sam@example.com"])
    }

    @Test func oneAccountInTwoOrganisationsIsTwoQuotas() {
        var a = alan
        a.organizationUuid = "org-a"
        a.organizationName = "Even Seal Productions"
        var b = alan
        b.organizationUuid = "org-b"
        b.organizationName = "Testing"
        let team = TeamState(devices: [
            device("m1", user: a, limits: [limit("session", 100)], limitsFetchedAt: t0),
            device("m2", user: b, limits: [limit("session", 5)], limitsFetchedAt: t0),
        ])
        #expect(team.users.map(\.key) == ["uuid-alan/org-a", "uuid-alan/org-b"])
        #expect(team.users.map { $0.fiveHour?.percent } == [100, 5])
        #expect(team.users.map(\.organizationName) == ["Even Seal Productions", "Testing"])
    }

    @Test func twoDifferentUsersStaySeparate() {
        let team = TeamState(devices: [
            device("m1", user: alan, limits: [limit("session", 10)], limitsFetchedAt: t0),
            device("m2", user: jamie, limits: [limit("session", 90)], limitsFetchedAt: t0),
        ])
        #expect(Set(team.users.map(\.key)) == ["uuid-alan", "uuid-jamie"])
        #expect(team.user(key: "uuid-alan")?.fiveHour?.percent == 10)
    }

    @Test func aDeviceWithNoUserFallsBackToItsId() throws {
        let user = try #require(TeamState(devices: [device("m9")]).users.first)
        #expect(user.key == "m9")
        #expect(user.displayName == "m9")
        #expect(user.emailAddress == nil)
    }

    @Test func scopedLimitsAreExposedApartFromTheHeadlines() {
        let team = TeamState(devices: [device("m1", user: alan, limits: [
            limit("session", 42), limit("weekly_all", 81), limit("weekly_scoped:fable", 10, kind: "weekly_scoped"),
        ], limitsFetchedAt: t0)])
        #expect(team.users.first?.scoped.map(\.id) == ["weekly_scoped:fable"])
    }

    @Test func worktreesOfOneRepoRollUpIntoOneProject() throws {
        let git = "/Users/alan/code/calendarpa/.git"
        let m = device("m1", user: alan, sessions: [
            session("s1", cwd: "/Users/alan/code/calendarpa", projectKey: git, projectName: "calendarpa", tokens: Tokens(input: 10)),
            session(
                "s2",
                cwd: "/Users/alan/code/calendarpa-wt/billing",
                projectKey: git,
                projectName: "calendarpa",
                worktree: "billing",
                tokens: Tokens(input: 20)
            ),
        ])
        let projects = TeamState(devices: [m]).projects
        let project = try #require(projects.first)
        #expect(projects.count == 1)
        #expect(project.key == git)
        #expect(project.name == "calendarpa")
        #expect(project.deviceId == "m1")
        #expect(project.sessions.count == 2)
        #expect(project.worktreeCount == 2)
        #expect(project.liveTokens.input == 30)
        #expect(!project.isIdle)
    }

    @Test func idleProjectsComeAfterLiveOnesWithTheirTodayTotals() {
        let git = "/Users/alan/code/calendarpa/.git"
        let m = device(
            "m1",
            user: alan,
            sessions: [session(
                "s1",
                cwd: "/Users/alan/code/calendarpa",
                projectKey: git,
                projectName: "calendarpa",
                tokens: Tokens(input: 10)
            )],
            projectTokens: [
                ProjectTokens(key: "-Users-alan-code-calendarpa", label: "/Users/alan/code/calendarpa", tokens: Tokens(input: 500)),
                ProjectTokens(key: "-Users-alan-code-audioleveler", label: "/Users/alan/code/audioleveler", tokens: Tokens(input: 900)),
            ]
        )
        let projects = TeamState(devices: [m]).projects
        #expect(projects.count == 2)
        #expect(projects[0].key == git)
        #expect(projects[0].todayTokens?.input == 500)
        #expect(projects[1].key == "/Users/alan/code/audioleveler")
        #expect(projects[1].name == "audioleveler")
        #expect(projects[1].isIdle)
        #expect(projects[1].todayTokens?.input == 900)
    }

    @Test func liveProjectsSortByLiveTokensDescending() {
        let m = device("m1", user: alan, sessions: [
            session("s1", cwd: "/a", projectKey: "/a/.git", projectName: "a", tokens: Tokens(input: 10)),
            session("s2", cwd: "/b", projectKey: "/b/.git", projectName: "b", tokens: Tokens(input: 99)),
        ])
        #expect(TeamState(devices: [m]).projects.map(\.key) == ["/b/.git", "/a/.git"])
    }

    @Test func hardPauseWinsOverSoftOnAProject() {
        let soft = PauseState(mode: .soft, ruleId: "r1", scope: "session:s1", since: t0, frozenPids: [])
        let hard = PauseState(mode: .hard, ruleId: "r2", scope: "session:s2", since: t0, frozenPids: [42])
        let m = device("m1", user: alan, sessions: [
            session("s1", cwd: "/g", pause: soft),
            session("s2", cwd: "/g/wt", worktree: "wt", pause: hard),
        ])
        #expect(TeamState(devices: [m]).projects.first?.pause?.mode == .hard)
    }

    @Test func teamTodaySumsDevicesAndLiveSessionsAreCounted() {
        let team = TeamState(devices: [
            device("m1", user: alan, sessions: [session("s1", cwd: "/a", projectKey: "/a/.git")], today: Tokens(input: 100, output: 5)),
            device("m2", user: jamie, sessions: [
                session("s2", cwd: "/b", projectKey: "/b/.git"),
                session("s3", cwd: "/c", projectKey: "/c/.git", alive: false),
            ], today: Tokens(input: 200, output: 7)),
        ])
        #expect(team.teamToday.input == 300)
        #expect(team.teamToday.output == 12)
        #expect(team.liveSessionCount == 2)
    }

    @Test func lookupsAreScopedToOneDevice() {
        let team = TeamState(devices: [
            device("m1", user: alan, sessions: [session("s1")]),
            device("m2", user: jamie, sessions: [session("s2")]),
        ])
        #expect(team.device("m2") != nil)
        #expect(team.device("nope") == nil)
        #expect(team.session(deviceId: "m1", sessionId: "s1")?.sessionId == "s1")
        #expect(team.session(deviceId: "m2", sessionId: "s1") == nil)
    }

    @Test func theSameProjectKeyOnTwoDevicesStaysTwoProjects() {
        let git = "/Users/alan/code/calendarpa/.git"
        let team = TeamState(devices: [
            device("m1", user: alan, sessions: [session("s1", cwd: "/x", projectKey: git)]),
            device("m2", user: jamie, sessions: [session("s2", cwd: "/x", projectKey: git)]),
        ])
        #expect(Set(team.projects.map(\.deviceId)) == ["m1", "m2"])
    }

    @Test func deadSessionsNeverAppearOnTheBoard() throws {
        let m = device("m1", sessions: [
            session("live", cwd: "/repo/a", projectKey: "/repo/a/.git", projectName: "a"),
            session("dead1", cwd: "/repo/a", projectKey: "/repo/a/.git", projectName: "a", alive: false),
            session("dead2", cwd: "/repo/old", projectKey: "/repo/old", projectName: "old", alive: false),
        ])
        let team = TeamState(devices: [m])
        #expect(team.liveSessionCount == 1)
        let a = try #require(team.projects.first)
        #expect(team.projects.count == 1)
        #expect(a.sessions.map(\.sessionId) == ["live"])
        #expect(a.worktreeCount == 1)
    }

    @Test func anEmailOnlyUserIsHeadlinedByItsLocalPart() {
        let team = TeamState(devices: [device("m1", user: User(emailAddress: "alan@example.com", accountUuid: "acct-1", displayName: nil))])
        #expect(team.users.first?.displayName == "alan")
        #expect(team.users.first?.emailAddress == "alan@example.com")
    }

    private func oneAccount(_ id: String, fetchedAt: Date?, weekly: Int?) -> DeviceState {
        let user = User(emailAddress: "alan@example.com", accountUuid: "account-1", displayName: "Alan", organizationUuid: "org-1")
        return device(id, user: user, limits: weekly.map { [limit("weekly_all", $0)] } ?? [], limitsFetchedAt: fetchedAt)
    }

    @Test func theCopyTheDaemonFetchedMostRecentlyWinsWhateverTheOrder() {
        let stale = oneAccount("m1", fetchedAt: date("2026-09-16T02:10:00Z"), weekly: 74)
        let fresh = oneAccount("m2", fetchedAt: date("2026-09-16T02:54:00Z"), weekly: 80)
        #expect(TeamState(devices: [stale, fresh]).users.first?.sevenDay?.percent == 80)
        #expect(TeamState(devices: [fresh, stale]).users.first?.sevenDay?.percent == 80)
    }

    @Test func aDeviceThatNeverReportsAFetchTimeDoesNotOutrankOneThatDoes() {
        let unknown = oneAccount("m1", fetchedAt: nil, weekly: 74)
        let known = oneAccount("m2", fetchedAt: date("2026-09-16T02:10:00Z"), weekly: 80)
        #expect(TeamState(devices: [unknown, known]).users.first?.sevenDay?.percent == 80)
        #expect(TeamState(devices: [known, unknown]).users.first?.sevenDay?.percent == 80)
    }

    @Test func aDeviceWhoseLimitsFetchFailedNeverBlanksTheHeadline() {
        let empty = oneAccount("m1", fetchedAt: date("2026-09-16T03:00:00Z"), weekly: nil)
        let known = oneAccount("m2", fetchedAt: date("2026-09-16T02:10:00Z"), weekly: 80)
        #expect(TeamState(devices: [empty, known]).users.first?.sevenDay?.percent == 80)
    }
}

struct UserNamesTests {
    let user = UserView(
        key: "uuid-alan/org-1", displayName: "Alan", emailAddress: nil, organizationName: nil,
        deviceIds: [], limits: [], limitsFetchedAt: nil, health: .fresh
    )

    @Test func aRenameWinsOverTheDaemonName() {
        #expect(UserNames().name(for: user) == "Alan")
        #expect(UserNames(["uuid-alan/org-1": "Boss"]).name(for: user) == "Boss")
    }

    @Test func aRenameGivenBeforeTheOrgWasKnownStillApplies() {
        #expect(UserNames(["uuid-alan": "Old"]).name(for: user) == "Old")
    }

    @Test func aBlankRenameClears() {
        let names = UserNames(["uuid-alan/org-1": "Boss"]).renamed("uuid-alan/org-1", to: "  ")
        #expect(names.rename(for: user) == nil)
        #expect(UserNames(["k": "  "]).names.isEmpty)
    }
}
