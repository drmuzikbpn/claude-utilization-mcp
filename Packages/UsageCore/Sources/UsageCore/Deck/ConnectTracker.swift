import Foundation

/// The one "Connecting to <name>…" attempt in flight after a pairing. Every attempt has its own
/// id, so a late bootstrap or timer from an earlier attempt can never settle, expire or close a
/// newer one; a second pairing is refused while one is connecting. The clock counts foreground
/// time only: a phone put away mid-connect does not come back to a timeout.
public struct ConnectTracker: Sendable, Equatable {
    public struct Attempt: Sendable, Equatable {
        public let id: Int
        public let deviceId: String
        public let name: String
        /// The bootstrap pass (one REST refresh, then the setup check) has finished.
        public var settled = false
        /// The foreground clock ran past the timeout.
        public var expired = false
        /// Foreground time spent before the last pause.
        var waited: TimeInterval = 0
        /// When the clock last started; nil while paused.
        var runningSince: Date?
    }

    public private(set) var current: Attempt?
    public let timeout: TimeInterval
    private var lastId = 0

    public init(timeout: TimeInterval = FirstLoad.timeout) {
        self.timeout = timeout
    }

    /// The new attempt's id, or nil while another attempt is still connecting.
    public mutating func begin(deviceId: String, name: String, now: Date) -> Int? {
        guard current == nil else { return nil }
        lastId += 1
        current = Attempt(id: lastId, deviceId: deviceId, name: name, runningSince: now)
        return lastId
    }

    public mutating func settle(_ id: Int) {
        guard current?.id == id else { return }
        current?.settled = true
    }

    public mutating func expire(_ id: Int) {
        guard current?.id == id else { return }
        current?.expired = true
    }

    /// Closes the attempt and hands it back, once; nil when `id` is not the current attempt.
    public mutating func finish(_ id: Int) -> Attempt? {
        guard let attempt = current, attempt.id == id else { return nil }
        current = nil
        return attempt
    }

    /// The app left the foreground: stop the clock.
    public mutating func pause(now: Date) {
        guard let since = current?.runningSince else { return }
        current?.waited += now.timeIntervalSince(since)
        current?.runningSince = nil
    }

    /// Back in the foreground. Returns the attempt id when it had been paused: whatever its
    /// bootstrap saw while suspended is suspect, so it is unsettled and should run again.
    public mutating func resume(now: Date) -> Int? {
        guard let attempt = current, attempt.runningSince == nil else { return nil }
        current?.runningSince = now
        current?.settled = false
        return attempt.id
    }

    public func elapsed(now: Date) -> TimeInterval {
        guard let attempt = current else { return 0 }
        return attempt.waited + (attempt.runningSince.map { now.timeIntervalSince($0) } ?? 0)
    }

    /// Foreground time left before the timeout; nil when there is no running clock.
    public func remaining(now: Date) -> TimeInterval? {
        guard current?.runningSince != nil else { return nil }
        return max(0, timeout - elapsed(now: now))
    }

    /// Nil when nothing is connecting. Always `loading` while paused: a suspended app's failed
    /// requests are not the device's answer.
    public func phase(state: DeviceState?, check: SetupCheck?, now: Date) -> FirstLoad.Phase? {
        guard let attempt = current else { return nil }
        guard attempt.runningSince != nil else { return .loading }
        return FirstLoad.phase(
            state: state,
            check: check,
            settled: attempt.settled,
            elapsed: attempt.expired ? max(timeout, elapsed(now: now)) : elapsed(now: now),
            timeout: timeout
        )
    }
}
