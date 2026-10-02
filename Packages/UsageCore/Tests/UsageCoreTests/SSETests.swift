import Foundation
import Testing
@testable import UsageCore

struct SSEDecoderTests {
    @Test func heartbeatParsesWithEmptyOrBrokenData() {
        #expect(SSEDecoder.decode(event: "heartbeat", data: "") == .emptyHeartbeat)
        #expect(SSEDecoder.decode(event: "heartbeat", data: "{not json") == .emptyHeartbeat)
    }

    @Test func heartbeatCarriesRevAndAt() {
        let e = SSEDecoder.decode(event: "heartbeat", data: #"{"rev":5,"at":"2026-09-13T14:00:15.000Z"}"#)
        #expect(e == .heartbeat(rev: 5, at: "2026-09-13T14:00:15.000Z"))
    }

    @Test func sessionEventParsesTypeAndSession() {
        let e = SSEDecoder.decode(event: "session", data: """
        {"type":"update","session":{"sessionId":"s1","cwd":"/x","startedAt":"2026-09-13T11:20:00Z","lastActivityAt":"2026-09-13T11:21:00Z"}}
        """)
        guard case let .session(type, session) = e else { Issue.record("not a session: \(e)"); return }
        #expect(type == "update")
        #expect(session.sessionId == "s1")
    }

    @Test func spendEventParsesTodayAndDelta() {
        let e = SSEDecoder.decode(event: "spend", data: #"{"today":{"input":10},"delta":{"input":2}}"#)
        guard case let .spend(today, delta) = e else { Issue.record("not spend"); return }
        #expect(delta.input == 2)
        #expect(today.input == 10)
    }

    @Test func limitsEventParsesTheFlatLimitsBody() {
        let e = SSEDecoder.decode(event: "limits", data: """
        {"limits":[{"id":"weekly_all","kind":"weekly_all","percent":96}],"fetchedAt":"2026-09-13T14:00:00Z","stale":false,"error":null}
        """)
        guard case let .limits(limits, fetchedAt, stale) = e else { Issue.record("not limits"); return }
        #expect(limits.map(\.percent) == [96])
        #expect(fetchedAt == "2026-09-13T14:00:00Z")
        #expect(!stale)
    }

    @Test func pauseEventParsesRulesAndAffected() {
        let e = SSEDecoder.decode(event: "pause", data: """
        {"rules":[{"id":"r-1","scope":"all","mode":"soft","reason":"usage-deck:abc","createdAt":"2026-09-13T14:02:00Z","createdBy":"dashboard"}],"affected":["s1"]}
        """)
        guard case let .pause(rules, affected) = e else { Issue.record("not pause"); return }
        #expect(rules.map(\.reason) == ["usage-deck:abc"])
        #expect(affected == ["s1"])
    }

    @Test func updateEventParsesTheHealthUpdateObject() {
        let e = SSEDecoder.decode(event: "update", data: """
        {"channel":"stable","current":"0.1.417+abc","available":null,"state":"deferred","deferredReason":"hard_frozen_sessions"}
        """)
        guard case let .update(update) = e else { Issue.record("not update"); return }
        #expect(update.state == "deferred")
        #expect(update.available == nil)
    }

    @Test func snapshotParsesNestedSummarySessionsAndRulesArray() {
        let json = """
        {"name":"alans-mbp","version":"0.1.5+abc","user":{"emailAddress":"a@b"},
         "summary":{"limits":{"limits":[{"id":"session","kind":"session","percent":42}],"fetchedAt":"2026-09-13T14:00:00Z","stale":false,"error":null},
                    "status":{"byId":{"session":"ok"},"overall":"ok"},"thresholds":{"warn":80,"critical":95},"today":{"ready":true,"input":1}},
         "limits":{"limits":[{"id":"session","kind":"session","percent":42}],"fetchedAt":"2026-09-13T14:00:00Z","stale":false,"error":null},
         "sessions":[],"rules":[{"id":"r","scope":"all","mode":"soft","createdAt":"2026-09-13T00:00:00Z"}],"update":{"state":"idle"},"rev":7}
        """
        guard case let .snapshot(s) = SSEDecoder.decode(event: "snapshot", data: json) else { Issue.record("not snapshot"); return }
        #expect(s.name == "alans-mbp")
        #expect(s.limits.map(\.percent) == [42])
        #expect(s.rules.count == 1)
        #expect(s.rev == 7)
        #expect(s.status.byId["session"] == "ok")
        #expect(s.today.input == 1)
        #expect(s.user?.emailAddress == "a@b")
        #expect(s.update?.state == "idle")
        #expect(s.thresholds.critical == 95)
        #expect(s.fetchedAt == "2026-09-13T14:00:00Z")
    }

    @Test func snapshotAcceptsRulesWrappedInAnObject() {
        let e = SSEDecoder.decode(event: "snapshot", data: #"{"summary":{},"sessions":[],"rules":{"rev":1,"rules":[]},"rev":1}"#)
        guard case let .snapshot(s) = e else { Issue.record("not snapshot"); return }
        #expect(s.rules.isEmpty)
    }

    @Test func snapshotCarriesTheInstallBlockWhenTheDaemonSendsIt() {
        let e = SSEDecoder.decode(
            event: "snapshot",
            data: #"{"rev":1,"install":{"hooks":true,"statusline":"ours","mcp":true,"listeners":[]}}"#
        )
        guard case let .snapshot(s) = e else { Issue.record("not snapshot"); return }
        #expect(s.install?.statusline == "ours")
    }

    @Test func malformedDataYieldsUnknownNotACrash() {
        #expect(SSEDecoder.decode(event: "session", data: "{not json") == .unknown("session"))
    }

    @Test func aSessionMissingARequiredFieldFailsIntoUnknown() {
        #expect(SSEDecoder.decode(event: "session", data: #"{"type":"update","session":{"cwd":"/x"}}"#) == .unknown("session"))
    }

    @Test func unknownEventNameYieldsUnknown() {
        #expect(SSEDecoder.decode(event: "zebra", data: "{}") == .unknown("zebra"))
    }

    @Test func theStandaloneSnapshotFixtureDecodes() {
        guard case let .snapshot(s) = SSEDecoder.decode(event: "snapshot", data: Fixtures.text("snapshot.json")) else {
            Issue.record("not snapshot")
            return
        }
        #expect(s.name == "alans-mbp")
        #expect(s.limits.count == 3)
        #expect(s.sessions.count == 46)
        #expect(s.rules.count == 1)
        #expect(s.rev == 3)
        #expect(s.update?.state == "disabled")
        #expect(s.rules.first?.toModel().scope == "session:3f6c1a2e-8b1d-4c1a-9e1f-5d2a7b9c0e11")
    }
}

struct SSEParserTests {
    @Test func dispatchesOnTheBlankLineAndJoinsDataLines() {
        let frames = SSEParser.frames(in: "event: a\ndata: one\ndata: two\n\n: comment\ndata:x\n\n")
        #expect(frames == [SSEFrame(event: "a", data: "one\ntwo"), SSEFrame(event: nil, data: "x")])
    }

    @Test func handlesCRLFAndBareCR() {
        #expect(SSEParser.frames(in: "event: a\r\ndata: 1\r\n\r\nevent: b\rdata: 2\r\r") == [
            SSEFrame(event: "a", data: "1"),
            SSEFrame(event: "b", data: "2"),
        ])
    }

    @Test func aFrameWithoutDataIsNotDispatchedAndRetryIsIgnored() {
        #expect(SSEParser.frames(in: "retry: 3000\n\nevent: x\n\n").isEmpty)
    }

    @Test func anUnterminatedFrameIsHeldBack() {
        #expect(SSEParser.frames(in: "event: a\ndata: 1\n").isEmpty)
    }

    @Test func theRecordedWireTranscriptDecodesToTheDocumentedSequence() throws {
        let events = SSEParser.frames(in: Fixtures.text("stream.sse")).map { SSEDecoder.decode(event: $0.event, data: $0.data) }
        #expect(events.map(Self.name) == ["snapshot", "pause", "session", "spend", "spend", "heartbeat"])

        guard case let .snapshot(snapshot) = events[0] else { Issue.record("no snapshot"); return }
        #expect(snapshot.name == "alans-mbp")
        #expect(snapshot.version == "0.1.0")
        #expect(snapshot.user?.displayName == "Alan Example")
        #expect(snapshot.limits.map(\.id) == ["session", "weekly_all", "weekly_scoped:fable"])
        #expect(snapshot.limits.first { $0.id == "session" }?.percent == 69)
        #expect(snapshot.limits.first { $0.id == "weekly_scoped:fable" }?.scope?.model == "Fable")
        #expect(snapshot.status.byId["weekly_all"] == "ok")
        #expect(snapshot.thresholds.critical == 95)
        #expect(snapshot.today.input == 7702)
        #expect(snapshot.rev == 3)
        #expect(snapshot.update?.state == "disabled")

        let live = try #require(snapshot.sessions.first).toModel()
        #expect(live.sessionId == "3f6c1a2e-8b1d-4c1a-9e1f-5d2a7b9c0e11")
        #expect(live.pid == 48213)
        #expect(live.projectKey == "/Users/alan/code/foo/.git")
        #expect(live.projectName == "foo")
        #expect(live.worktree == "foo-wt2")
        #expect(live.canHardPause)
        #expect(live.pause?.mode == .soft)
        #expect(live.pause?.ruleId == "r_trpikx7bbznr4lgn")
        #expect(live.lastTool?.name == "Bash")
        let backfilled = snapshot.sessions[1].toModel()
        #expect(backfilled.discovered == .transcript)
        #expect(!backfilled.alive)
        #expect(!backfilled.canHardPause)
        #expect(backfilled.projectKey == "/Users/alan/code/android-project")
        #expect(snapshot.rules.map { $0.toModel().scope } == ["session:3f6c1a2e-8b1d-4c1a-9e1f-5d2a7b9c0e11"])
        #expect(snapshot.rules.first?.reason == "usage-deck:install-7f3a")

        guard case let .pause(rules, affected) = events[1] else { Issue.record("no pause"); return }
        #expect(rules.isEmpty, "the rule was resumed, so the list is empty")
        #expect(affected == ["3f6c1a2e-8b1d-4c1a-9e1f-5d2a7b9c0e11"])

        guard case let .session(type, session) = events[2] else { Issue.record("no session"); return }
        #expect(type == "update")
        #expect(session.pause == nil, "the pause cleared on the same session")

        guard case let .spend(firstToday, _) = events[3], case let .spend(secondToday, secondDelta) = events[4] else {
            Issue.record("no spend")
            return
        }
        // today is cumulative; delta is per-event, so the second delta is the increment.
        #expect(firstToday.input == 7704)
        #expect(secondToday.input == 7708)
        #expect(secondDelta.input == secondToday.input - firstToday.input)
        #expect(events[5] == .heartbeat(rev: 11, at: "2026-09-13T19:01:56.885Z"))
    }

    static func name(_ event: DaemonEvent) -> String {
        switch event {
        case .snapshot: "snapshot"
        case .limits: "limits"
        case .spend: "spend"
        case .session: "session"
        case .pause: "pause"
        case .update: "update"
        case .heartbeat: "heartbeat"
        case let .unknown(name): "unknown:\(name)"
        }
    }
}
