import SwiftUI
import UsageCore

/// The pause grammar (D7) on one target: tap = soft pause, long press → "Freeze?" → hard, tap
/// on paused = resume. Flips optimistically with a spinner until the iPhone answers; failures
/// show under the control.
struct PauseControl: View {
    enum Style {
        /// A full-width button: Pause all, Pause project.
        case wide
        /// A small pill at the end of a session row.
        case compact
    }

    @Environment(PhoneLink.self) private var link
    let target: PauseTarget
    var idleTitle = "Pause"
    /// Replaces the paused/frozen wording, e.g. "Resume all".
    var pausedTitle: String?
    var canHardPause = true
    var freezes = 0
    var style: Style = .compact
    @State private var confirmFreeze = false

    var body: some View {
        let mode = link.displayedPause(for: target)
        let busy = link.isInFlight(target)
        let enabled = link.canControl(target)
        VStack(alignment: style == .wide ? .center : .trailing, spacing: 2) {
            label(mode: mode, busy: busy)
                .contentShape(Capsule())
                .onTapGesture {
                    if enabled, !busy {
                        link.perform(.tap, on: target, canHardPause: canHardPause)
                    }
                }
                .onLongPressGesture(minimumDuration: 0.5) {
                    if enabled, !busy, canHardPause, mode != .hard {
                        confirmFreeze = true
                    }
                }
                .opacity(enabled ? 1 : 0.4)
                .accessibilityElement(children: .combine)
                .accessibilityAddTraits(.isButton)
                .accessibilityHint(mode == nil ? "Tap to pause, hold to freeze" : "Tap to resume")
                .accessibilityAction(named: "Freeze") {
                    if enabled, canHardPause, mode != .hard {
                        confirmFreeze = true
                    }
                }
            if style == .wide, let failure = link.failures[target] {
                FailureText(text: failure)
            }
        }
        .confirmationDialog("Freeze?", isPresented: $confirmFreeze, titleVisibility: .visible) {
            Button("Freeze", role: .destructive) {
                link.perform(.hold, on: target, canHardPause: canHardPause)
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Stops its tools until you resume.")
        }
    }

    @ViewBuilder private func label(mode: PauseMode?, busy: Bool) -> some View {
        let title = switch mode {
        case nil: idleTitle
        case _? where pausedTitle != nil: pausedTitle ?? ""
        case .soft: style == .wide ? "Paused · tap to resume" : "Paused"
        case .hard: Format.frozenTag(max(freezes, 1)).capitalized
        }
        let color = mode == nil ? Theme.text : Theme.color(mode)
        HStack(spacing: 4) {
            if busy {
                ProgressView()
                    .controlSize(.mini)
                    .frame(width: 12, height: 12)
            } else if mode != nil {
                Image(systemName: mode == .hard ? "snowflake" : "pause.fill")
                    .imageScale(.small)
            }
            Text(title)
                .lineLimit(1)
        }
        .font(.system(size: style == .wide ? 15 : 12, weight: .semibold, design: .rounded))
        .foregroundStyle(color)
        .padding(.horizontal, style == .wide ? 12 : 8)
        .padding(.vertical, style == .wide ? 9 : 4)
        .frame(maxWidth: style == .wide ? .infinity : nil)
        .background(color.opacity(mode == nil ? 0.14 : 0.2), in: Capsule())
    }
}

struct FailureText: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.system(size: 11, weight: .medium, design: .rounded))
            .foregroundStyle(Theme.critical)
            .multilineTextAlignment(.center)
            .lineLimit(2)
    }
}

/// `hard in 0:42` while a soft→hard escalation is pending on `target`.
struct EscalationCountdown: View {
    let escalation: Escalation
    var prefix = "hard in"

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            Text(
                escalation.fireAt > context.date
                    ? "\(prefix) \(Format.countdown(escalation.fireAt, now: context.date))"
                    : "freeze due on the iPhone's next wake"
            )
            .font(Theme.data(11))
            .foregroundStyle(Theme.frozen)
        }
    }
}
