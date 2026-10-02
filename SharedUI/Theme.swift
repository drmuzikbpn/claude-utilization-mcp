import SwiftUI
import UsageCore

/// Deck spec §11.6: a dark, single-theme dock LCD. Compiled into the watch app, the watch
/// complications and the iPhone widgets.
enum Theme {
    static let ground = Color(hex: 0x0E1013)
    static let surface = Color(hex: 0x161A20)
    static let line = Color(hex: 0x262D37)
    static let text = Color(hex: 0xE8EBEF)
    static let muted = Color(hex: 0x8B95A3)
    static let ok = Color(hex: 0x3DBE8B)
    static let warn = Color(hex: 0xF0B429)
    static let critical = Color(hex: 0xE5484D)
    static let frozen = Color(hex: 0x5AB4C4)
    /// Sparklines and model tags only.
    static let accent = Color(hex: 0x8C9BFF)

    /// Opacity of anything drawn from stale or dead data (the deck's STALE fade).
    static let staleFade = 0.55

    static func color(_ status: LimitStatus?) -> Color {
        switch status {
        case .ok: ok
        case .warn: warn
        case .critical: critical
        case nil: muted
        }
    }

    static func color(_ health: Health) -> Color {
        switch health {
        case .fresh: ok
        case .stale: warn
        case .dead: critical
        }
    }

    static func color(_ pause: PauseMode?) -> Color {
        switch pause {
        case .soft: warn
        case .hard: frozen
        case nil: muted
        }
    }

    /// Barlow Condensed SemiBold for numerals (bundled, OFL), tabular. Falls back to SF if the
    /// font failed to register.
    static func numeral(_ size: CGFloat, relativeTo style: Font.TextStyle = .body) -> Font {
        Font.custom("BarlowCondensed-SemiBold", size: size, relativeTo: style).monospacedDigit()
    }

    /// Small data captions (countdowns, reset times, ages).
    static func data(_ size: CGFloat) -> Font {
        .system(size: size, weight: .medium, design: .rounded).monospacedDigit()
    }
}

extension Color {
    init(hex: UInt32) {
        self.init(
            red: Double(hex >> 16 & 0xFF) / 255,
            green: Double(hex >> 8 & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255
        )
    }
}
