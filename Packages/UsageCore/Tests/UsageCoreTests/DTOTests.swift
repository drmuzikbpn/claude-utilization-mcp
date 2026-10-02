import Foundation
import Testing
@testable import UsageCore

struct DTOTests {
    @Test func sessionsFixtureMapsThreeSessionsWithPauseAndLastTool() throws {
        let dto = try Fixtures.decode(SessionsDTO.self, "sessions.json")
        #expect(dto.rev == 812)
        let s = dto.sessions.map { $0.toModel() }
        #expect(s.count == 3)

        // A worktree of a repo: the project key is the shared gitCommonDir, not the worktree cwd.
        #expect(s[0].projectName == "foo")
        #expect(s[0].projectKey == "/Users/alan/code/foo/.git")
        #expect(s[0].worktree == "foo-wt2")
        #expect(s[0].lastTool == LastTool(name: "Bash", at: date("2026-09-13T14:02:50Z")))
        let pause = try #require(s[0].pause)
        #expect(pause.mode == .hard)
        #expect(pause.ruleId == "r_k3m7qz4ub2ah6ptc")
        #expect(pause.frozenPids == [4251, 4252])
        #expect(pause.freezes == 1)
        #expect(pause.since == date("2026-09-13T14:03:10Z"))
        #expect(s[0].canHardPause)

        #expect(s[1].projectKey == "/Users/alan/code/foo/.git")
        #expect(s[1].worktree == nil)
        #expect(s[1].pause == nil)
        #expect(s[1].lastTool == nil)

        #expect(s[2].discovered == .transcript)
        #expect(!s[2].alive)
        #expect(!s[2].canHardPause)
        #expect(s[2].projectKey == "/Users/alan/code/notes") // null gitCommonDir falls back to cwd
        #expect(s[2].projectName == "notes")
    }

    @Test func summaryFixtureMapsLimitsWithStatusByIdAndNullResetsAt() throws {
        let dto = try Fixtures.decode(SummaryDTO.self, "summary.json")
        let limits = dto.toLimits()
        #expect(limits.first { $0.id == "weekly_all" }?.status == .warn)
        #expect(limits.first { $0.id == "weekly_scoped:fable" }?.resetsAt == nil)
        #expect(limits.first { $0.id == "weekly_scoped:fable" }?.scopeModel == "fable")
        #expect(dto.today.toModel().input == 4_200_000)
    }

    @Test func unknownLimitStatusDefaultsToOkAndUnknownKeysAreIgnored() throws {
        let json = """
        {"limits":{"limits":[{"id":"x","kind":"x","group":"g","percent":1,"severity":"weird",
        "resetsAt":null,"scope":null,"isActive":false,"future":1}],
        "fetchedAt":null,"stale":false,"error":null,"legacyWindows":{},"raw":{}},
        "status":{"byId":{},"overall":"ok"},
        "today":{"input":0,"output":0,"cacheCreate":0,"cacheRead":0,"messages":0},"extra":true}
        """
        let dto = try JSONDecoder().decode(SummaryDTO.self, from: Data(json.utf8))
        #expect(dto.toLimits().map(\.status) == [.ok])
    }

    @Test func nullsAndWrongTypesTakeDefaults() throws {
        let json = #"{"ok":null,"version":7,"uptimeMs":"x","pid":null}"#
        let dto = try JSONDecoder().decode(HealthDTO.self, from: Data(json.utf8))
        #expect(dto.ok)
        #expect(dto.version == "")
        #expect(dto.uptimeMs == 0)
        #expect(dto.install == nil)
    }

    @Test func statusFallsBackToThresholdsWhenNoStatusMapCoversTheId() {
        let t = ThresholdsDTO()
        #expect(LimitStatusMapping.status(for: LimitDTO(id: "weekly_all", kind: "weekly_all", percent: 81), thresholds: t) == .warn)
        #expect(LimitStatusMapping.status(for: LimitDTO(id: "session", kind: "session", percent: 96), thresholds: t) == .critical)
        #expect(LimitStatusMapping.status(for: LimitDTO(id: "w", kind: "weekly_scoped", percent: 10), thresholds: t) == .ok)
        #expect(LimitStatusMapping
            .status(for: LimitDTO(id: "odd", kind: "session", percent: 1, severity: "elevated"), thresholds: t) == .warn)
        #expect(LimitStatusMapping
            .status(for: LimitDTO(id: "b", kind: "session", percent: 1, severity: "blocked"), thresholds: t) == .critical)
    }

    @Test func errorEnvelopeParses() throws {
        let e = try JSONDecoder().decode(ErrorEnvelopeDTO.self, from: Fixtures.errorBody("unauthorized")).error
        #expect(e.code == "unauthorized")
        #expect(Fixtures.errorStatus("unauthorized") == 401)
        #expect(e.message?.hasPrefix("a valid Authorization") == true)
        #expect(e.hint?.hasPrefix("mutating requests") == true)
    }

    @Test(arguments: ["unauthorized", "untrusted_pid", "foreign_uid", "dead_session", "unknown_rule", "unknown_session"])
    func everyDocumentedErrorCaseCarriesACodeAndMessage(name: String) throws {
        let e = try JSONDecoder().decode(ErrorEnvelopeDTO.self, from: Fixtures.errorBody(name)).error
        #expect(!e.code.isEmpty)
        #expect(e.message?.isEmpty == false)
    }

    @Test func documentedErrorStatusesAndCodes() {
        #expect(Fixtures.errorStatus("untrusted_pid") == 409)
        #expect(Fixtures.errorStatus("dead_session") == 410)
        #expect(Fixtures.errorStatus("unknown_rule") == 404)
        #expect(DaemonError.from(status: 409, body: Fixtures.errorBody("untrusted_pid")).code == "conflict")
        #expect(DaemonError.from(status: 410, body: Fixtures.errorBody("dead_session")).code == "gone")
    }

    @Test func pauseResponseAndTokensGroupsParse() throws {
        let p = try Fixtures.decode(PauseResponseDTO.self, "pause-response.json")
        #expect(p.rule.toModel().reason == "usage-deck:9f21c4ab")
        #expect(p.rule.toModel().mode == .hard)
        #expect(p.rule.toModel().scope == "session:3f1c0a52-9d64-4f2e-8b71-2c5a0d9e4411")
        #expect(p.affected == ["3f1c0a52-9d64-4f2e-8b71-2c5a0d9e4411"])

        let t = try Fixtures.decode(TokensDTO.self, "tokens-project.json")
        #expect(t.groups.map { $0.toModel().label } == ["/Users/alan/code/calendarpa"])
    }

    @Test func pauseRulesAndResumeResponseParseTheThreeScopeShapes() throws {
        let rules = try Fixtures.decode(RulesDTO.self, "pause-rules.json")
        #expect(rules.rev == 814)
        #expect(rules.rules.map { $0.toModel().scope } == [
            "session:3f1c0a52-9d64-4f2e-8b71-2c5a0d9e4411",
            "project:/Users/alan/code/foo/.git",
            "all",
        ])
        #expect(rules.rules[0].toModel().mode == .hard)
        #expect(rules.rules[1].toModel().createdBy == "cli")
        #expect(rules.rules[2].toModel().reason == "")

        let resume = try Fixtures.decode(ResumeResponseDTO.self, "resume-response.json")
        #expect(resume.removed == ["r_k3m7qz4ub2ah6ptc"])
        #expect(resume.resumed == ["3f1c0a52-9d64-4f2e-8b71-2c5a0d9e4411"])
    }

    @Test func healthFixtureMapsUserAndDeferredUpdate() throws {
        let dto = try Fixtures.decode(HealthDTO.self, "health.json")
        #expect(dto.name == "alans-mbp")
        #expect(dto.user?.toModel().displayName == "Alan")
        #expect(dto.update?.toModel().state == "deferred")
        #expect(dto.update?.toModel().deferredReason == "hard_frozen_sessions")
        #expect(dto.install == nil, "a pre-v2 daemon has no install block")
    }

    @Test func healthV2InstallBlockParses() throws {
        let dto = try Fixtures.decode(HealthDTO.self, "health-v2.json")
        let install = try #require(dto.install)
        #expect(install.hooks == true)
        #expect(install.statusline == "includes-ours")
        #expect(install.mcp == nil)
        #expect(install.listeners.count == 3)
        #expect(dto.tlsAddrs == ["192.168.1.20"])
        #expect(dto.stats?.spendReady == true)
    }

    @Test func aSessionTitleMapsThroughAndABlankOneIsNil() throws {
        let base = #"{"sessionId":"s","cwd":"/x","startedAt":"2026-09-13T11:20:00Z","lastActivityAt":"2026-09-13T11:21:00Z""#
        func decode(_ json: String) throws -> Session {
            try JSONDecoder().decode(SessionDTO.self, from: Data(json.utf8)).toModel()
        }
        #expect(try decode(base + #","title":"Jamie - Android OS"}"#).title == "Jamie - Android OS")
        #expect(try decode(base + #","title":"  "}"#).title == nil)
        #expect(try decode(base + "}").title == nil)
    }

    @Test func aMalformedPauseFailsTheSessionRatherThanReadingAsRunning() {
        let json = #"{"sessionId":"s","cwd":"/x","startedAt":"a","lastActivityAt":"b","pause":{"mode":"hard"}}"#
        #expect(throws: (any Error).self) { try JSONDecoder().decode(SessionDTO.self, from: Data(json.utf8)) }
    }

    @Test func pairResponseNeverPrintsItsToken() throws {
        let dto = try JSONDecoder().decode(PairResponseDTO.self, from: Data(#"{"token":"SECRET-TOKEN","name":"studio"}"#.utf8))
        #expect(dto.token == "SECRET-TOKEN")
        var dumped = ""
        dump(dto, to: &dumped)
        for text in [String(describing: dto), String(reflecting: dto), "\(dto)", dumped] {
            #expect(!text.contains("SECRET-TOKEN"))
        }
    }
}
