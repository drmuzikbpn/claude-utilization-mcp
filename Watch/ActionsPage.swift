import SwiftUI
import UsageCore

/// The last vertical page: Pause all / Resume all, Projects, devices that need re-pairing, a
/// pending escalation and the `today 4.2M · 3 live` footer.
struct ActionsPage: View {
    @Environment(PhoneLink.self) private var link
    @Environment(\.isLuminanceReduced) private var isLuminanceReduced
    let snapshot: WatchSnapshot

    var body: some View {
        ScrollView {
            if !link.reachable, !isLuminanceReduced {
                UnreachableBanner()
                    .padding(.horizontal, 4)
            }
            VStack(spacing: 8) {
                PauseControl(
                    target: .all,
                    idleTitle: "Pause all",
                    pausedTitle: "Resume all",
                    canHardPause: true,
                    style: .wide
                )
                if let escalation = snapshot.nextEscalation, !isLuminanceReduced {
                    EscalationCountdown(escalation: escalation, prefix: "freeze in")
                }
                NavigationLink(value: Route.projects) {
                    HStack {
                        Text("Projects")
                        Spacer()
                        Text("\(snapshot.projects.count)")
                            .font(Theme.numeral(17))
                            .foregroundStyle(Theme.muted)
                    }
                }
                .font(.system(size: 15, weight: .semibold, design: .rounded))
                ForEach(snapshot.devices.filter(\.needsRepair)) { device in
                    Label("\(Format.hostShort(device.name)) · Needs re-pair", systemImage: "exclamationmark.triangle.fill")
                        .font(.system(size: 12, weight: .medium, design: .rounded))
                        .foregroundStyle(Theme.warn)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                ForEach(snapshot.devices.filter { $0.health == .dead && !$0.needsRepair }) { device in
                    Label("\(Format.hostShort(device.name)) · offline", systemImage: "bolt.horizontal.circle")
                        .font(.system(size: 12, weight: .medium, design: .rounded))
                        .foregroundStyle(Theme.muted)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                Text(snapshot.footer)
                    .font(Theme.data(12))
                    .foregroundStyle(Theme.muted)
                    .padding(.top, 2)
            }
            .padding(.horizontal, 4)
            .opacity(link.reachable ? 1 : Theme.staleFade)
        }
        .containerBackground(Theme.ground.gradient, for: .tabView)
    }
}
