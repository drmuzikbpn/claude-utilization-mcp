import Foundation
import Testing
@testable import UsageCore

/// A device that stops accepting this iPhone (its token rotated, or its certificate was
/// regenerated) must say so, offer a re-pair, and stop hammering it meanwhile.
struct LostPairingTests {
    let unauthorized = DaemonError(code: "unauthorized", httpStatus: 401, hint: "pair this device again")
    let pinning = DaemonError(code: "pinning")

    var timing: DeviceClient.Timing {
        var t = DeviceClient.Timing()
        t.backoffMin = .milliseconds(5)
        t.backoffMax = .milliseconds(20)
        t.pollForeground = .milliseconds(5)
        t.pollBackground = .seconds(30)
        t.projectTokens = .seconds(30)
        t.ticker = .milliseconds(5)
        t.repairProbe = .milliseconds(300)
        return t
    }

    func waitFor(_ timeout: Duration = .seconds(3), _ condition: () async -> Bool) async -> Bool {
        let deadline = ContinuousClock.now + timeout
        while ContinuousClock.now < deadline {
            if await condition() {
                return true
            }
            try? await Task.sleep(for: .milliseconds(5))
        }
        return false
    }

    func client(api: FakeAPI, events: ScriptedEvents) -> DeviceClient {
        DeviceClient(
            record: record(id: "m1", addrs: ["a"]),
            api: api,
            events: { events.next() },
            burn: BurnHistory(),
            clock: ManualClock(t0),
            timing: timing
        )
    }

    // MARK: - errors and the reducer

    @Test func errorsSayWhichKindOfRepair() {
        #expect(unauthorized.repairReason == .tokenRejected)
        #expect(pinning.repairReason == .certificateChanged)
        #expect(DaemonError.network.repairReason == nil)
        #expect(DaemonError(code: "forbidden", httpStatus: 403).repairReason == nil)
    }

    @Test func theReducerKeepsTheReasonUntilTheDeviceAnswers() {
        var r = DeviceReducer(record: record(id: "m1", addrs: ["a"]), burn: BurnHistory())
        r.fail(pinning)
        #expect(r.state.needsRepair)
        #expect(r.state.repairReason == .certificateChanged)
        // A later outage does not hide why the pairing was lost.
        r.fail(.network)
        #expect(r.state.repairReason == .certificateChanged)
        r.fail(unauthorized)
        #expect(r.state.repairReason == .tokenRejected)
        r.touch(now: t0)
        #expect(!r.state.needsRepair)
        #expect(r.state.repairReason == nil)
    }

    @Test func settingNeedsRepairDirectlyMeansARejectedToken() {
        var state = DeviceState(record: record(id: "m1", addrs: ["a"]))
        state.needsRepair = true
        #expect(state.repairReason == .tokenRejected)
        state.needsRepair = false
        #expect(state.repairReason == nil)
    }

    @Test func laterOrdinaryErrorsKeepTheRepairMessage() {
        var r = DeviceReducer(record: record(id: "m1", addrs: ["a"]), burn: BurnHistory())
        r.fail(unauthorized)
        r.fail(.network)
        r.fail(DaemonError(code: "rate_limited", httpStatus: 429))
        #expect(r.state.lastError == "pair this device again", "the re-pair message is the one that matters")
        r.fail(pinning)
        #expect(r.state.lastError == pinning.userMessage)
    }

    // MARK: - the client

    @Test func anSSE401MarksTheDeviceAndBacksOffToASlowProbe() async {
        let api = FakeAPI("m1")
        let events = ScriptedEvents(Array(repeating: [.closed(unauthorized)], count: 50))
        let client = client(api: api, events: events)
        await client.start()
        let marked = await waitFor { await client.state.needsRepair }
        try? await Task.sleep(for: .milliseconds(150))
        let connectsSoon = events.count
        let polled = api.calls.filter { $0 == "summary" }.count
        let state = await client.state
        let probed = await waitFor(.seconds(2)) { events.count > connectsSoon }
        await client.stop()
        #expect(marked)
        #expect(state.repairReason == .tokenRejected)
        #expect(state.lastError == "pair this device again")
        #expect(connectsSoon == 1, "no reconnect storm: one connect, then wait for the probe")
        #expect(polled == 0, "no REST polling against a device that rejects us")
        #expect(probed, "a slow probe keeps going so a restored token recovers")
    }

    @Test func aPinMismatchOnSSEIsACertificateChange() async {
        let api = FakeAPI("m1")
        let events = ScriptedEvents(Array(repeating: [.closed(pinning)], count: 50))
        let client = client(api: api, events: events)
        await client.start()
        let marked = await waitFor { await client.state.repairReason == .certificateChanged }
        await client.stop()
        #expect(marked)
    }

    @Test func aREST401WhilePollingMarksTheDeviceAndStopsPolling() async {
        let api = FakeAPI("m1")
        api.edit {
            $0.failures = 10000
            $0.failWith = unauthorized
        }
        // SSE is down for an ordinary reason, so the client falls back to polling.
        let client = client(api: api, events: ScriptedEvents([]))
        await client.start()
        let marked = await waitFor { await client.state.needsRepair }
        try? await Task.sleep(for: .milliseconds(30))
        let before = api.calls.filter { $0 == "summary" }.count
        try? await Task.sleep(for: .milliseconds(120))
        let after = api.calls.filter { $0 == "summary" }.count
        await client.stop()
        #expect(marked)
        #expect(before == after, "polling stopped once the token was rejected")
    }

    @Test func aREST401OnAOneShotRefreshMarksTheDevice() async {
        let api = FakeAPI("m1")
        api.edit {
            $0.failures = 100
            $0.failWith = unauthorized
        }
        let client = client(api: api, events: ScriptedEvents([]))
        await client.refresh()
        #expect(await client.state.repairReason == .tokenRejected)
    }

    @Test func anAnsweringProbeClearsIt() async {
        let api = FakeAPI("m1")
        let events = ScriptedEvents([[.closed(unauthorized)], [.open, .event(.heartbeat(rev: 4, at: nil))]])
        let client = client(api: api, events: events)
        await client.start()
        let marked = await waitFor { await client.state.needsRepair }
        let recovered = await waitFor(.seconds(2)) {
            let s = await client.state
            return !s.needsRepair && s.rev == 4
        }
        let state = await client.state
        await client.stop()
        #expect(marked)
        #expect(recovered)
        #expect(state.repairReason == nil)
        // The scripted stream ends right after the heartbeat, so an ordinary outage may follow.
        #expect(state.lastError != "pair this device again")
    }

    @Test func aSuccessfulRESTAnswerClearsIt() async {
        let api = FakeAPI("m1")
        let client = client(api: api, events: ScriptedEvents([]))
        api.edit {
            $0.failures = 100
            $0.failWith = unauthorized
        }
        await client.refresh()
        #expect(await client.state.needsRepair)
        api.edit { $0.failures = 0 }
        await client.refresh()
        #expect(await !client.state.needsRepair)
    }

    // MARK: - what the app shows

    @Test func noticesNameTheDeviceTheReasonAndTheFix() {
        var token = device("studio")
        token.repairReason = .tokenRejected
        var cert = device("laptop.local")
        cert.repairReason = .certificateChanged
        let team = TeamState(devices: [token, device("fine"), cert])
        let notices = RepairNotice.all(team)
        #expect(notices.map(\.id) == ["studio", "laptop.local"])
        #expect(notices[0].title == "studio no longer accepts this iPhone")
        #expect(notices[0].reason == "Its access token was changed.")
        #expect(notices[0].instruction == "On studio, run `claude-usage pair`, then tap Re-pair and scan its code.")
        #expect(notices[1].title == "laptop no longer accepts this iPhone")
        #expect(notices[1].reason == "Its certificate changed.")
        for notice in notices {
            #expect(!notice.title.contains("Mac") && !notice.instruction.contains("Mac"))
        }
    }

    @Test func homeSaysRepairNotWaitingWhenEveryDeviceLostItsPairing() {
        var lost = DeviceState(record: record(id: "m1", addrs: ["a"]))
        lost.repairReason = .tokenRejected
        #expect(HomeEmpty.of(TeamState(devices: [lost])) == .needsRepair)
        let waiting = DeviceState(record: record(id: "m2", addrs: ["b"]))
        #expect(HomeEmpty.of(TeamState(devices: [lost, waiting])) == .connecting)
    }

    @Test func stopDuringTheProbeSleepEndsTheLoop() async {
        let api = FakeAPI("m1")
        let events = ScriptedEvents(Array(repeating: [.closed(unauthorized)], count: 50))
        var slow = timing
        slow.repairProbe = .milliseconds(150)
        let client = DeviceClient(
            record: record(id: "m1", addrs: ["a"]),
            api: api,
            events: { events.next() },
            burn: BurnHistory(),
            clock: ManualClock(t0),
            timing: slow
        )
        await client.start()
        _ = await waitFor { await client.state.needsRepair }
        await client.stop()
        let connects = events.count
        try? await Task.sleep(for: .milliseconds(400))
        #expect(events.count == connects, "no probe after stop()")
    }

    @Test func aRestartAfterStopPollsAgainAndAnOldPollerCannotEndIt() async {
        // SSE stays down for ordinary reasons; REST answers. Stop and restart quickly: the new
        // poller must keep running whatever the old one does.
        let api = FakeAPI("m1")
        let client = client(api: api, events: ScriptedEvents([]))
        await client.start()
        _ = await waitFor { await client.state.transport == .polling }
        await client.stop()
        await client.start()
        let resumed = await waitFor { await client.state.transport == .polling }
        let before = api.calls.filter { $0 == "summary" }.count
        let keepsPolling = await waitFor { api.calls.filter { $0 == "summary" }.count > before + 3 }
        await client.stop()
        #expect(resumed)
        #expect(keepsPolling)
    }

    // MARK: - telling the user once

    func lost(_ id: String = "studio", reason: RepairReason = .tokenRejected) -> DeviceState {
        var state = device(id)
        state.repairReason = reason
        return state
    }

    func freshLedger() -> RepairLedger {
        let suite = "repair-ledger-test-\(UUID().uuidString)"
        return RepairLedger(defaults: UserDefaults(suiteName: suite)!, cooldown: 3600)
    }

    @Test func aDeviceKnownGoodThatLosesItsPairingIsAnnouncedOnce() {
        let ledger = freshLedger()
        #expect(ledger.review(TeamState(devices: [device("studio")]), now: t0).isEmpty)
        let alerts = ledger.review(TeamState(devices: [lost()]), now: t0.addingTimeInterval(60))
        #expect(alerts.count == 1)
        #expect(alerts.first?.kind == .repair)
        #expect(alerts.first?.key == "REPAIR|studio")
        #expect(alerts.first?.title == "Re-pair studio")
        #expect(alerts.first?.body == "studio no longer accepts this iPhone. Its access token was changed.")
        #expect(ledger.review(TeamState(devices: [lost()]), now: t0.addingTimeInterval(120)).isEmpty)
    }

    @Test func theLedgerSurvivesARelaunch() throws {
        // Known good in one process; a background refresh in a fresh process sees the 401.
        let suite = "repair-ledger-test-\(UUID().uuidString)"
        _ = try RepairLedger(defaults: #require(UserDefaults(suiteName: suite))).review(TeamState(devices: [device("studio")]), now: t0)
        let relaunched = try RepairLedger(defaults: #require(UserDefaults(suiteName: suite)))
        // The fresh process's first state knows nothing yet: not good, not lost.
        #expect(relaunched.review(TeamState(devices: [DeviceState(record: record(id: "studio", addrs: ["a"]))]), now: t0).isEmpty)
        #expect(relaunched.review(TeamState(devices: [lost()]), now: t0.addingTimeInterval(900)).count == 1)
    }

    @Test func aDeviceNeverSeenGoodIsNotAnnounced() {
        let ledger = freshLedger()
        #expect(ledger.review(TeamState(devices: [lost()]), now: t0).isEmpty)
    }

    @Test func flipFlopsInsideTheCooldownStayQuiet() {
        let ledger = freshLedger()
        _ = ledger.review(TeamState(devices: [device("studio")]), now: t0)
        #expect(ledger.review(TeamState(devices: [lost()]), now: t0.addingTimeInterval(10)).count == 1)
        _ = ledger.review(TeamState(devices: [device("studio")]), now: t0.addingTimeInterval(20))
        #expect(ledger.review(TeamState(devices: [lost()]), now: t0.addingTimeInterval(30)).isEmpty)
        _ = ledger.review(TeamState(devices: [device("studio")]), now: t0.addingTimeInterval(4000))
        #expect(ledger.review(TeamState(devices: [lost()]), now: t0.addingTimeInterval(4010)).count == 1)
    }

    @Test func forgettingADeviceResetsIt() {
        // A re-pair (or removal) forgets the device: its next loss after being good speaks again.
        let ledger = freshLedger()
        _ = ledger.review(TeamState(devices: [device("studio")]), now: t0)
        #expect(ledger.review(TeamState(devices: [lost()]), now: t0.addingTimeInterval(10)).count == 1)
        ledger.forget("studio")
        #expect(ledger.review(TeamState(devices: [lost()]), now: t0.addingTimeInterval(20)).isEmpty, "not known good any more")
        _ = ledger.review(TeamState(devices: [device("studio")]), now: t0.addingTimeInterval(30))
        #expect(ledger.review(TeamState(devices: [lost()]), now: t0.addingTimeInterval(40)).count == 1)
    }

    @Test func theEvaluatorNoLongerRaisesRepairAlertsItself() {
        let previous = TeamState(devices: [device("studio")])
        let next = TeamState(devices: [lost()])
        #expect(AlertEvaluator().evaluate(previous: previous, next: next).allSatisfy { $0.kind != .repair })
    }

    // MARK: - re-pairing the right device

    func invite(name: String, addrs: [String], fingerprint: String = "ff") -> PairingInvite {
        PairingInvite(name: name, addrs: addrs, port: 47292, fingerprint: fingerprint, code: "c")
    }

    @Test func aReplacementMatchesOnNameAddressOrFingerprint() {
        let studio = DeviceRecord(id: "d1", name: "studio.local", addrs: ["192.168.1.20", "studio.local"], port: 47292, fingerprint: "ab")
        #expect(RepairMatch.sameDevice(studio, invite(name: "Studio", addrs: ["10.0.0.9"])))
        #expect(RepairMatch.sameDevice(studio, invite(name: "renamed", addrs: ["192.168.1.20"])))
        #expect(RepairMatch.sameDevice(studio, invite(name: "renamed", addrs: ["10.0.0.9"], fingerprint: "ab")))
        #expect(!RepairMatch.sameDevice(studio, invite(name: "laptop", addrs: ["192.168.1.31", "laptop.local"])))
    }

    // MARK: - the watch

    @Test func theWatchSnapshotCarriesItAndDisablesControls() {
        let snapshot = WatchSnapshot.make(team: TeamState(devices: [lost(), device("laptop")]), escalations: [], now: t0)
        #expect(snapshot.device(id: "studio")?.needsRepair == true)
        #expect(!snapshot.canControl(.project(deviceId: "studio", projectKey: "p")))
        #expect(snapshot.canControl(.all))
    }

    @Test func aRepairFlipIsWorthAWidgetReload() {
        let before = WatchSnapshot.make(team: TeamState(devices: [device("studio")]), escalations: [], now: t0)
        let after = WatchSnapshot.make(team: TeamState(devices: [lost()]), escalations: [], now: t0)
        #expect(!SnapshotDiff.sameHeadline(before, after))
    }
}
