import Foundation
import Synchronization

/// The wall clock, injected so aging, escalation and alert logic can be tested off real time.
public protocol Clock: Sendable {
    func now() -> Date
}

public struct SystemClock: Clock {
    public init() {}

    public func now() -> Date {
        Date()
    }
}

/// A clock that only moves when told to. Used by tests and SwiftUI previews.
public final class ManualClock: Clock {
    private let current: Mutex<Date>

    public init(_ start: Date) {
        current = Mutex(start)
    }

    public func now() -> Date {
        current.withLock { $0 }
    }

    public func advance(seconds: TimeInterval) {
        current.withLock { $0 = $0.addingTimeInterval(seconds) }
    }

    public func set(_ date: Date) {
        current.withLock { $0 = date }
    }
}
