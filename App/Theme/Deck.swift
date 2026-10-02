import SwiftUI
import UsageCore

/// The single dark palette from deck spec §11.6. There is no light theme.
enum DeckColor {
    static let bg = Color(hex: 0x0E1013)
    static let surface = Color(hex: 0x161A20)
    static let surface2 = Color(hex: 0x1E242C)
    static let line = Color(hex: 0x262D37)
    static let fg = Color(hex: 0xE8EBEF)
    static let muted = Color(hex: 0x8B95A3)
    static let dim = Color(hex: 0x5C6674)
    static let ok = Color(hex: 0x3DBE8B)
    static let warn = Color(hex: 0xF0B429)
    static let crit = Color(hex: 0xE5484D)
    static let frozen = Color(hex: 0x5AB4C4)
    /// Sparklines, model tags and links only.
    static let accent = Color(hex: 0x8C9BFF)

    static func of(_ status: LimitStatus) -> Color {
        switch status {
        case .ok: ok
        case .warn: warn
        case .critical: crit
        }
    }

    static func dot(_ health: Health, needsRepair: Bool = false) -> Color {
        if needsRepair {
            return crit
        }
        return switch health {
        case .fresh: ok
        case .stale: warn
        case .dead: dim
        }
    }
}

/// Three families, one job each: condensed numerals for the big figures, a humanist sans for
/// prose and a mono for data. Every face is tabular so figures do not jitter as they tick.
enum DeckFont {
    enum Weight {
        case regular
        case medium
        case semibold
        case bold
    }

    static func numeral(_ size: CGFloat, _ weight: Weight = .semibold) -> Font {
        let name = switch weight {
        case .regular, .medium: "BarlowCondensed-Medium"
        case .semibold: "BarlowCondensed-SemiBold"
        case .bold: "BarlowCondensed-Bold"
        }
        return Font.custom(name, size: size).monospacedDigit()
    }

    static func text(_ size: CGFloat, _ weight: Weight = .regular) -> Font {
        let name = switch weight {
        case .regular: "IBMPlexSans"
        case .medium: "IBMPlexSans-Medm"
        case .semibold, .bold: "IBMPlexSans-SmBld"
        }
        return Font.custom(name, size: size).monospacedDigit()
    }

    static func mono(_ size: CGFloat, _ weight: Weight = .regular) -> Font {
        let name = weight == .regular ? "IBMPlexMono-Regular" : "IBMPlexMono-Medium"
        return Font.custom(name, size: size).monospacedDigit()
    }
}

enum DeckMetrics {
    /// A device or account that stopped checking in fades to this (deck spec §11.1).
    static let staleAlpha = 0.55
    /// The landscape rail (deck WideDock `RAIL_WIDTH` is 200 dp; a little wider here for the rings).
    static let railWidth: CGFloat = 220
    /// Buttons are capsules, the shape Liquid Glass gives system controls.
    static let buttonShape = Capsule(style: .continuous)
}

/// Copy and links shared by the empty state and the pairing screen.
enum DeckLinks {
    static let project = URL(string: "https://github.com/drmuzikbpn/claude-utilization-mcp")!
    static let installCommands = """
    npm i -g @drmuzikbpn/claude-usage
    claude-usage install --lan
    claude-usage pair
    """
}
