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
        #expect(state.lastError == nil)
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

    @Test func losingThePairingRaisesOneAlertForADeviceThatHadArrived() {
        var before = device("studio")
        let previous = TeamState(devices: [before])
        before.repairReason = .tokenRejected
        let next = TeamState(devices: [before])
        let alerts = DeckAlerts.admissible(AlertEvaluator().evaluate(previous: previous, next: next), previous: previous)
        let repair = alerts.filter { $0.kind == .repair }
        #expect(repair.count == 1)
        #expect(repair.first?.title == "Re-pair studio")
        #expect(repair.first?.body == "studio no longer accepts this iPhone. Its access token was changed.")
        // Still lost on the next state: no second alert.
        #expect(AlertEvaluator().evaluate(previous: next, next: next).allSatisfy { $0.kind != .repair })
    }

    @Test func aDeviceLostBeforeItEverArrivedRaisesNoAlert() {
        // The first state after launch: nothing in hand yet, so not news.
        let previous = TeamState(devices: [DeviceState(record: record(id: "m1", addrs: ["a"]))])
        var lost = DeviceState(record: record(id: "m1", addrs: ["a"]))
        lost.repairReason = .tokenRejected
        let next = TeamState(devices: [lost])
        let alerts = DeckAlerts.admissible(AlertEvaluator().evaluate(previous: previous, next: next), previous: previous)
        #expect(alerts.isEmpty)
    }
}
