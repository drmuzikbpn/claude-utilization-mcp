import SwiftUI
import UsageCore

/// One account: uppercase name, the 5 h window as a big ring and the 7 d window as a small one,
/// each with its countdown and reset time. Stale data fades and wears a corner dot; Always-On
/// keeps the rings and percents only.
struct AccountPage: View {
    @Environment(PhoneLink.self) private var link
    @Environment(\.isLuminanceReduced) private var systemLuminanceReduced
    private var isLuminanceReduced: Bool {
        AlwaysOn.dimmed(systemLuminanceReduced)
    }

    let account: WatchSnapshot.Account
    let snapshot: WatchSnapshot

    var body: some View {
        TimelineView(.periodic(from: .now, by: isLuminanceReduced ? 60 : 1)) { context in
            let now = context.date
            let health = snapshot.health(of: account, now: now)
            let faded = health != .fresh || !link.reachable
            VStack(spacing: 6) {
                if !link.reachable, !isLuminanceReduced {
                    UnreachableBanner()
                }
                header(health: health, now: now)
                HStack(alignment: .top, spacing: 8) {
                    window(account.fiveHour, label: "5 h", size: .big, now: now)
                    window(account.sevenDay, label: "7 d", size: .small, now: now)
                }
                .opacity(faded ? Theme.staleFade : 1)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 4)
        }
        .containerBackground(Theme.ground.gradient, for: .tabView)
    }

    private func header(health: Health, now: Date) -> some View {
        HStack(spacing: 4) {
            Text(account.name.uppercased())
                .font(.system(size: 13, weight: .semibold, design: .rounded))
                .kerning(0.6)
                .foregroundStyle(Theme.muted)
                .lineLimit(1)
            Spacer(minLength: 0)
            if health != .fresh {
                if !isLuminanceReduced {
                    Text(Format.age(snapshot.generatedAt, now: now))
                        .font(Theme.data(11))
                        .foregroundStyle(Theme.color(health))
                }
                Circle()
                    .fill(Theme.color(health))
                    .frame(width: 6, height: 6)
                    .accessibilityLabel(health == .dead ? "no recent data" : "stale data")
            }
        }
    }

    private struct RingSize {
        let diameter: CGFloat
        let line: CGFloat
        let numeral: CGFloat

        static let big = RingSize(diameter: 92, line: 8, numeral: 40)
        static let small = RingSize(diameter: 56, line: 5, numeral: 22)
    }

    private func window(_ headline: WatchSnapshot.Headline?, label: String, size: RingSize, now: Date) -> some View {
        VStack(spacing: 2) {
            RingGauge(ring: RingFace(headline), lineWidth: size.line, numeralSize: size.numeral)
                .frame(width: size.diameter, height: size.diameter)
            if !isLuminanceReduced {
                Text("\(label) · \(Format.resetCountdown(headline?.resetsAt, now: now))")
                    .font(Theme.data(12))
                    .foregroundStyle(Theme.text)
                    .lineLimit(1)
                    .fixedSize()
                Text(Format.resetAt(headline?.resetsAt, now: now, use24h: snapshot.use24h))
                    .font(Theme.data(11))
                    .foregroundStyle(Theme.muted)
                    .lineLimit(1)
                    .fixedSize()
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(label) window")
    }
}
