import SwiftUI
import UsageCore

/// One live session: identity and tags, then `today · last tool`, the burn rate, the 30-minute
/// sparkline and the pause control. Tapping the row opens the project; the control keeps its own
/// gesture grammar. A dead device's rows fade.
struct SessionRow: View {
    @Bindable var store: DeckStore
    var deviceId: String
    var projectKey: String
    var session: Session
    /// The wide dock leads with the project and moves the session name to the subtitle.
    var headline: String?
    var deviceName: String?
    var compact = false

    var body: some View {
        let target = PauseTarget.session(deviceId: deviceId, sessionId: session.sessionId)
        let name = session.title ?? Format.shortId(session.sessionId)
        let dead = store.team.device(deviceId)?.health == .dead
        HStack(spacing: 8) {
            Button { store.path.append(.project(deviceId: deviceId, key: projectKey)) } label: {
                HStack(spacing: 8) {
                    VStack(alignment: .leading, spacing: compact ? 1 : 3) {
                        HStack(spacing: 6) {
                            Text(headline ?? name)
                                .font(headline != nil || session.title != nil ? DeckFont.text(compact ? 12 : 13, .medium) : DeckFont.mono(
                                    compact ? 12 : 13,
                                    .medium
                                ))
                                .foregroundStyle(DeckColor.fg)
                                .lineLimit(1)
                                .layoutPriority(1)
                            if let pause = session.pause, pause.mode == .hard {
                                Tag(text: Format.frozenTag(pause.freezes), color: DeckColor.frozen)
                            }
                            if let worktree = session.worktree {
                                Tag(text: worktree)
                            }
                            if let model = Format.modelShort(session.model) {
                                Tag(text: model, color: DeckColor.accent)
                            }
                            if let deviceName {
                                Tag(text: Format.hostShort(deviceName))
                            }
                        }
                        Text(subtitle(lead: headline != nil ? name : nil))
                            .font(DeckFont.text(compact ? 10 : 11))
                            .foregroundStyle(DeckColor.muted)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 0)
                    Text(Format.ratePerMin(store.rate(deviceId: deviceId, sessionId: session.sessionId)))
                        .font(DeckFont.numeral(compact ? 14 : 16, .medium))
                        .foregroundStyle(DeckColor.muted)
                        .lineLimit(1)
                        .frame(width: 64, alignment: .trailing)
                    Sparkline(series: store.series(deviceId: deviceId, sessionId: session.sessionId))
                        .frame(width: compact ? 56 : 48, height: compact ? 18 : 20)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            PauseButton(
                visual: store.visual(target),
                subject: name,
                size: compact ? 30 : 34,
                onTap: { store.tap(target) },
                onFreeze: { store.freeze(target) }
            )
        }
        .padding(.leading, 10)
        .padding(.trailing, 4)
        .padding(.vertical, compact ? 0 : 2)
        .opacity(dead ? DeckMetrics.staleAlpha : 1)
    }

    /// `1.2M today · Read 4s ago`, else how long the session has been quiet. A titled session
    /// keeps its short id here so two renamed sessions can still be told apart.
    private func subtitle(lead: String?) -> String {
        let prefix = lead ?? (session.title != nil ? Format.shortId(session.sessionId) : nil)
        let today = (prefix.map { "\($0) · " } ?? "") + "\(Format.tokens(session.tokens.total)) today"
        if let tool = session.lastTool {
            return "\(today) · \(tool.name) \(Format.age(tool.at, now: store.now))"
        }
        return "\(today) · \(Format.age(session.lastActivityAt, now: store.now))"
    }
}

/// A project's collapsed summary on the Ledger: name, worktrees, live count, its own rate and
/// sparkline, and a pause control for the whole project. Tap unfolds; `›` opens the drill-in.
struct ProjectHeader: View {
    @Bindable var store: DeckStore
    var project: ProjectView

    var body: some View {
        let target = PauseTarget.project(deviceId: project.deviceId, projectKey: project.key)
        let id = "\(project.deviceId)|\(project.key)"
        let open = store.expanded.contains(id)
        let dead = store.team.device(project.deviceId)?.health == .dead
        HStack(spacing: 6) {
            Button { withAnimation(.snappy) { store.toggle(id) } } label: {
                HStack(spacing: 6) {
                    Text(open ? "▾" : "▸")
                        .font(DeckFont.text(12))
                        .foregroundStyle(DeckColor.dim)
                        .frame(width: 12)
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 6) {
                            Text(project.name)
                                .font(DeckFont.text(13, .semibold))
                                .foregroundStyle(DeckColor.fg)
                                .lineLimit(1)
                                .layoutPriority(1)
                            if project.worktreeCount > 1 {
                                Tag(text: "\(project.worktreeCount) wt")
                            }
                            Tag(text: "\(project.sessions.count) live")
                        }
                        if !open {
                            Text("\(Format.tokens(project.liveTokens.total)) today")
                                .font(DeckFont.text(11))
                                .foregroundStyle(DeckColor.muted)
                        }
                    }
                    Spacer(minLength: 0)
                    Text(Format.ratePerMin(store.projectRate(deviceId: project.deviceId, key: project.key)))
                        .font(DeckFont.numeral(16, .medium))
                        .foregroundStyle(DeckColor.muted)
                        .lineLimit(1)
                        .frame(width: 64, alignment: .trailing)
                    Sparkline(series: store.projectSparkline(deviceId: project.deviceId, key: project.key))
                        .frame(width: 48, height: 20)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(open ? "Collapse" : "Expand") \(project.name)")
            PauseButton(
                visual: store.visual(target),
                subject: project.name,
                onTap: { store.tap(target) },
                onFreeze: { store.freeze(target) }
            )
            Button { store.path.append(.project(deviceId: project.deviceId, key: project.key)) } label: {
                Text("›")
                    .font(DeckFont.text(22))
                    .foregroundStyle(DeckColor.accent)
                    .frame(width: 24, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Open \(project.name)")
        }
        .padding(.leading, 6)
        .padding(.trailing, 2)
        .padding(.vertical, 2)
        .opacity(dead ? DeckMetrics.staleAlpha : 1)
    }
}

/// A person's quota. Folded (the default) it is one line — name, then 5 h and 7 d — so two
/// people cost the list two rows. Tap unfolds the bars, resets and model-scoped windows; a long
/// press renames. Fades once their device stops checking in, and always says how old it is then.
struct UserBlock: View {
    @Bindable var store: DeckStore
    var user: UserView
    var onRename: () -> Void

    var body: some View {
        let id = "user|\(user.key)"
        let open = store.expanded.contains(id)
        let faded = user.health != .fresh
        let name = store.name(for: user)
        let age = "updated \(Format.age(user.limitsFetchedAt, now: store.now))"
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Text(open ? "▾" : "▸")
                    .font(DeckFont.text(12))
                    .foregroundStyle(DeckColor.dim)
                    .frame(width: 12)
                Text(name)
                    .font(DeckFont.text(15, .semibold))
                    .foregroundStyle(DeckColor.fg)
                    .lineLimit(1)
                if open {
                    Text(faded ? age : identity)
                        .font(DeckFont.mono(11))
                        .foregroundStyle(DeckColor.dim)
                        .lineLimit(1)
                        .frame(maxWidth: .infinity, alignment: .trailing)
                } else {
                    Spacer(minLength: 4)
                    if faded {
                        Text(age)
                            .font(DeckFont.mono(10))
                            .foregroundStyle(DeckColor.dim)
                            .lineLimit(1)
                    }
                    glance("5h", user.fiveHour)
                    glance("7d", user.sevenDay)
                }
            }
            if open {
                LimitBar(label: "5h", limit: user.fiveHour, now: store.now, use24h: store.settings.use24h)
                LimitBar(label: "7d", limit: user.sevenDay, now: store.now, use24h: store.settings.use24h)
                if !user.scoped.isEmpty {
                    HStack(spacing: 6) {
                        ForEach(user.scoped, id: \.id) { limit in
                            Tag(text: "\(limit.scopeModel ?? limit.id) \(limit.percent)%", color: DeckColor.of(limit.status))
                        }
                    }
                }
                if !faded {
                    Text(age)
                        .font(DeckFont.mono(10))
                        .foregroundStyle(DeckColor.dim)
                }
            }
        }
        .padding(.leading, 6)
        .padding(.trailing, 10)
        .padding(.vertical, open ? 8 : 6)
        .contentShape(Rectangle())
        .opacity(faded ? DeckMetrics.staleAlpha : 1)
        .onTapGesture { withAnimation(.snappy) { store.toggle(id) } }
        .onLongPressGesture(perform: onRename)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .accessibilityAction(named: "Rename", onRename)
    }

    private var identity: String {
        [user.emailAddress, user.organizationName].compactMap(\.self).joined(separator: " · ")
    }

    private func glance(_ label: String, _ limit: Limit?) -> some View {
        HStack(alignment: .lastTextBaseline, spacing: 3) {
            Text(label)
                .font(DeckFont.mono(11))
                .foregroundStyle(DeckColor.muted)
            Text(limit.map { "\($0.percent)%" } ?? "—")
                .font(DeckFont.numeral(16, .medium))
                .foregroundStyle(limit.map { DeckColor.of($0.status) } ?? DeckColor.dim)
                .lineLimit(1)
                .frame(width: 40, alignment: .leading)
        }
    }
}

/// The rename prompt shared by the Ledger's long press and Settings.
struct RenameAlert: ViewModifier {
    @Bindable var store: DeckStore
    @Binding var user: UserView?
    @State private var draft = ""

    func body(content: Content) -> some View {
        content.alert(
            "Rename",
            isPresented: Binding(get: { user != nil }, set: {
                if !$0 {
                    user = nil
                }
            }),
            presenting: user
        ) { target in
            TextField("Name", text: $draft)
            Button("Save") {
                store.rename(target.key, to: draft)
                user = nil
            }
            Button("Cancel", role: .cancel) { user = nil }
        } message: { target in
            Text("Shown instead of \(target.displayName). Leave it blank to use the name the device reports.")
        }
        .onChange(of: user?.key) { _, _ in
            draft = user.flatMap { store.settings.names.rename(for: $0) } ?? ""
        }
    }
}

extension View {
    func renameAlert(store: DeckStore, user: Binding<UserView?>) -> some View {
        modifier(RenameAlert(store: store, user: user))
    }
}
