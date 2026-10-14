// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

import Foundation

/// What the app says about a device that no longer accepts this iPhone, and how to fix it. The
/// home banners, the device screen and the alert all read it, so they never disagree.
public struct RepairNotice: Sendable, Equatable, Identifiable {
    public var id: String
    /// The device's short name (`studio`, not `studio.local`).
    public var name: String
    public var cause: RepairReason

    public init?(_ device: DeviceState) {
        guard let cause = device.repairReason else { return nil }
        id = device.id
        name = Format.hostShort(device.displayName)
        self.cause = cause
    }

    public static func all(_ team: TeamState) -> [RepairNotice] {
        team.devices.compactMap(RepairNotice.init)
    }

    public var title: String {
        "\(name) no longer accepts this iPhone"
    }

    public var reason: String {
        switch cause {
        case .tokenRejected: "Its access token was changed."
        case .certificateChanged: "Its certificate changed."
        }
    }

    /// The notification: posted once by `RepairLedger`; tapping it opens Re-pair for `id`.
    public var alert: Alert {
        Alert(kind: .repair, key: "\(AlertKind.repair.rawValue)|\(id)", title: "Re-pair \(name)", body: "\(title). \(reason)")
    }

    /// The device's name is the device's to choose, so it is never drawn as Markdown.
    public var instruction: DeckText {
        .literal("On ") + .untrusted(name) + .literal(", run `claude-usage pair`, then tap Re-pair and scan its code.")
    }
}

/// How a scanned invite compares with the device being re-paired.
///
/// `sameDevice` is only a guess at which device the code is from (a shared short name or address
/// counts, since a regenerated certificate is one reason to re-pair). A name and an address are
/// whatever the invite claims, so they never vouch for a certificate: `certificateDiffers` alone
/// decides whether the confirmation warns that the pin is about to change.
public enum RepairMatch {
    public static func certificateDiffers(_ record: DeviceRecord, _ invite: PairingInvite) -> Bool {
        record.fingerprint.lowercased() != invite.fingerprint.lowercased()
    }

    public static func sameDevice(_ record: DeviceRecord, _ invite: PairingInvite) -> Bool {
        if record.fingerprint == invite.fingerprint {
            return true
        }
        if Format.hostShort(record.name).lowercased() == Format.hostShort(invite.name).lowercased() {
            return true
        }
        return !Set(record.addrs.map { $0.lowercased() }).isDisjoint(with: invite.addrs.map { $0.lowercased() })
    }
}
