import SwiftUI
import UsageCore

/// Landscape home (deck spec §11.2). The rail carries the quota rings big enough to read across
/// the room plus the home actions; the sessions list takes the whole right pane. Alerts land in
/// the status bar so nothing reflows.
struct WideDockView: View {
    @Bindable var store: DeckStore
    @State private var gutters = Gutters()

    var body: some View {
        let team = store.team
        let empty = HomeEmpty.of(team)
        VStack(spacing: 0) {
            StatusBar(store: store, showsGear: true)
            HStack(spacing: 0) {
                Rail(store: store, navigation: homeNavigation(store: store, empty: empty))
                    .frame(width: DeckMetrics.railWidth)
                    .frame(maxHeight: .infinity)
                    .deckCard(radius: 24)
                    .padding(.bottom, 8)
                VStack(spacing: 0) {
                    if let empty {
                        HomeEmptyView(store: store, empty: empty, compact: true)
                    } else {
                        ListCaption(title: "Sessions · \(team.liveSessionCount)", trailing: "tok/min · 30m")
                        ScrollView {
                            let showDevice = team.devices.count > 1
                            // Fastest first across every project, so the busiest session is always on top.
                            let rows = store.liveRows.enumerated().map { index, row in
                                (
                                    key: "\(row.project.deviceId):\(row.session.id)",
                                    project: row.project,
                                    session: row.session,
                                    rank: index
                                )
                            }
                            // The project screen zooms out of its first (busiest) row.
                            let zoomRows = Dictionary(
                                rows.map { (ZoomSource.id(deviceId: $0.project.deviceId, key: $0.project.key), $0.key) }
                            ) { first, _ in first }
                            LazyVStack(spacing: 6) {
                                ForEach(rows, id: \.key) { item in
                                    SessionRow(
                                        store: store,
                                        deviceId: item.project.deviceId,
                                        projectKey: item.project.key,
                                        session: item.session,
                                        headline: item.project.name,
                                        deviceName: showDevice ? team.device(item.project.deviceId)?.displayName : nil,
                                        compact: true
                                    )
                                    .padding(.vertical, 4)
                                    .deckCard(radius: 14)
                                    .modifier(zoomRows[ZoomSource.id(deviceId: item.project.deviceId, key: item.project.key)] == item.key
                                        ? ZoomSource(id: ZoomSource.id(deviceId: item.project.deviceId, key: item.project.key))
                                        : ZoomSource(id: item.key))
                                    .liftOnReorder(item.rank)
                                }
                            }
                            .padding(.leading, 8)
                            .padding(.bottom, 8)
                            .animation(Reorder.slide, value: rows.map(\.key))
                        }
                        .scrollIndicators(.hidden)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        // Landscape insets are symmetric, but only one side holds the Dynamic Island (or notch).
        // Clear that one; on the other, run to a thin gutter inside the rounded corner.
        .padding(.leading, gutters.leading)
        .padding(.trailing, gutters.trailing)
        // Read from the window: below `ignoresSafeArea` the insets read as zero.
        .onGeometryChange(for: CGSize.self, of: \.size) { _ in gutters = Gutters.current() }
        // Turning straight from one landscape to the other keeps the size but moves the island.
        .onReceive(NotificationCenter.default.publisher(for: UIDevice.orientationDidChangeNotification)) { _ in
            Task {
                // The interface follows the device after its rotation animation begins.
                try? await Task.sleep(for: .milliseconds(300))
                withAnimation(.snappy) { gutters = Gutters.current() }
            }
        }
        .ignoresSafeArea(.container, edges: .horizontal)
        .deckScreen()
    }
}

/// How far the wide dock stays off each side. Landscape insets are symmetric, but only one side
/// holds the Dynamic Island (or notch): clear that one, and on the other run to a thin gutter just
/// inside the rounded corner.
struct Gutters: Equatable {
    var leading: CGFloat = 0
    var trailing: CGFloat = 0

    /// The island is about 37 pt deep and sits about 11 pt in from the edge.
    static let cutoutClearance: CGFloat = 52
    /// Enough to clear the screen's rounded corner.
    static let cornerGutter: CGFloat = 16
    /// Cards never touch the glass, even on a screen with no insets at all.
    static let minimum: CGFloat = 8

    /// The cutout is at the top of the phone: on the left when the interface is landscape-right,
    /// on the right when it is landscape-left.
    static func of(leading: CGFloat, trailing: CGFloat, orientation: UIInterfaceOrientation) -> Gutters {
        Gutters(
            leading: max(min(leading, orientation == .landscapeRight ? cutoutClearance : cornerGutter), minimum),
            trailing: max(min(trailing, orientation == .landscapeLeft ? cutoutClearance : cornerGutter), minimum)
        )
    }

    @MainActor
    static func current() -> Gutters {
        guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first,
              let window = scene.keyWindow ?? scene.windows.first
        else { return Gutters() }
        let insets = window.safeAreaInsets
        return of(leading: insets.left, trailing: insets.right, orientation: scene.interfaceOrientation)
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
            GlassGroup(spacing: 6) { VStack(spacing: 6) {
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
                        .contentShape(DeckMetrics.buttonShape)
                        .deckGlass(in: DeckMetrics.buttonShape, interactive: true)
                }
                .buttonStyle(.plain)
            } }
            Text("team today \(Format.tokens(team.teamToday.total)) · \(team.liveSessionCount) live")
                .font(DeckFont.mono(10))
                .foregroundStyle(DeckColor.dim)
                .lineLimit(1)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
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
                    let current = (page ?? users.first?.key) == user.key
                    Capsule()
                        .fill(current ? DeckColor.fg.opacity(0.8) : DeckColor.line)
                        .frame(width: current ? 14 : 5, height: 5)
                        .animation(.snappy, value: current)
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
            // Sized to the rail's width so the 7 d ring never clips: big + gap + 0.6 × big.
            let big = min(118, (DeckMetrics.railWidth - 24 - 12) / 1.6)
            HStack(alignment: .bottom, spacing: 10) {
                RingNumber(store: store, limit: user.fiveHour, size: big * 0.5, ring: big)
                RingNumber(store: store, limit: user.sevenDay, size: big * 0.6 * 0.42, ring: big * 0.6)
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
        let countdown = Format.resetCountdown(limit?.resetsAt, now: store.now)
        VStack(spacing: 4) {
            RingGauge(ring: RingFace(limit: limit), lineWidth: max(5, ring * 0.06), numeralSize: size, lively: true)
                .frame(width: ring, height: ring)
            Text(countdown)
                .font(DeckFont.mono(11))
                .foregroundStyle(DeckColor.muted)
                .fixedSize()
                .rolling(countdown)
            Text(Format.resetAt(limit?.resetsAt, now: store.now, use24h: store.settings.use24h))
                .font(DeckFont.mono(10))
                .foregroundStyle(DeckColor.dim)
                .fixedSize()
        }
    }
}
