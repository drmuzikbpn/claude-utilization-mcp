import Foundation

/// Every number the apps render goes through here, so the phone, the watch and the widgets read
/// the same. Output is deliberately short: a watch face has room for very little.
public enum Format {
    private static let posix = Locale(identifier: "en_US_POSIX")

    /// Formats `date` with a fixed `pattern` in `timeZone`. Fixed patterns (not locale templates)
    /// keep `Thu 09:00` identical everywhere.
    static func pattern(_ pattern: String, _ date: Date, timeZone: TimeZone, locale: Locale = posix) -> String {
        let formatter = DateFormatter()
        formatter.locale = locale
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = timeZone
        formatter.dateFormat = pattern
        return formatter.string(from: date)
    }

    private static func timeOfDay(_ date: Date, _ zone: TimeZone, _ use24h: Bool) -> String {
        pattern(use24h ? "HH:mm" : "h:mm a", date, timeZone: zone)
    }

    private static func dayAndTime(_ date: Date, _ zone: TimeZone, _ use24h: Bool) -> String {
        pattern(use24h ? "EEE HH:mm" : "EEE h:mm a", date, timeZone: zone)
    }

    private static let day: TimeInterval = 86400

    /// When a window resets, as a clock time: `16:35` / `4:35 PM` inside a day, `Thu 09:00` /
    /// `Thu 9:00 AM` a day or more away, `—` without one.
    public static func resetAt(_ at: Date?, now: Date, timeZone: TimeZone = .current, use24h: Bool = true) -> String {
        guard let at else { return "—" }
        return at.timeIntervalSince(now) >= day ? dayAndTime(at, timeZone, use24h) : timeOfDay(at, timeZone, use24h)
    }

    /// The status-bar clock: `18:21`, or `6:21 PM` on a 12-hour clock.
    public static func clock(_ at: Date, timeZone: TimeZone = .current, use24h: Bool = true) -> String {
        timeOfDay(at, timeZone, use24h)
    }

    /// `0`, `999`, `4.2k`, `1.2M`, `12.4M`, `3.1B` — a trailing `.0` is always dropped.
    public static func tokens(_ n: Int64) -> String {
        compact(n)
    }

    /// `0/min`, `412/min`, `38k/min`.
    public static func ratePerMin(_ rate: Double) -> String {
        compact(Int64(rate.rounded())) + "/min"
    }

    /// `resets: unknown` without a reset time, `resets 16:35 · 2h33` inside a day and
    /// `resets Thu 09:00` beyond it.
    public static func resets(_ at: Date?, now: Date, timeZone: TimeZone = .current, use24h: Bool = true) -> String {
        guard let at else { return "resets: unknown" }
        let remaining = at.timeIntervalSince(now)
        if remaining >= day {
            return "resets \(dayAndTime(at, timeZone, use24h))"
        }
        return "resets \(timeOfDay(at, timeZone, use24h)) · \(span(remaining))"
    }

    /// Caption form: `2h33 left` inside a day, `Thu 09:00` beyond it, `unknown` without one.
    public static func resetsShort(_ at: Date?, now: Date, timeZone: TimeZone = .current, use24h: Bool = true) -> String {
        guard let at else { return "unknown" }
        let remaining = at.timeIntervalSince(now)
        if remaining >= day {
            return dayAndTime(at, timeZone, use24h)
        }
        return "\(span(remaining)) left"
    }

    /// Time to a reset as its two largest units: `2d03h`, `1h36m`, `36m12s`; `due` once the reset
    /// has passed (the daemon learns the new window on its next request) and `—` without one.
    public static func resetCountdown(_ until: Date?, now: Date) -> String {
        guard let until else { return "—" }
        let seconds = Int64(until.timeIntervalSince(now).rounded(.down))
        if seconds <= 0 {
            return "due"
        }
        let days = seconds / 86400
        let hours = seconds / 3600 % 24
        let minutes = seconds / 60 % 60
        let secs = seconds % 60
        if days > 0 {
            return "\(days)d\(pad(hours))h"
        }
        if hours > 0 {
            return "\(hours)h\(pad(minutes))m"
        }
        return "\(minutes)m\(pad(secs))s"
    }

    /// `0:42`, `12:05`; a deadline already gone reads `0:00`.
    public static func countdown(_ until: Date, now: Date) -> String {
        let seconds = max(0, Int64(until.timeIntervalSince(now).rounded(.down)))
        return "\(seconds / 60):\(pad(seconds % 60))"
    }

    /// `claude-opus-5` → `opus`, `claude-haiku-4-5-20251001` → `haiku`; unknown ids pass through.
    public static func modelShort(_ model: String?) -> String? {
        guard let model else { return nil }
        let trimmed = model.hasPrefix("claude-") ? String(model.dropFirst("claude-".count)) : model
        let family = trimmed.split(separator: "-", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? ""
        return family.trimmingCharacters(in: .whitespaces).isEmpty ? model : family
    }

    /// `macbook-pro-10.tail0fake.ts.net` → `macbook-pro-10`; a plain host name is unchanged.
    public static func hostShort(_ name: String) -> String {
        String(name.split(separator: ".", maxSplits: 1, omittingEmptySubsequences: false).first ?? "")
    }

    public static let frozenTag = "frozen"
    public static let frozenAgainTag = "frozen again"

    /// `frozen` the first time; `frozen again ×N` once the daemon re-froze the session under the
    /// same rule (daemon §23.16 `freezes`). An empty frozenPids list under a hard rule is normal.
    public static func frozenTag(_ freezes: Int) -> String {
        freezes >= 2 ? "\(frozenAgainTag) ×\(freezes)" : frozenTag
    }

    /// The first four characters of a session id, enough to tell rows apart.
    public static func shortId(_ sessionId: String) -> String {
        String(sessionId.prefix(4)) + "…"
    }

    /// `4s ago`, `3m ago`, `2h ago`, `3d ago`; `never` when there is nothing to age.
    public static func age(_ since: Date?, now: Date) -> String {
        guard let since else { return "never" }
        let seconds = max(0, Int64(now.timeIntervalSince(since).rounded(.down)))
        if seconds < 60 {
            return "\(seconds)s ago"
        }
        if seconds < 3600 {
            return "\(seconds / 60)m ago"
        }
        if seconds < 86400 {
            return "\(seconds / 3600)h ago"
        }
        return "\(seconds / 86400)d ago"
    }

    /// `2h33` for a span with hours in it, `7m` below the hour, clamped at `0m`.
    private static func span(_ remaining: TimeInterval) -> String {
        let seconds = max(0, Int64(remaining.rounded(.down)))
        let hours = seconds / 3600
        let minutes = seconds % 3600 / 60
        return hours > 0 ? "\(hours)h\(pad(minutes))" : "\(minutes)m"
    }

    private static func pad(_ n: Int64) -> String {
        n < 10 ? "0\(n)" : "\(n)"
    }

    private static func compact(_ n: Int64) -> String {
        let value = max(0, n)
        if value < 1000 {
            return "\(value)"
        }
        let thousands = Double(value) / 1000
        let millions = Double(value) / 1_000_000
        if thousands < 999.95 {
            return oneDecimal(thousands) + "k"
        }
        if millions < 999.95 {
            return oneDecimal(millions) + "M"
        }
        return oneDecimal(Double(value) / 1_000_000_000) + "B"
    }

    private static func oneDecimal(_ value: Double) -> String {
        let text = String(format: "%.1f", locale: posix, value)
        return text.hasSuffix(".0") ? String(text.dropLast(2)) : text
    }
}
