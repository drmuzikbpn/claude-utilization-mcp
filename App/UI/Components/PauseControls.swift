import SwiftUI
import UsageCore

/// The one gesture grammar every pause control uses (D7): tap = soft pause (or resume when
/// paused); a long press asks "Freeze?" and only a confirmed freeze goes hard. Red appears only
/// for the hard action — while the press is held and on the confirm button.
struct PauseGestureArea<Label: View>: View {
    var enabled: Bool
    /// What the "Freeze?" dialog names: a session, a project, "all sessions".
    var subject: String
    var onTap: () -> Void
    var onFreeze: () -> Void
    @ViewBuilder var label: (_ holding: Bool) -> Label

    @State private var holding = false
    @State private var confirming = false
    @State private var taps = 0
    @State private var holds = 0

    var body: some View {
        label(holding)
            .contentShape(Rectangle())
            .onTapGesture {
                guard enabled else { return }
                taps += 1
                onTap()
            }
            .onLongPressGesture(minimumDuration: 0.6) {
                guard enabled else { return }
                holds += 1
                confirming = true
            } onPressingChanged: { pressing in
                holding = enabled && pressing
            }
            .sensoryFeedback(.impact(weight: .light), trigger: taps)
            .sensoryFeedback(.warning, trigger: holds)
            .confirmationDialog("Freeze?", isPresented: $confirming, titleVisibility: .visible) {
                Button("Freeze \(subject)", role: .destructive, action: onFreeze)
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Stops the running tool now and holds the next one; the session itself stays open.")
            }
            .accessibilityAddTraits(.isButton)
            .accessibilityAction(named: "Freeze") {
                if enabled {
                    confirming = true
                }
            }
    }
}

/// The round per-row control: `❚❚` idle, the escalation countdown (or `▶`) when soft-paused, the
/// frozen time when hard, a spinner while a request is in flight.
struct PauseButton: View {
    var visual: PauseVisual
    var subject: String
    var size: CGFloat = 34
    var onTap: () -> Void
    var onFreeze: () -> Void

    var body: some View {
        let enabled = visual != .disabled && !isInFlight
        PauseGestureArea(enabled: enabled, subject: subject, onTap: onTap, onFreeze: onFreeze) { holding in
            ZStack {
                Circle().fill(fill)
                Circle().strokeBorder(holding ? DeckColor.crit : ring, lineWidth: holding ? 2.5 : 1.5)
                if case let .inFlight(pausing) = visual {
                    ProgressView()
                        .controlSize(.small)
                        .tint(pausing ? DeckColor.warn : DeckColor.muted)
                } else {
                    Text(label)
                        .font(isGlyph ? DeckFont.text(13, .medium) : DeckFont.mono(10, .medium))
                        .foregroundStyle(holding ? DeckColor.crit : labelColor(enabled))
                        .minimumScaleFactor(0.7)
                        .lineLimit(1)
                }
            }
            .frame(width: size, height: size)
        }
        .frame(width: max(size, 44), height: max(size, 44))
        .accessibilityLabel(accessibilityText)
    }

    private var isInFlight: Bool {
        if case .inFlight = visual {
            return true
        }
        return false
    }

    private var label: String {
        switch visual {
        case let .soft(countdown): countdown ?? "▶"
        case let .frozen(elapsed): elapsed
        default: "❚❚"
        }
    }

    private var isGlyph: Bool {
        label == "❚❚" || label == "▶"
    }

    private var ring: Color {
        switch visual {
        case .frozen: DeckColor.frozen
        case .soft: DeckColor.warn
        case .disabled: DeckColor.line
        default: DeckColor.dim
        }
    }

    private var fill: Color {
        switch visual {
        case .frozen: DeckColor.frozen.opacity(0.12)
        case .soft: DeckColor.warn.opacity(0.10)
        default: DeckColor.surface
        }
    }

    private func labelColor(_ enabled: Bool) -> Color {
        guard enabled else { return DeckColor.dim }
        return switch visual {
        case .frozen: DeckColor.frozen
        case .soft: DeckColor.warn
        default: DeckColor.muted
        }
    }

    private var accessibilityText: String {
        switch visual {
        case .idle: "Pause \(subject)"
        case .soft: "Resume \(subject), paused"
        case .frozen: "Resume \(subject), frozen"
        case .disabled: "Pause \(subject), device unreachable"
        case .inFlight: "\(subject), working"
        }
    }
}

/// The amber "Pause all" button. It reads "Resume all" once an `all` rule stands.
struct PauseAllButton: View {
    var visual: PauseVisual
    var padding: CGFloat = 10
    var centered = false
    var onTap: () -> Void
    var onFreeze: () -> Void

    var body: some View {
        let enabled = visual != .disabled
        PauseGestureArea(enabled: enabled, subject: "all sessions", onTap: onTap, onFreeze: onFreeze) { holding in
            HStack(spacing: 8) {
                if case .inFlight = visual {
                    ProgressView().controlSize(.small).tint(DeckColor.warn)
                }
                Text(visual.isPaused ? "Resume all" : "Pause all")
                    .font(DeckFont.text(14, .semibold))
                    .foregroundStyle(holding ? DeckColor.crit : (enabled ? DeckColor.warn : DeckColor.dim))
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: centered ? .center : .leading)
            .padding(.horizontal, 14)
            .padding(.vertical, padding)
            .background(DeckColor.surface2, in: DeckMetrics.buttonShape)
            .overlay(
                DeckMetrics.buttonShape.strokeBorder(
                    (holding ? DeckColor.crit : DeckColor.warn).opacity(holding ? 0.9 : 0.45),
                    lineWidth: holding ? 2 : 1
                )
            )
        }
        .accessibilityLabel(visual.isPaused ? "Resume all" : "Pause all")
    }
}

/// The portrait action strip: Pause all, then the navigation buttons.
struct BottomBar: View {
    @Bindable var store: DeckStore
    var navigation: (label: String, action: () -> Void)

    var body: some View {
        HStack(spacing: 8) {
            PauseAllButton(
                visual: store.visual(.all),
                onTap: { store.tap(.all) },
                onFreeze: { store.freeze(.all) }
            )
            DeckButton(label: navigation.label, action: navigation.action)
            DeckButton(label: "Settings", systemImage: "gearshape") { store.path.append(.settings) }
        }
        .frame(height: 44)
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(DeckColor.surface)
    }
}
