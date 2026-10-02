import SwiftUI
import UsageCore

/// App-wide policy on one page: devices, account names, alert thresholds, escalation, quiet
/// hours and the clock.
struct SettingsScreen: View {
    @Bindable var store: DeckStore
    @State private var renaming: UserView?

    var body: some View {
        List {
            Section("Devices") {
                ForEach(store.team.devices, id: \.id) { device in
                    Button { store.path.append(.device(device.id)) } label: {
                        HStack {
                            Circle()
                                .fill(DeckColor.dot(device.health, needsRepair: device.needsRepair))
                                .frame(width: 8, height: 8)
                            Text(device.displayName).foregroundStyle(DeckColor.fg)
                            Spacer()
                            if device.needsRepair {
                                Text("re-pair").font(DeckFont.mono(11)).foregroundStyle(DeckColor.crit)
                            }
                            Image(systemName: "chevron.right").foregroundStyle(DeckColor.dim)
                        }
                    }
                }
                Button("Pair a device") { store.beginPairing() }
                    .foregroundStyle(DeckColor.accent)
            }
            .listRowBackground(DeckColor.surface)

            if !store.team.users.isEmpty {
                Section {
                    ForEach(store.team.users) { user in
                        Button { renaming = user } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(store.name(for: user)).foregroundStyle(DeckColor.fg)
                                    if let email = user.emailAddress {
                                        Text(email).font(DeckFont.mono(11)).foregroundStyle(DeckColor.dim)
                                    }
                                }
                                Spacer()
                                Text("Rename").font(DeckFont.text(12)).foregroundStyle(DeckColor.accent)
                            }
                        }
                    }
                } header: {
                    Text("Accounts")
                } footer: {
                    Text("Names are kept on this iPhone and shown on the watch and widgets too.")
                }
                .listRowBackground(DeckColor.surface)
            }

            Section {
                Stepper(value: $store.settings.warn, in: DeckSettings.warnRange) {
                    labelled("Warn at", "\(store.settings.warn)%", color: DeckColor.warn)
                }
                .onChange(of: store.settings.warn) { _, warn in
                    if store.settings.critical <= warn {
                        store.settings.critical = warn + 1
                    }
                }
                Stepper(value: $store.settings.critical, in: (store.settings.warn + 1) ... DeckSettings.criticalMax) {
                    labelled("Critical at", "\(store.settings.critical)%", color: DeckColor.crit)
                }
            } header: {
                Text("Alerts")
            } footer: {
                Text("A limit alert fires once per window. It arrives when the iPhone gets background time or an app is open.")
            }
            .listRowBackground(DeckColor.surface)

            Section {
                Picker("Freeze a soft pause after", selection: $store.settings.escalationSeconds) {
                    ForEach(DeckSettings.escalationChoices, id: \.self) { choice in
                        Text(choice.map(escalationLabel) ?? "Never").tag(choice)
                    }
                }
            } header: {
                Text("Escalation")
            } footer: {
                Text(
                    "Only soft pauses started from this iPhone or its watch escalate, and only while one of them is awake; "
                        + "an overdue one fires on the next wake."
                )
            }
            .listRowBackground(DeckColor.surface)

            Section {
                Toggle("Quiet hours", isOn: $store.settings.quietHours)
                if store.settings.quietHours {
                    DatePicker("From", selection: minutes(\.quietStartMinutes), displayedComponents: .hourAndMinute)
                    DatePicker("To", selection: minutes(\.quietEndMinutes), displayedComponents: .hourAndMinute)
                }
            } footer: {
                Text("Alerts during quiet hours arrive silently in Notification Centre.")
            }
            .listRowBackground(DeckColor.surface)

            Section("Display") {
                Toggle("24-hour clock", isOn: $store.settings.use24h)
            }
            .listRowBackground(DeckColor.surface)

            Section("About") {
                HStack {
                    Text("Version")
                    Spacer()
                    Text(appVersion).font(DeckFont.mono(12)).foregroundStyle(DeckColor.muted)
                }
                Link("claude-usage on GitHub", destination: DeckLinks.project)
                    .foregroundStyle(DeckColor.accent)
            }
            .listRowBackground(DeckColor.surface)
        }
        .scrollContentBackground(.hidden)
        .background(DeckColor.bg)
        .tint(DeckColor.accent)
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(.inline)
        .renameAlert(store: store, user: $renaming)
    }

    private func labelled(_ label: String, _ value: String, color: Color) -> some View {
        HStack {
            Text(label)
            Spacer()
            Text(value).font(DeckFont.numeral(18, .medium)).foregroundStyle(color)
        }
    }

    private func escalationLabel(_ seconds: Int) -> String {
        seconds < 60 ? "\(seconds) s" : seconds % 60 == 0 ? "\(seconds / 60) min" : "\(seconds / 60) min \(seconds % 60) s"
    }

    /// Minutes after midnight as a `Date` today, for the hour-and-minute pickers.
    private func minutes(_ keyPath: WritableKeyPath<DeckSettings, Int>) -> Binding<Date> {
        Binding {
            Calendar.current.startOfDay(for: Date()).addingTimeInterval(TimeInterval(store.settings[keyPath: keyPath] * 60))
        } set: { date in
            let parts = Calendar.current.dateComponents([.hour, .minute], from: date)
            store.settings[keyPath: keyPath] = (parts.hour ?? 0) * 60 + (parts.minute ?? 0)
        }
    }

    private var appVersion: String {
        let info = Bundle.main.infoDictionary
        let short = info?["CFBundleShortVersionString"] as? String ?? "?"
        let build = info?["CFBundleVersion"] as? String ?? "?"
        return "\(short) (\(build))"
    }
}
