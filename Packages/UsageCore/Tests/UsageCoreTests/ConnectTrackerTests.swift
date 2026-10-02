import Foundation
import Testing
@testable import UsageCore

struct ConnectTrackerTests {
    private let t0 = Date(timeIntervalSince1970: 1_800_000_000)
    private let record = DeviceRecord(id: "d1", name: "studio", addrs: ["192.168.1.20"], port: 47292, fingerprint: "ab")

    private func at(_ seconds: TimeInterval) -> Date {
        t0.addingTimeInterval(seconds)
    }

    private var loaded: DeviceState {
        var state = DeviceState(record: record)
        state.summaryLoaded = true
        return state
    }

    private var healthy: SetupCheck {
        SetupCheck.evaluate(health: HealthDTO(version: "0.1.140", install: InstallDTO()), error: nil, limitsFresh: true)
    }

    @Test func refusesASecondAttemptWhileOneIsConnecting() throws {
        var tracker = ConnectTracker()
        let began1 = tracker.begin(deviceId: "d1", name: "studio", now: t0)
        let first = try #require(began1)
        #expect(tracker.begin(deviceId: "d2", name: "laptop", now: at(1)) == nil)
        #expect(tracker.begin(deviceId: "d1", name: "studio", now: at(1)) == nil)
        #expect(tracker.current?.id == first)
        #expect(tracker.current?.deviceId == "d1")
    }

    @Test func eachAttemptGetsItsOwnId() throws {
        var tracker = ConnectTracker()
        let began2 = tracker.begin(deviceId: "d1", name: "studio", now: t0)
        let first = try #require(began2)
        _ = tracker.finish(first)
        let began3 = tracker.begin(deviceId: "d1", name: "studio", now: at(5))
        let second = try #require(began3)
        #expect(first != second)
    }

    @Test func aStaleAttemptCannotSettleExpireOrFinishTheCurrentOne() throws {
        var tracker = ConnectTracker()
        let began4 = tracker.begin(deviceId: "d1", name: "studio", now: t0)
        let first = try #require(began4)
        _ = tracker.finish(first)
        let began5 = tracker.begin(deviceId: "d1", name: "studio", now: at(1))
        let second = try #require(began5)
        tracker.settle(first)
        tracker.expire(first)
        #expect(tracker.finish(first) == nil)
        #expect(tracker.current?.id == second)
        #expect(tracker.current?.settled == false)
        #expect(tracker.current?.expired == false)
    }

    @Test func finishHandsBackTheAttemptOnce() throws {
        var tracker = ConnectTracker()
        let began6 = tracker.begin(deviceId: "d1", name: "studio", now: t0)
        let id = try #require(began6)
        #expect(tracker.finish(id)?.deviceId == "d1")
        #expect(tracker.current == nil)
        #expect(tracker.finish(id) == nil)
        #expect(tracker.phase(state: loaded, check: healthy, now: at(1)) == nil)
    }

    @Test func elapsedCountsOnlyForegroundTime() throws {
        var tracker = ConnectTracker(timeout: 12)
        let began7 = tracker.begin(deviceId: "d1", name: "studio", now: t0)
        _ = try #require(began7)
        #expect(tracker.elapsed(now: at(4)) == 4)
        tracker.pause(now: at(5))
        #expect(tracker.elapsed(now: at(500)) == 5)
        #expect(tracker.remaining(now: at(500)) == nil)
        #expect(tracker.resume(now: at(600)) != nil)
        #expect(tracker.elapsed(now: at(602)) == 7)
        #expect(tracker.remaining(now: at(602)) == 5)
    }

    @Test func comingBackFromTheBackgroundIsNotATimeout() throws {
        var tracker = ConnectTracker(timeout: 12)
        let began8 = tracker.begin(deviceId: "d1", name: "studio", now: t0)
        _ = try #require(began8)
        tracker.pause(now: at(2))
        _ = tracker.resume(now: at(300))
        #expect(tracker.phase(state: DeviceState(record: record), check: nil, now: at(301)) == .loading)
    }

    @Test func whilePausedItKeepsWaitingWhateverArrives() throws {
        var tracker = ConnectTracker()
        let began9 = tracker.begin(deviceId: "d1", name: "studio", now: t0)
        let id = try #require(began9)
        tracker.settle(id)
        tracker.pause(now: at(1))
        let unreachable = SetupCheck.evaluate(health: nil, error: .network, limitsFresh: false)
        #expect(tracker.phase(state: loaded, check: unreachable, now: at(30)) == .loading)
    }

    @Test func resumingUnsettlesSoTheBootstrapRunsAgain() throws {
        var tracker = ConnectTracker()
        let began10 = tracker.begin(deviceId: "d1", name: "studio", now: t0)
        let id = try #require(began10)
        tracker.settle(id)
        #expect(tracker.resume(now: at(1)) == nil, "already running: nothing to restart")
        tracker.pause(now: at(2))
        #expect(tracker.resume(now: at(3)) == id)
        #expect(tracker.current?.settled == false)
    }

    @Test func expiringFailsWithTheSlowMessage() throws {
        var tracker = ConnectTracker(timeout: 12)
        let began11 = tracker.begin(deviceId: "d1", name: "studio", now: t0)
        let id = try #require(began11)
        #expect(tracker.phase(state: DeviceState(record: record), check: nil, now: at(1)) == .loading)
        tracker.expire(id)
        #expect(tracker.phase(state: DeviceState(record: record), check: nil, now: at(1)) == .failed(FirstLoad.slow("studio")))
    }

    @Test func readyAndSettledPassThroughToFirstLoad() throws {
        var tracker = ConnectTracker()
        let began12 = tracker.begin(deviceId: "d1", name: "studio", now: t0)
        let id = try #require(began12)
        var waiting = loaded
        waiting.summaryLoaded = false
        #expect(tracker.phase(state: waiting, check: healthy, now: at(1)) == .loading)
        tracker.settle(id)
        #expect(tracker.phase(state: waiting, check: healthy, now: at(1)) == .failed(FirstLoad.slow("studio")))
        #expect(tracker.phase(state: loaded, check: healthy, now: at(1)) == .ready)
    }

    @Test func theTimeoutIsInjectable() throws {
        var tracker = ConnectTracker(timeout: 600)
        let began13 = tracker.begin(deviceId: "d1", name: "studio", now: t0)
        _ = try #require(began13)
        #expect(tracker.phase(state: DeviceState(record: record), check: nil, now: at(100)) == .loading)
        #expect(tracker.remaining(now: at(100)) == 500)
    }
}
