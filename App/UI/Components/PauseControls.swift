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
            // One element per control: the callers name it; the symbol and text inside stay silent.
            .accessibilityElement(children: .ignore)
            .accessibilityAddTraits(.isButton)
            .accessibilityAction(named: "Freeze") {
                if enabled {
                    confirming = true
                }
            }
    }
}

/// The round per-row control: a glass disc showing `pause` idle, the escalation countdown (or
/// `play`) when soft-paused, the frozen time over a snowflake when hard, a spinner while a request
/// is in flight. The glass takes the state's colour, and the symbol morphs and bounces as the
/// state changes.
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
                if case let .inFlight(pausing) = visual {
                    ProgressView()
                        .controlSize(.small)
                        .tint(pausing ? DeckColor.warn : DeckColor.muted)
                } else if let text {
                    VStack(spacing: 0) {
                        if case .frozen = visual {
                            Image(systemName: "snowflake")
                                .font(.system(size: size * 0.24, weight: .bold))
                        }
                        Text(text)
                            .font(DeckFont.mono(10, .medium))
                            .minimumScaleFactor(0.7)
                            .lineLimit(1)
                            .rolling(text)
                    }
                    .foregroundStyle(holding ? DeckColor.crit : labelColor(enabled))
                    .transition(.scale.combined(with: .opacity))
                } else {
                    Image(systemName: symbol)
                        .font(.system(size: size * 0.36, weight: .bold))
                        .foregroundStyle(holding ? DeckColor.crit : labelColor(enabled))
                        .contentTransition(.symbolEffect(.replace))
                        .symbolEffect(.bounce, value: symbol)
                }
            }
            .frame(width: size, height: size)
            .deckGlass(in: Circle(), tint: holding ? DeckColor.crit : tint)
            .overlay(Circle().strokeBorder(holding ? DeckColor.crit : ring, lineWidth: holding ? 2.5 : 1.2))
            .scaleEffect(holding ? 1.12 : 1)
            .animation(.snappy(duration: 0.25), value: holding)
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

    /// The countdown or frozen time, when there is one; otherwise a symbol.
    private var text: String? {
        switch visual {
        case let .soft(countdown): countdown
        case let .frozen(elapsed): elapsed
        default: nil
        }
    }

    private var symbol: String {
        if case .soft = visual {
            return "play.fill"
        }
        return "pause.fill"
    }

    private var tint: Color? {
        switch visual {
        case .frozen: DeckColor.frozen
        case .soft: DeckColor.warn
        default: nil
        }
    }

    private var ring: Color {
        switch visual {
        case .frozen: DeckColor.frozen.opacity(0.7)
        case .soft: DeckColor.warn.opacity(0.6)
        default: .clear
        }
    }

    private func labelColor(_ enabled: Bool) -> Color {
        guard enabled else { return DeckColor.dim }
        return switch visual {
        case .frozen: DeckColor.frozen
        case .soft: DeckColor.warn
        default: DeckColor.fg.opacity(0.8)
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
            let color = holding ? DeckColor.crit : (enabled ? DeckColor.warn : DeckColor.dim)
            HStack(spacing: 8) {
                if case .inFlight = visual {
                    ProgressView().controlSize(.small).tint(DeckColor.warn)
                } else {
                    Image(systemName: visual.isPaused ? "play.fill" : "pause.fill")
                        .font(.system(size: 13, weight: .bold))
                        .contentTransition(.symbolEffect(.replace))
                }
                Text(visual.isPaused ? "Resume all" : "Pause all")
                    .font(DeckFont.text(14, .semibold))
                    .contentTransition(.interpolate)
            }
            .foregroundStyle(color)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: centered ? .center : .leading)
            .padding(.horizontal, 16)
            .padding(.vertical, padding)
            .deckGlass(in: DeckMetrics.buttonShape, tint: enabled ? color : nil)
            .overlay(DeckMetrics.buttonShape.strokeBorder(color.opacity(holding ? 0.9 : 0.35), lineWidth: holding ? 2 : 1))
            .scaleEffect(holding ? 1.04 : 1)
            .animation(.snappy(duration: 0.25), value: holding)
            .animation(.snappy, value: visual.isPaused)
        }
        .accessibilityLabel(visual.isPaused ? "Resume all" : "Pause all")
    }
}

/// The portrait action strip, floating over the list: Pause all, then the navigation buttons, as
/// one group of glass that melds where the buttons meet.
struct BottomBar: View {
    @Bindable var store: DeckStore
    var navigation: (label: String, action: () -> Void)

    var body: some View {
        GlassGroup(spacing: 10) {
            HStack(spacing: 8) {
                PauseAllButton(
                    visual: store.visual(.all),
                    onTap: { store.tap(.all) },
                    onFreeze: { store.freeze(.all) }
                )
                DeckButton(label: navigation.label, action: navigation.action)
                DeckButton(label: "Settings", systemImage: "gearshape.fill") { store.path.append(.settings) }
            }
        }
        .frame(height: 48)
        .padding(.horizontal, 12)
        .padding(.top, 6)
        .padding(.bottom, 4)
    }
}
