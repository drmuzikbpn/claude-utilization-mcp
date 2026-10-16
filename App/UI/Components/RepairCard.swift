// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

import SwiftUI
import UsageCore

/// "<name> no longer accepts this iPhone": why (token changed / certificate changed), what to run
/// on the device, and a Re-pair button that opens pairing in re-pair mode for that device, so the
/// record (id, renames, settings) is kept and only its token and pin are replaced.
struct RepairCard: View {
    @Bindable var store: DeckStore
    var notice: RepairNotice
    var compact = false

    var body: some View {
        VStack(alignment: .leading, spacing: compact ? 6 : 8) {
            Label {
                Text(notice.title)
                    .font(DeckFont.text(compact ? 13 : 14, .semibold))
                    .foregroundStyle(DeckColor.fg)
                    .fixedSize(horizontal: false, vertical: true)
            } icon: {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(DeckColor.warn)
            }
            Text(notice.reason)
                .font(DeckFont.text(12))
                .foregroundStyle(DeckColor.fg.opacity(0.8))
            Text(notice.instruction)
                .font(DeckFont.text(12))
                .foregroundStyle(DeckColor.fg.opacity(0.8))
                .fixedSize(horizontal: false, vertical: true)
            Button("Re-pair") { store.beginPairing(replacing: notice.id) }
                .font(DeckFont.text(14, .semibold))
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.capsule)
                .tint(DeckColor.accent)
                .accessibilityLabel(Text(verbatim: "Re-pair \(notice.name)"))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(compact ? 12 : 14)
        .deckGlass(in: RoundedRectangle(cornerRadius: 18, style: .continuous), tint: DeckColor.warn)
        .accessibilityElement(children: .contain)
    }
}

/// One `RepairCard` per device that has lost its pairing; nothing when none has.
/// "Demo": the devices on screen are made up. Stays until it is left here, in Settings or by
/// pairing a real device.
struct DemoBanner: View {
    @Bindable var store: DeckStore
    var compact = false

    var body: some View {
        if store.isDemo {
            HStack(spacing: 10) {
                Image(systemName: "sparkles").foregroundStyle(DeckColor.accent).accessibilityHidden(true)
                Text("Demo · made-up devices and sessions")
                    .font(DeckFont.text(compact ? 12 : 13, .medium))
                    .foregroundStyle(DeckColor.fg)
                Spacer(minLength: 8)
                Button("Leave") { store.endDemo() }
                    .font(DeckFont.text(compact ? 12 : 13, .semibold))
                    .foregroundStyle(DeckColor.accent)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, compact ? 6 : 10)
            .deckCard(radius: 14)
            .padding(.horizontal, compact ? 8 : 10)
            .padding(.vertical, 4)
            .transition(.opacity)
        }
    }
}

struct RepairBanners: View {
    @Bindable var store: DeckStore
    var compact = false

    var body: some View {
        let notices = RepairNotice.all(store.team)
        if !notices.isEmpty {
            VStack(spacing: 8) {
                ForEach(notices) { notice in
                    RepairCard(store: store, notice: notice, compact: compact)
                }
            }
            .padding(.horizontal, compact ? 8 : 10)
            .padding(.vertical, 4)
            .transition(.opacity)
        }
    }
}
