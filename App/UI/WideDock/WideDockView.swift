import SwiftUI
import UsageCore

/// Landscape home (deck spec §11.2). The rail carries the quota rings big enough to read across
/// the room plus the home actions; the sessions list takes the whole right pane. Alerts land in
/// the status bar so nothing reflows.
struct WideDockView: View {
    @Bindable var store: DeckStore

    var body: some View {
        let team = store.team
        let empty = HomeEmpty.of(team)
        VStack(spacing: 0) {
            StatusBar(store: store, showsGear: true)
            HStack(spacing: 0) {
                Rail(store: store, navigation: homeNavigation(store: store, empty: empty))
                    .frame(width: 200)
                    .frame(maxHeight: .infinity)
                    .overlay(alignment: .trailing) { Rectangle().fill(DeckColor.line).frame(width: 1) }
                VStack(spacing: 0) {
                    if let empty {
                        HomeEmptyView(store: store, empty: empty, compact: true)
                    } else {
                        ListCaption(title: "Sessions · \(team.liveSessionCount)", trailing: "tok/min · 30m")
                        ScrollView {
                            LazyVStack(spacing: 0) {
                                let showDevice = team.devices.count > 1
                                ForEach(team.projects.filter { !$0.sessions.isEmpty }) { project in
                                    ForEach(project.sessions) { session in
                                        SessionRow(
                                            store: store,
                                            deviceId: project.deviceId,
                                            projectKey: project.key,
                                            session: session,
                                            headline: project.name,
                                            deviceName: showDevice ? team.device(project.deviceId)?.displayName : nil,
                                            compact: true
                                        )
                                    }
                                }
                            }
                        }
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(DeckColor.bg)
    }
}

private struct Rail: View {
    @Bindable var store: DeckStore
    var navigation: (label: String, action: () -> Void)
    @State private var page: String?

    var body: some View {
        let team = store.team
        let users = team.usersWithData
        VStack(alignment: .leading, spacing: 10) {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if users.isEmpty {
                        Text(team.devices.isEmpty ? "nothing paired" : "waiting for data")
                            .font(DeckFont.text(12))
                            .foregroundStyle(DeckColor.dim)
                        ForEach(team.devices, id: \.id) { DeviceWaitRow(device: $0, now: store.now, compact: true) }
                    } else if users.count == 1, let user = users.first {
                        RailUser(store: store, user: user)
                    } else {
                        pager(users)
                    }
                }
            }
            .scrollBounceBehavior(.basedOnSize)
            VStack(spacing: 6) {
                PauseAllButton(
                    visual: store.visual(.all),
                    padding: 6,
                    centered: true,
                    onTap: { store.tap(.all) },
                    onFreeze: { store.freeze(.all) }
                )
                .frame(height: 36)
                Button(action: navigation.action) {
                    Text(navigation.label)
                        .font(DeckFont.text(14, .medium))
                        .foregroundStyle(DeckColor.fg)
                        .frame(maxWidth: .infinity, minHeight: 36)
                        .overlay(DeckMetrics.buttonShape.strokeBorder(DeckColor.line, lineWidth: 1))
                        .contentShape(DeckMetrics.buttonShape)
                }
                .buttonStyle(.plain)
            }
            Text("team today \(Format.tokens(team.teamToday.total)) · \(team.liveSessionCount) live")
                .font(DeckFont.mono(10))
                .foregroundStyle(DeckColor.dim)
                .lineLimit(1)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    /// One page per account, because each carries its own quota; the dots say how many and which.
    private func pager(_ users: [UserView]) -> some View {
        VStack(spacing: 8) {
            ScrollView(.horizontal) {
                LazyHStack(spacing: 0) {
                    ForEach(users) { user in
                        RailUser(store: store, user: user)
                            .containerRelativeFrame(.horizontal)
                            .id(user.key)
                    }
                }
                .scrollTargetLayout()
            }
            .scrollTargetBehavior(.paging)
            .scrollIndicators(.hidden)
            .scrollPosition(id: $page)
            .accessibilityLabel("accounts")
            HStack(spacing: 6) {
                ForEach(users) { user in
                    Circle()
                        .fill((page ?? users.first?.key) == user.key ? DeckColor.muted : DeckColor.line)
                        .frame(width: 5, height: 5)
                }
            }
            .frame(maxWidth: .infinity)
        }
    }
}

private struct RailUser: View {
    @Bindable var store: DeckStore
    var user: UserView

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(store.name(for: user).uppercased())
                .font(DeckFont.text(11, .semibold))
                .tracking(1.2)
                .foregroundStyle(DeckColor.muted)
                .lineLimit(1)
            HStack(alignment: .bottom, spacing: 10) {
                RingNumber(store: store, limit: user.fiveHour, size: 50, ring: 96)
                RingNumber(store: store, limit: user.sevenDay, size: 24, ring: 56)
            }
            if user.health != .fresh {
                Text("updated \(Format.age(user.limitsFetchedAt, now: store.now))")
                    .font(DeckFont.mono(10))
                    .foregroundStyle(DeckColor.dim)
            }
        }
        .opacity(user.health == .fresh ? 1 : DeckMetrics.staleAlpha)
        .accessibilityElement(children: .combine)
    }
}

/// The percent alone is the headline; colour carries the state. The ring behind it is the same
/// percent as an arc from twelve o'clock on a faint track; under it, countdown and reset time.
private struct RingNumber: View {
    @Bindable var store: DeckStore
    var limit: Limit?
    var size: CGFloat
    var ring: CGFloat

    var body: some View {
        let color = limit.map { DeckColor.of($0.status) } ?? DeckColor.dim
        let fraction = Double(min(max(limit?.percent ?? 0, 0), 100)) / 100
        VStack(spacing: 4) {
            ZStack {
                Circle().stroke(DeckColor.line, lineWidth: 5)
                if fraction > 0 {
                    Circle()
                        .trim(from: 0, to: fraction)
                        .stroke(color, style: StrokeStyle(lineWidth: 5, lineCap: .round))
                        .rotationEffect(.degrees(-90))
                }
                Text(limit.map { "\($0.percent)" } ?? "—")
                    .font(DeckFont.numeral(size))
                    .foregroundStyle(color)
            }
            .frame(width: ring, height: ring)
            Text(Format.resetCountdown(limit?.resetsAt, now: store.now))
                .font(DeckFont.mono(11))
                .foregroundStyle(DeckColor.dim)
                .fixedSize()
            Text(Format.resetAt(limit?.resetsAt, now: store.now, use24h: store.settings.use24h))
                .font(DeckFont.mono(10))
                .foregroundStyle(DeckColor.dim)
                .fixedSize()
        }
    }
}
