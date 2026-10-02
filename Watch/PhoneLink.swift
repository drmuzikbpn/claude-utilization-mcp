import Foundation
import Observation
import UsageCore
import WatchConnectivity
import WatchKit
import WidgetKit

/// The watch's only connection to anything: WatchConnectivity to the iPhone, which owns the
/// pairings and talks to the devices. Nothing here ever sees a token, an address or a pin.
///
/// Snapshots arrive three ways: the application context (latest wins, delivered on launch too),
/// replies to `.refresh` / pause requests, and complication user-info transfers. Each one is
/// kept in the App Group for the complications, which are reloaded only when what they draw
/// changed (or on a complication transfer, B2).
@MainActor
@Observable
final class PhoneLink: NSObject {
    /// An optimistic pause flip waiting for the iPhone (`settledAt == nil`) or for a snapshot
    /// that shows it.
    struct Pending: Equatable {
        var expected: PauseMode?
        var settledAt: Date?
    }

    static let pollInterval: Duration = .seconds(10)
    /// How long a confirmed flip may wait for a snapshot that shows it before the snapshot wins.
    static let settleGrace: TimeInterval = 15

    private(set) var snapshot: WatchSnapshot?
    private(set) var reachable = false
    private(set) var pending: [PauseTarget: Pending] = [:]
    private(set) var failures: [PauseTarget: String] = [:]

    private let store = SharedSnapshotStore()
    private var pollTask: Task<Void, Never>?
    private var isSample = false

    override init() {
        super.init()
        snapshot = store.read()
    }

    func start() {
        #if DEBUG
            if let sample = DebugLaunch.sampleSnapshot() {
                isSample = true
                snapshot = sample
                reachable = !DebugLaunch.unreachable
                return
            }
        #endif
        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
    }

    /// Polls `.refresh` every 10 s while the app is in the foreground (B4).
    func setActive(_ active: Bool) {
        pollTask?.cancel()
        pollTask = nil
        guard active else { return }
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                self?.refresh()
                try? await Task.sleep(for: Self.pollInterval)
            }
        }
    }

    // MARK: - reading state

    /// The pause a control should show: the optimistic flip while one stands, else the snapshot's.
    func displayedPause(for target: PauseTarget) -> PauseMode? {
        if let flip = pending[target] {
            return flip.expected
        }
        return snapshot?.pauseMode(for: target)
    }

    func isInFlight(_ target: PauseTarget) -> Bool {
        pending[target].map { $0.settledAt == nil } ?? false
    }

    func canControl(_ target: PauseTarget) -> Bool {
        reachable && (snapshot?.canControl(target) ?? false)
    }

    // MARK: - requests

    func refresh() {
        guard !isSample, reachable, let message = try? WatchWire.pack(WatchRequest.refresh) else { return }
        WCSession.default.sendMessage(
            message,
            replyHandler: { @Sendable [weak self] reply in
                let snapshot = WatchWire.unpack(WatchReply.self, from: reply)?.snapshot.flatMap { try? WatchSnapshotCodec.decode($0) }
                Task { @MainActor in
                    if let snapshot {
                        self?.apply(snapshot, forceReload: false)
                    }
                }
            },
            errorHandler: { @Sendable _ in }
        )
    }

    /// Sends a pause gesture's request with an optimistic flip; the reply's outcomes decide the
    /// haptic and any failure text.
    func perform(_ gesture: PauseGesture, on target: PauseTarget, canHardPause: Bool = true) {
        let current = displayedPause(for: target)
        guard canControl(target), !isInFlight(target),
              let request = PauseGrammar.request(gesture, current: current, target: target, canHardPause: canHardPause)
        else { return }
        failures[target] = nil
        pending[target] = Pending(expected: PauseGrammar.expected(after: request), settledAt: nil)

        if isSample {
            Task { [weak self] in
                try? await Task.sleep(for: .milliseconds(600))
                self?.finish(request, on: target, reply: WatchReply())
            }
            return
        }
        guard let message = try? WatchWire.pack(request) else {
            fail(target, "could not send")
            return
        }
        WCSession.default.sendMessage(
            message,
            replyHandler: { @Sendable [weak self] reply in
                let decoded = WatchWire.unpack(WatchReply.self, from: reply)
                Task { @MainActor in self?.finish(request, on: target, reply: decoded) }
            },
            errorHandler: { @Sendable [weak self] _ in
                Task { @MainActor in self?.fail(target, "iPhone did not answer") }
            }
        )
    }

    private func finish(_ request: WatchRequest, on target: PauseTarget, reply: WatchReply?) {
        guard let reply else {
            fail(target, "iPhone sent no reply")
            return
        }
        if let failure = PauseGrammar.failure(of: request, outcomes: reply.outcomes) {
            fail(target, failure)
            if let data = reply.snapshot, let snapshot = try? WatchSnapshotCodec.decode(data) {
                apply(snapshot, forceReload: false)
            }
            return
        }
        pending[target]?.settledAt = .now
        WKInterfaceDevice.current().play(.success)
        if let data = reply.snapshot, let snapshot = try? WatchSnapshotCodec.decode(data) {
            apply(snapshot, forceReload: false)
        }
    }

    private func fail(_ target: PauseTarget, _ text: String) {
        pending[target] = nil
        failures[target] = text
        WKInterfaceDevice.current().play(.failure)
    }

    // MARK: - snapshots

    private func apply(_ next: WatchSnapshot, forceReload: Bool) {
        if let current = snapshot, current.generatedAt != .distantPast, !current.isSuperseded(by: next) {
            return
        }
        let redraw = forceReload || !next.drawsSameGlance(as: snapshot)
        snapshot = next
        let now = Date.now
        pending = pending.filter { target, flip in
            guard let settledAt = flip.settledAt else { return true }
            return !next.reflects(flip.expected, on: target) && now.timeIntervalSince(settledAt) < Self.settleGrace
        }
        store.write(next)
        if redraw {
            WidgetCenter.shared.reloadAllTimelines()
        }
    }

    fileprivate func receive(_ snapshot: WatchSnapshot?, forceReload: Bool) {
        if let snapshot {
            apply(snapshot, forceReload: forceReload)
        }
    }

    fileprivate func setReachable(_ value: Bool) {
        let cameBack = value && !reachable
        reachable = value
        if cameBack, pollTask != nil {
            refresh()
        }
    }
}

extension PhoneLink: WCSessionDelegate {
    nonisolated func session(_ session: WCSession, activationDidCompleteWith _: WCSessionActivationState, error _: (any Error)?) {
        let snapshot = WatchWire.unpackSnapshot(from: session.receivedApplicationContext)
        let reachable = session.isReachable
        Task { @MainActor in
            self.receive(snapshot, forceReload: false)
            self.setReachable(reachable)
        }
    }

    nonisolated func sessionReachabilityDidChange(_ session: WCSession) {
        let reachable = session.isReachable
        Task { @MainActor in self.setReachable(reachable) }
    }

    nonisolated func session(_: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        let snapshot = WatchWire.unpackSnapshot(from: applicationContext)
        Task { @MainActor in self.receive(snapshot, forceReload: false) }
    }

    /// Complication transfers (`transferCurrentComplicationUserInfo`): always redraw, that is
    /// what the iPhone spent one of the day's transfers on.
    nonisolated func session(_: WCSession, didReceiveUserInfo userInfo: [String: Any] = [:]) {
        let snapshot = WatchWire.unpackSnapshot(from: userInfo)
        Task { @MainActor in self.receive(snapshot, forceReload: true) }
    }
}
