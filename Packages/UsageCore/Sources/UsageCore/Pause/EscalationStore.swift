import Foundation
import Synchronization

/// A scheduled soft→hard escalation. Persisted so it survives the app being killed; an overdue
/// one fires on the next wake (deck spec §9, iOS decision D10).
public struct Escalation: Codable, Sendable, Equatable, Hashable {
    public var deviceId: String
    public var scope: String
    public var fireAt: Date

    public init(deviceId: String, scope: String, fireAt: Date) {
        self.deviceId = deviceId
        self.scope = scope
        self.fireAt = fireAt
    }
}

public protocol EscalationStore: Sendable {
    func load() -> [Escalation]
    func save(_ escalations: [Escalation])
}

public final class InMemoryEscalationStore: EscalationStore {
    private let escalations = Mutex<[Escalation]>([])

    public init() {}

    public func load() -> [Escalation] {
        escalations.withLock { $0 }
    }

    public func save(_ list: [Escalation]) {
        escalations.withLock { $0 = list }
    }
}

/// JSON in `UserDefaults` (the App Group suite, so the widget and a background task see it too).
public struct UserDefaultsEscalationStore: EscalationStore {
    public static let defaultKey = "pause.escalations"

    /// UserDefaults is documented thread-safe but not annotated `Sendable`.
    private nonisolated(unsafe) let defaults: UserDefaults
    private let key: String

    public init(defaults: UserDefaults, key: String = defaultKey) {
        self.defaults = defaults
        self.key = key
    }

    public func load() -> [Escalation] {
        guard let data = defaults.data(forKey: key) else { return [] }
        return (try? JSONDecoder().decode([Escalation].self, from: data)) ?? []
    }

    public func save(_ escalations: [Escalation]) {
        if escalations.isEmpty {
            defaults.removeObject(forKey: key)
        } else if let data = try? JSONEncoder().encode(escalations) {
            defaults.set(data, forKey: key)
        }
    }
}
