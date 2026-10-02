import Charts
import SwiftUI
import UsageCore

/// One repo on one device (deck spec §11.3). The tiles stop at what the daemon can answer: the
/// 5 h window is account-wide and rolling, so there is no honest per-project share of it.
struct ProjectScreen: View {
    @Bindable var store: DeckStore
    var deviceId: String
    var key: String
    @State private var choosing = false

    var body: some View {
        let project = store.team.projects.first { $0.deviceId == deviceId && $0.key == key }
        VStack(spacing: 0) {
            if let project {
                content(project)
            } else {
                Text("That project is no longer reported by this device.")
                    .font(DeckFont.text(13))
                    .foregroundStyle(DeckColor.muted)
                    .padding()
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }
        }
        .background(DeckColor.bg)
        .navigationTitle(project?.name ?? fallbackName)
        .navigationBarTitleDisplayMode(.inline)
    }

    /// `/src/repo/.git` → `repo`, for a project the device has stopped reporting.
    private var fallbackName: String {
        let trimmed = key.hasSuffix("/.git") ? String(key.dropLast("/.git".count)) : key
        return trimmed.split(separator: "/").last.map(String.init) ?? key
    }

    @ViewBuilder
    private func content(_ project: ProjectView) -> some View {
        let target = PauseTarget.project(deviceId: deviceId, projectKey: key)
        let visual = store.visual(target)
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 6) {
                    if project.worktreeCount > 1 {
                        Text("\(project.worktreeCount) worktrees")
                            .font(DeckFont.mono(11))
                            .foregroundStyle(DeckColor.muted)
                    }
                    Text(key)
                        .font(DeckFont.mono(10))
                        .foregroundStyle(DeckColor.dim)
                        .lineLimit(1)
                        .truncationMode(.head)
                }
                .padding(.horizontal, 10)
                .padding(.top, 6)
                tiles(project)
                BurnChart(series: store.projectSeries(deviceId: deviceId, key: key))
                    .frame(height: 140)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                breakdown(project.liveTokens)
                LazyVStack(spacing: 0) {
                    ForEach(project.sessions) { session in
                        SessionDetailRow(store: store, deviceId: deviceId, session: session)
                        Divider().overlay(DeckColor.line)
                    }
                }
            }
        }
        if !project.sessions.isEmpty {
            Button {
                if visual.isPaused {
                    store.tap(target)
                } else {
                    choosing = true
                }
            } label: {
                HStack(spacing: 8) {
                    if case .inFlight = visual {
                        ProgressView().controlSize(.small).tint(DeckColor.warn)
                    }
                    Text(visual.isPaused ? "Resume project" : "Pause project")
                        .font(DeckFont.text(14, .semibold))
                }
                .foregroundStyle(visual == .disabled ? DeckColor.dim : DeckColor.warn)
                .frame(maxWidth: .infinity, minHeight: 44)
                .background(DeckColor.surface2, in: DeckMetrics.buttonShape)
                .overlay(DeckMetrics.buttonShape.strokeBorder(DeckColor.warn.opacity(0.45), lineWidth: 1))
            }
            .buttonStyle(.plain)
            .disabled(visual == .disabled)
            .padding(10)
            .background(DeckColor.surface)
            .sensoryFeedback(.impact(weight: .light), trigger: choosing)
            .confirmationDialog(
                "Pause \(project.name) · \(project.sessions.count) \(project.sessions.count == 1 ? "session" : "sessions")?",
                isPresented: $choosing,
                titleVisibility: .visible
            ) {
                Button("Soft pause") { store.tap(target) }
                Button("Freeze", role: .destructive) { store.freeze(target) }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Soft pause holds at the next prompt or tool call; nothing in flight is lost. "
                    + "Freeze stops the running tool now and holds the next one.")
            }
        }
    }

    private func tiles(_ project: ProjectView) -> some View {
        let today = project.todayTokens?.total ?? project.liveTokens.total
        let rate = project.sessions.reduce(0) { $0 + store.rate(deviceId: deviceId, sessionId: $1.sessionId) }
        let deviceToday = store.team.device(deviceId)?.today.total ?? 0
        return HStack(spacing: 8) {
            Tile(label: "today", value: Format.tokens(today))
            Tile(label: "rate", value: Format.ratePerMin(rate))
            Tile(label: "share of today", value: ProjectMath.share(projectToday: today, deviceToday: deviceToday))
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
    }

    private func breakdown(_ tokens: Tokens) -> some View {
        HStack {
            Text("in \(Format.tokens(tokens.input))")
            Spacer()
            Text("out \(Format.tokens(tokens.output))")
            Spacer()
            Text("cache \(ProjectMath.cacheShare(tokens))%")
            Spacer()
            Text("msgs \(tokens.messages)")
        }
        .font(DeckFont.mono(11))
        .foregroundStyle(DeckColor.muted)
        .padding(.horizontal, 10)
        .padding(.vertical, 4)
        .background(DeckColor.surface2)
    }
}

private struct Tile: View {
    var label: String
    var value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(label)
                .font(DeckFont.text(10))
                .foregroundStyle(DeckColor.dim)
            Text(value)
                .font(DeckFont.numeral(24))
                .foregroundStyle(DeckColor.fg)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background(DeckColor.surface, in: RoundedRectangle(cornerRadius: 6))
        .accessibilityElement(children: .combine)
    }
}

/// Short id and start time, the last tool (or last activity), the escalation countdown on the
/// control, and the control itself.
private struct SessionDetailRow: View {
    @Bindable var store: DeckStore
    var deviceId: String
    var session: Session

    var body: some View {
        let target = PauseTarget.session(deviceId: deviceId, sessionId: session.sessionId)
        let since = session.startedAt.formatted(
            Date.FormatStyle(date: .omitted, time: .shortened)
                .hour(store.settings.use24h ? .twoDigits(amPM: .omitted) : .defaultDigits(amPM: .abbreviated))
        )
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text("\(session.title ?? Format.shortId(session.sessionId)) · since \(since)")
                    .font(DeckFont.mono(12))
                    .foregroundStyle(DeckColor.fg)
                    .lineLimit(1)
                Text(activity)
                    .font(DeckFont.text(11))
                    .foregroundStyle(DeckColor.dim)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
            PauseButton(
                visual: store.visual(target),
                subject: session.title ?? Format.shortId(session.sessionId),
                onTap: { store.tap(target) },
                onFreeze: { store.freeze(target) }
            )
        }
        .padding(.leading, 10)
        .padding(.trailing, 4)
        .padding(.vertical, 2)
    }

    /// The daemon does not always report `lastTool`; falling back to raw activity is honest.
    private var activity: String {
        if let tool = session.lastTool {
            return "last tool \(tool.name) \(Format.age(tool.at, now: store.now))"
        }
        return "last activity \(Format.age(session.lastActivityAt, now: store.now))"
    }
}

/// The five-hour burn chart: one y scale with a round top, three gridlines and an endpoint dot.
/// The point is the shape of the last five hours, not precise readings.
struct BurnChart: View {
    var series: [Double]

    private struct Point: Identifiable {
        var minutesAgo: Double
        var value: Double
        var id: Double {
            minutesAgo
        }
    }

    var body: some View {
        let step = series.isEmpty ? 0 : 300 / Double(series.count)
        let points = series.enumerated().map { Point(minutesAgo: -300 + Double($0.offset + 1) * step, value: $0.element) }
        let top = Double(max(ProjectMath.oneSigFig(series.max() ?? 0), 1))
        Chart {
            ForEach(points) { point in
                AreaMark(x: .value("minutes", point.minutesAgo), y: .value("tokens/min", point.value))
                    .foregroundStyle(DeckColor.accent.opacity(0.18))
                LineMark(x: .value("minutes", point.minutesAgo), y: .value("tokens/min", point.value))
                    .foregroundStyle(DeckColor.accent)
                    .lineStyle(StrokeStyle(lineWidth: 1.5))
            }
            if let last = points.last {
                PointMark(x: .value("minutes", last.minutesAgo), y: .value("tokens/min", last.value))
                    .foregroundStyle(DeckColor.accent)
                    .symbolSize(24)
            }
        }
        .chartXScale(domain: -300 ... 0)
        .chartYScale(domain: 0 ... top)
        .chartXAxis {
            AxisMarks(values: [-300, -150, 0]) { value in
                AxisValueLabel {
                    let minutes = value.as(Double.self) ?? 0
                    Text(minutes == 0 ? "now" : minutes == -150 ? "−2h30" : "−5h")
                        .font(DeckFont.mono(10))
                        .foregroundStyle(DeckColor.dim)
                }
            }
        }
        .chartYAxis {
            AxisMarks(position: .leading, values: [0, top / 3, top * 2 / 3, top]) { value in
                AxisGridLine().foregroundStyle(DeckColor.line)
                AxisValueLabel {
                    let v = value.as(Double.self) ?? 0
                    if v == 0 || v == top {
                        Text(Format.tokens(Int64(v)))
                            .font(DeckFont.mono(10))
                            .foregroundStyle(DeckColor.dim)
                    }
                }
            }
        }
        .accessibilityLabel("Burn over the last five hours, up to \(Format.ratePerMin(series.max() ?? 0))")
    }
}

/// Every project the team touched today (deck spec §11.4): live first, idle after, dimmed, with
/// only what they spent.
struct ProjectsScreen: View {
    @Bindable var store: DeckStore

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 0) {
                if store.team.projects.isEmpty {
                    Text("No project has spent anything today.")
                        .font(DeckFont.text(13))
                        .foregroundStyle(DeckColor.muted)
                        .padding()
                }
                ForEach(store.team.projects) { project in
                    Button { store.path.append(.project(deviceId: project.deviceId, key: project.key)) } label: {
                        row(project)
                    }
                    .buttonStyle(.plain)
                    Divider().overlay(DeckColor.line)
                }
            }
        }
        .background(DeckColor.bg)
        .navigationTitle("Projects")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func row(_ project: ProjectView) -> some View {
        let rate = project.sessions.reduce(0) { $0 + store.rate(deviceId: project.deviceId, sessionId: $1.sessionId) }
        let showDevice = store.team.devices.count > 1
        return HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text(project.name)
                    .font(DeckFont.text(14, .medium))
                    .foregroundStyle(DeckColor.fg)
                    .lineLimit(1)
                Text(subtitle(project, showDevice: showDevice))
                    .font(DeckFont.text(11))
                    .foregroundStyle(DeckColor.dim)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
            if !project.isIdle {
                Text(Format.ratePerMin(rate))
                    .font(DeckFont.numeral(15, .medium))
                    .foregroundStyle(DeckColor.muted)
            }
            Text(Format.tokens(project.todayTokens?.total ?? project.liveTokens.total))
                .font(DeckFont.numeral(18, .medium))
                .foregroundStyle(DeckColor.fg)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 10)
        .contentShape(Rectangle())
        .opacity(project.isIdle ? DeckMetrics.staleAlpha : 1)
    }

    private func subtitle(_ project: ProjectView, showDevice: Bool) -> String {
        let state = project.isIdle ? "idle" : "\(project.sessions.count) live"
        guard showDevice, let device = store.team.device(project.deviceId) else { return state }
        return "\(state) · \(Format.hostShort(device.displayName))"
    }
}
