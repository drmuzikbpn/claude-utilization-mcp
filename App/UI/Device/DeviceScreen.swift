import SwiftUI
import UIKit
import UsageCore

/// Who a device is, whether this iPhone can reach it, what its setup still needs (each failing
/// row with the command that fixes it), and how to re-pair or remove it.
struct DeviceScreen: View {
    @Bindable var store: DeckStore
    var id: String
    @State private var confirmingRemove = false
    @State private var copied = 0

    var body: some View {
        let device = store.team.device(id)
        List {
            if let device {
                if let notice = RepairNotice(device) {
                    Section {
                        RepairCard(store: store, notice: notice)
                            .listRowInsets(EdgeInsets())
                            .listRowBackground(Color.clear)
                    }
                }
                Section("Device") {
                    field("name", device.displayName)
                    field("user", device.user?.emailAddress ?? device.user?.displayName ?? "unknown")
                    field("daemon version", device.version ?? "unknown")
                    field("status", "\(device.health) · \(Format.age(device.lastHeartbeatAt, now: store.now))")
                    field("connection", transport(device))
                    field("addresses", device.record.addrs.map { "\($0):\(device.record.port)" }.joined(separator: "\n"))
                    field("update", update(device.update))
                    if let error = device.lastError, !device.needsRepair {
                        field("last error", error)
                    }
                }
                setupSection
                Section {
                    Button("Re-pair") { store.beginPairing(replacing: id) }
                        .foregroundStyle(DeckColor.accent)
                    Button("Remove device", role: .destructive) { confirmingRemove = true }
                }
                .listRowBackground(DeckColor.surface)
            } else {
                Text("This device is no longer paired.")
                    .foregroundStyle(DeckColor.muted)
                    .listRowBackground(DeckColor.surface)
            }
        }
        .scrollContentBackground(.hidden)
        .deckScreen()
        .font(DeckFont.text(14))
        .navigationTitle(device.map { Format.hostShort($0.displayName) } ?? "Device")
        .navigationBarTitleDisplayMode(.inline)
        .sensoryFeedback(.success, trigger: copied)
        .task(id: id) {
            if store.setupChecks[id] == nil {
                await store.runSetupCheck(id)
            }
        }
        .confirmationDialog("Remove this device?", isPresented: $confirmingRemove, titleVisibility: .visible) {
            Button("Remove", role: .destructive) { store.remove(id) }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Its access token is deleted from this iPhone. Pair again with a fresh code to come back.")
        }
    }

    private var setupSection: some View {
        Section {
            if let check = store.setupChecks[id] {
                ForEach(check.items) { item in
                    SetupRow(item: item) { command in
                        UIPasteboard.general.string = command
                        copied += 1
                    }
                }
            } else {
                HStack {
                    ProgressView().controlSize(.small)
                    Text("Checking…").foregroundStyle(DeckColor.muted)
                }
            }
            Button {
                Task { await store.runSetupCheck(id) }
            } label: {
                HStack {
                    Text("Re-check")
                    if store.checking.contains(id) {
                        Spacer()
                        ProgressView().controlSize(.small)
                    }
                }
            }
            .foregroundStyle(DeckColor.accent)
            .disabled(store.checking.contains(id))
        } header: {
            Text("Setup")
        } footer: {
            if let check = store.setupChecks[id], check.allGood {
                Text("Everything this app needs is in place.")
            }
        }
        .listRowBackground(DeckColor.surface)
    }

    private func field(_ label: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(label)
                .font(DeckFont.text(12))
                .foregroundStyle(DeckColor.dim)
            Spacer(minLength: 12)
            Text(value)
                .font(DeckFont.mono(12))
                .foregroundStyle(DeckColor.fg)
                .multilineTextAlignment(.trailing)
                .textSelection(.enabled)
        }
        .listRowBackground(DeckColor.surface)
    }

    private func transport(_ device: DeviceState) -> String {
        let how = switch device.transport {
        case .sse: "live"
        case .polling: "polling"
        case .disconnected: "not connected"
        }
        guard let addr = device.activeAddr else { return how }
        return "\(how) · \(addr)"
    }

    /// The daemon defers its own updates while a session is frozen; saying so beats a state that looks stuck.
    private func update(_ update: UpdateState?) -> String {
        guard let update else { return "unknown" }
        let available = update.available.map { " → \($0)" } ?? ""
        let reason = switch (update.state, update.deferredReason) {
        case ("deferred", "frozen"): " (waiting on frozen session)"
        case let ("deferred", other): " (deferred: \(other ?? "unknown"))"
        default: ""
        }
        return "\(update.current)\(available) · \(update.state)\(reason)"
    }
}

private struct SetupRow: View {
    var item: SetupCheck.Item
    var onCopy: (String) -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: icon)
                .foregroundStyle(color)
                .font(.system(size: 16))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text(item.title)
                    .font(DeckFont.text(14))
                    .foregroundStyle(DeckColor.fg)
                if let fix = item.fix {
                    if isCommand(fix) {
                        HStack(spacing: 6) {
                            Text(fix)
                                .font(DeckFont.mono(12))
                                .foregroundStyle(DeckColor.fg)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 3)
                                .background(DeckColor.surface2, in: RoundedRectangle(cornerRadius: 5))
                                .textSelection(.enabled)
                            Button { onCopy(fix) } label: {
                                Image(systemName: "doc.on.doc")
                            }
                            .buttonStyle(.borderless)
                            .foregroundStyle(DeckColor.accent)
                            .accessibilityLabel("Copy \(fix)")
                        }
                    } else {
                        Text(fix)
                            .font(DeckFont.text(12))
                            .foregroundStyle(DeckColor.muted)
                    }
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(item.title): \(statusText)")
    }

    private func isCommand(_ fix: String) -> Bool {
        fix.hasPrefix("claude")
    }

    private var icon: String {
        switch item.status {
        case .ok: "checkmark.circle.fill"
        case .neutral: "minus.circle"
        case .failing: "xmark.circle.fill"
        }
    }

    private var color: Color {
        switch item.status {
        case .ok: DeckColor.ok
        case .neutral: DeckColor.muted
        case .failing: DeckColor.crit
        }
    }

    private var statusText: String {
        switch item.status {
        case .ok: "OK"
        case .neutral: "not yet"
        case .failing: "needs fixing"
        }
    }
}
