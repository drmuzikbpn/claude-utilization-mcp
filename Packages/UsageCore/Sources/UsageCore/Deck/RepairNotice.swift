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

    public var instruction: String {
        "On \(name), run `claude-usage pair`, then tap Re-pair and scan its code."
    }
}

/// Whether a scanned invite is plausibly the device being re-paired. The fingerprint alone cannot
/// say (a regenerated certificate is exactly why it differs), so a shared short name or a shared
/// address counts too.
public enum RepairMatch {
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
