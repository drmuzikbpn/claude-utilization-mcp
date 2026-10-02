import Foundation

/// The iPhone app's own preferences (deck spec §11.5, iOS plan "Settings"). No secrets: this is
/// plain JSON in `UserDefaults`.
public struct DeckSettings: Codable, Sendable, Equatable {
    public static let warnRange = 50 ... 94
    public static let criticalMax = 99
    /// Seconds before a soft pause this phone started escalates to a freeze; nil is "off".
    public static let escalationChoices: [Int?] = [30, 60, 90, 180, 300, 600, nil]

    public var warn = 80
    public var critical = 95
    public var escalationSeconds: Int? = 90
    /// Alerts still arrive during quiet hours, silently (no sound, passive interruption level).
    public var quietHours = true
    /// Minutes after local midnight.
    public var quietStartMinutes = 23 * 60
    public var quietEndMinutes = 7 * 60
    public var use24h = true
    public var names = UserNames()

    public init() {}

    public var thresholds: AlertThresholds {
        AlertThresholds(warn: warn, critical: critical)
    }

    /// Whether `date` falls inside quiet hours, which may wrap past midnight. Equal ends mean none.
    public func isQuiet(at date: Date, timeZone: TimeZone = .current) -> Bool {
        guard quietHours, quietStartMinutes != quietEndMinutes else { return false }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let parts = calendar.dateComponents([.hour, .minute], from: date)
        let minute = (parts.hour ?? 0) * 60 + (parts.minute ?? 0)
        if quietStartMinutes < quietEndMinutes {
            return minute >= quietStartMinutes && minute < quietEndMinutes
        }
        return minute >= quietStartMinutes || minute < quietEndMinutes
    }

    /// Values a hand-edited or older store could hold, pulled back into the ranges the UI offers.
    public func clamped() -> DeckSettings {
        var copy = self
        copy.warn = min(max(warn, Self.warnRange.lowerBound), Self.warnRange.upperBound)
        copy.critical = min(max(critical, copy.warn + 1), Self.criticalMax)
        if let seconds = escalationSeconds {
            let choices = Self.escalationChoices.compactMap(\.self)
            copy.escalationSeconds = min(max(seconds, choices.min() ?? seconds), choices.max() ?? seconds)
        }
        copy.quietStartMinutes = min(max(quietStartMinutes, 0), 24 * 60 - 1)
        copy.quietEndMinutes = min(max(quietEndMinutes, 0), 24 * 60 - 1)
        return copy
    }

    private enum CodingKeys: String, CodingKey {
        case warn, critical, escalationSeconds, quietHours, quietStartMinutes, quietEndMinutes, use24h, names
    }

    /// Every key is optional so a store written by an older build still loads.
    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let base = DeckSettings()
        warn = try c.decodeIfPresent(Int.self, forKey: .warn) ?? base.warn
        critical = try c.decodeIfPresent(Int.self, forKey: .critical) ?? base.critical
        escalationSeconds = c.contains(.escalationSeconds)
            ? try c.decodeIfPresent(Int.self, forKey: .escalationSeconds)
            : base.escalationSeconds
        quietHours = try c.decodeIfPresent(Bool.self, forKey: .quietHours) ?? base.quietHours
        quietStartMinutes = try c.decodeIfPresent(Int.self, forKey: .quietStartMinutes) ?? base.quietStartMinutes
        quietEndMinutes = try c.decodeIfPresent(Int.self, forKey: .quietEndMinutes) ?? base.quietEndMinutes
        use24h = try c.decodeIfPresent(Bool.self, forKey: .use24h) ?? base.use24h
        names = try c.decodeIfPresent(UserNames.self, forKey: .names) ?? base.names
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(warn, forKey: .warn)
        try c.encode(critical, forKey: .critical)
        // Encoded as an explicit null so "off" survives a round trip instead of reading as the default.
        try c.encode(escalationSeconds, forKey: .escalationSeconds)
        try c.encode(quietHours, forKey: .quietHours)
        try c.encode(quietStartMinutes, forKey: .quietStartMinutes)
        try c.encode(quietEndMinutes, forKey: .quietEndMinutes)
        try c.encode(use24h, forKey: .use24h)
        try c.encode(names, forKey: .names)
    }
}

public struct DeckSettingsStore: Sendable {
    public static let key = "deck.settings"

    /// UserDefaults is documented thread-safe but not annotated `Sendable`.
    private nonisolated(unsafe) let defaults: UserDefaults

    public init(defaults: UserDefaults) {
        self.defaults = defaults
    }

    public func load() -> DeckSettings {
        guard let data = defaults.data(forKey: Self.key),
              let settings = try? JSONDecoder().decode(DeckSettings.self, from: data)
        else { return DeckSettings() }
        return settings.clamped()
    }

    public func save(_ settings: DeckSettings) {
        if let data = try? JSONEncoder().encode(settings) {
            defaults.set(data, forKey: Self.key)
        }
    }
}
