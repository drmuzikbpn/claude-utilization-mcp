import Foundation
import Testing
@testable import UsageCore

struct FirstLoadTests {
    private let record = DeviceRecord(id: "d1", name: "studio", addrs: ["192.168.1.20"], port: 47292, fingerprint: "ab")

    private func arrived() -> DeviceState {
        var state = DeviceState(record: record)
        state.version = "0.1.140"
        state.summaryLoaded = true
        return state
    }

    private var healthy: SetupCheck {
        SetupCheck.evaluate(health: HealthDTO(version: "0.1.140", install: InstallDTO()), error: nil, limitsFresh: true)
    }

    private var unreachable: SetupCheck {
        SetupCheck.evaluate(health: nil, error: .network, limitsFresh: false)
    }

    @Test func waitsForTheSetupCheck() {
        #expect(FirstLoad.phase(state: arrived(), check: nil, settled: false, elapsed: 1) == .loading)
    }

    @Test func waitsForTheSummary() {
        var state = arrived()
        state.summaryLoaded = false
        #expect(FirstLoad.phase(state: state, check: healthy, settled: false, elapsed: 1) == .loading)
    }

    @Test func readyOnceHealthAndSummaryAreIn() {
        #expect(FirstLoad.phase(state: arrived(), check: healthy, settled: false, elapsed: 1) == .ready)
        #expect(FirstLoad.phase(state: arrived(), check: healthy, settled: true, elapsed: 30) == .ready)
    }

    @Test func aSetupCheckWithFailingRowsIsStillReady() {
        // Failing setup rows are what the device screen is for; they are data, not a load failure.
        let check = SetupCheck.evaluate(health: HealthDTO(version: "0.1.140"), error: nil, limitsFresh: false)
        #expect(!check.allGood)
        #expect(FirstLoad.phase(state: arrived(), check: check, settled: true, elapsed: 2) == .ready)
    }

    @Test func unreachableFailsWithTheDaemonMessage() {
        var state = arrived()
        state.lastError = DaemonError(code: "network", message: nil, hint: "Run claude-usage install --lan").userMessage
        #expect(FirstLoad.phase(state: state, check: unreachable, settled: false, elapsed: 1)
            == .failed("Run claude-usage install --lan"))
    }

    @Test func unreachableWithoutAnErrorFallsBackToTheNetworkDefault() {
        #expect(FirstLoad.phase(state: arrived(), check: unreachable, settled: true, elapsed: 1)
            == .failed(DaemonError.network.userMessage))
    }

    @Test func aRejectedTokenFailsAtOnce() {
        var state = DeviceState(record: record)
        state.needsRepair = true
        state.lastError = DaemonError.defaults["unauthorized"]
        #expect(FirstLoad.phase(state: state, check: nil, settled: false, elapsed: 0)
            == .failed("Token rejected. Re-pair this device."))
    }

    @Test func settledWithoutASummaryFailsWithTheLastError() {
        var state = arrived()
        state.summaryLoaded = false
        state.lastError = "Daemon error (internal)"
        #expect(FirstLoad.phase(state: state, check: healthy, settled: true, elapsed: 2) == .failed("Daemon error (internal)"))
    }

    @Test func settledWithoutASummaryOrErrorSaysItIsSlow() {
        var state = arrived()
        state.summaryLoaded = false
        #expect(FirstLoad.phase(state: state, check: healthy, settled: true, elapsed: 2) == .failed(FirstLoad.slow("studio")))
    }

    @Test func timesOut() {
        #expect(FirstLoad.phase(state: arrived(), check: nil, settled: false, elapsed: FirstLoad.timeout - 0.5) == .loading)
        #expect(FirstLoad.phase(state: arrived(), check: nil, settled: false, elapsed: FirstLoad.timeout)
            == .failed(FirstLoad.slow("studio")))
        #expect(FirstLoad.phase(state: nil, check: nil, settled: false, elapsed: FirstLoad.timeout)
            == .failed(DaemonError.network.userMessage))
    }

    @Test func slowCopySaysDevice() {
        #expect(FirstLoad.slow("studio").contains("studio"))
        #expect(!FirstLoad.slow("studio").contains("Mac"))
    }
}

struct SummaryLoadedTests {
    private let record = DeviceRecord(id: "d1", name: "studio", addrs: ["192.168.1.20"], port: 47292, fingerprint: "ab")

    @Test func aSummaryMarksTheDeviceLoaded() {
        var reducer = DeviceReducer(record: record, burn: BurnHistory())
        #expect(!reducer.state.summaryLoaded)
        reducer.applyHealth(HealthDTO(version: "0.1.140"))
        #expect(!reducer.state.summaryLoaded)
        reducer.applySummary(SummaryDTO(), now: Date())
        #expect(reducer.state.summaryLoaded)
    }

    @Test func aStreamSnapshotMarksTheDeviceLoaded() {
        var reducer = DeviceReducer(record: record, burn: BurnHistory())
        reducer.apply(.heartbeat(rev: 3, at: nil), now: Date())
        #expect(!reducer.state.summaryLoaded)
        reducer.apply(SSEDecoder.decode(event: "snapshot", data: #"{"rev":1}"#), now: Date())
        #expect(reducer.state.summaryLoaded)
    }
}
