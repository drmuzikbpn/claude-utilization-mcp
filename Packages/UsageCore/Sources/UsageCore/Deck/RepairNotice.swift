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

    public var instruction: String {
        "On \(name), run `claude-usage pair`, then tap Re-pair and scan its code."
    }
}
