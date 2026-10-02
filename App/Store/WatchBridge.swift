import Foundation
import Synchronization
import UsageCore
import WatchConnectivity

/// The iPhone end of WatchConnectivity. The watch never talks to a device: it gets snapshots
/// pushed through the application context, asks `{refresh}` every 10 s, and sends pause and
/// resume here, where they run through the same `PauseController` as the phone's own controls.
/// Nothing sent carries a token, an address or a fingerprint (`WatchSnapshot` has none).
@MainActor
final class WatchBridge: NSObject {
    /// Application-context pushes are coalesced to at most one per this interval.
    static let minimumInterval: Duration = .seconds(2)

    private weak var store: DeckStore?
    private var session: WCSession?
    private var lastSent: WatchSnapshot?
    private var lastSentAt: ContinuousClock.Instant?
    private var pending: WatchSnapshot?
    private var trailing: Task<Void, Never>?
    private var lastComplication: WatchSnapshot?
    private var refreshing = false
    /// The latest snapshot bytes, readable from WatchConnectivity's own queue so a `{refresh}`
    /// is answered at once, before any hop to the main actor.
    private nonisolated let cached = Mutex<Data?>(nil)

    func attach(_ store: DeckStore) {
        self.store = store
        store.onSnapshot = { [weak self] snapshot in self?.offer(snapshot) }
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        session.delegate = self
        session.activate()
        self.session = session
    }

    /// Every rebuilt snapshot lands here; only a changed one is sent, and not more than once per
    /// `minimumInterval` (the last one always goes, after the interval).
    private func offer(_ snapshot: WatchSnapshot) {
        let data = try? WatchSnapshotCodec.encode(snapshot)
        cached.withLock { $0 = data }
        guard !SnapshotDiff.sameContent(lastSent, snapshot) else {
            pending = nil
            return
        }
        pending = snapshot
        let clock = ContinuousClock()
        if let lastSentAt, clock.now < lastSentAt.advanced(by: Self.minimumInterval) {
            guard trailing == nil else { return }
            let wait = lastSentAt.advanced(by: Self.minimumInterval) - clock.now
            trailing = Task { [weak self] in
                try? await Task.sleep(for: wait)
                self?.trailing = nil
                self?.flush()
            }
            return
        }
        flush()
    }

    private func flush() {
        guard let snapshot = pending, let session, canSend(session) else { return }
        pending = nil
        guard let packed = try? WatchWire.packSnapshot(snapshot) else { return }
        do {
            try session.updateApplicationContext(packed)
            lastSent = snapshot
            lastSentAt = ContinuousClock().now
        } catch {
            return
        }
        if session.isComplicationEnabled,
           ComplicationPolicy.shouldTransfer(previous: lastComplication, next: snapshot),
           session.remainingComplicationUserInfoTransfers > 0 {
            session.transferCurrentComplicationUserInfo(packed)
            lastComplication = snapshot
        }
    }

    private func canSend(_ session: WCSession) -> Bool {
        session.activationState == .activated && session.isPaired && session.isWatchAppInstalled
    }

    /// After a `{refresh}` reply: when the app is streaming the snapshot is already live, so it
    /// only needs resending; otherwise one REST pass, coalesced across overlapping requests.
    private func refreshForWatch() async {
        guard let store else { return }
        if store.isForeground {
            store.fold()
            return
        }
        guard !refreshing else { return }
        refreshing = true
        defer { refreshing = false }
        await store.refreshAll()
    }

    private func perform(_ request: WatchRequest) async -> [PauseOutcome] {
        guard let store else { return [] }
        let outcomes: [PauseOutcome] = switch request {
        case .refresh:
            []
        case let .pause(target, mode):
            // A hard pause from the watch was already confirmed ("Freeze?") on the watch.
            mode == .hard ? await store.pause.hard(target) : await store.pause.soft(target)
        case let .resume(target):
            await store.pause.resume(target)
        }
        store.fold()
        return outcomes
    }

    private nonisolated func snapshotBytes() -> Data? {
        cached.withLock { $0 }
    }
}

extension WatchBridge: WCSessionDelegate {
    nonisolated func session(_: WCSession, activationDidCompleteWith state: WCSessionActivationState, error _: (any Error)?) {
        guard state == .activated else { return }
        Task { @MainActor in
            self.lastSent = nil
            self.store?.fold()
        }
    }

    nonisolated func sessionDidBecomeInactive(_: WCSession) {}

    /// The user switched watches: activate again so the new one is served.
    nonisolated func sessionDidDeactivate(_ session: WCSession) {
        session.activate()
    }

    nonisolated func sessionWatchStateDidChange(_: WCSession) {
        Task { @MainActor in
            self.lastSent = nil
            self.lastComplication = nil
            self.store?.fold()
        }
    }

    nonisolated func session(
        _: WCSession,
        didReceiveMessage message: [String: Any],
        replyHandler: @escaping ([String: Any]) -> Void
    ) {
        let reply = Reply(replyHandler)
        guard let request = WatchWire.unpack(WatchRequest.self, from: message) else {
            reply.send(WatchReply())
            return
        }
        if request == .refresh {
            // Answer with what is cached right now; the fresh snapshot follows by context.
            reply.send(WatchReply(snapshot: snapshotBytes()))
            Task { @MainActor in await self.refreshForWatch() }
            return
        }
        Task { @MainActor in
            let outcomes = await self.perform(request)
            reply.send(WatchReply(snapshot: self.snapshotBytes(), outcomes: outcomes))
        }
    }
}

/// WatchConnectivity's reply handler is not `Sendable`; it is documented safe to call from any
/// thread, exactly once, which this box enforces.
private final class Reply: @unchecked Sendable {
    private let handler: ([String: Any]) -> Void
    private let sent = Mutex(false)

    init(_ handler: @escaping ([String: Any]) -> Void) {
        self.handler = handler
    }

    func send(_ reply: WatchReply) {
        let first = sent.withLock { done in
            defer { done = true }
            return !done
        }
        guard first else { return }
        handler((try? WatchWire.pack(reply)) ?? [:])
    }
}
