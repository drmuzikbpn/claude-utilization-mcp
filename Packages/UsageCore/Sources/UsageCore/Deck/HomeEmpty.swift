import Foundation

/// What the home screens show instead of an empty list. Decided once so portrait and landscape agree.
public enum HomeEmpty: Sendable, Equatable {
    /// Nothing paired: the only useful action is pairing.
    case noDevices
    /// Paired, but no device has delivered anything yet.
    case connecting
    /// Data is flowing; nothing is running.
    case noSessions(deviceNames: [String])

    public static func of(_ team: TeamState) -> HomeEmpty? {
        if team.devices.isEmpty {
            return .noDevices
        }
        if !team.devices.contains(where: \.hasSnapshot) {
            return .connecting
        }
        if team.liveSessionCount == 0 {
            return .noSessions(deviceNames: team.devices.map(\.displayName))
        }
        return nil
    }
}

public extension DeviceState {
    /// A device has "arrived" once anything it reports is in hand; before that its user block
    /// would be all dashes.
    var hasSnapshot: Bool {
        user != nil || !limits.isEmpty || !sessions.isEmpty || lastHeartbeatAt != nil
    }
}

public extension TeamState {
    /// The accounts worth a block: those behind at least one device that has arrived.
    var usersWithData: [UserView] {
        users.filter { user in user.deviceIds.contains { device($0)?.hasSnapshot == true } }
    }
}

/// The project drill-in's arithmetic (deck spec §11.3).
public enum ProjectMath {
    /// Project tokens today as a share of its device's tokens today; `—` rather than a
    /// divide-by-zero fiction when the device has reported nothing.
    public static func share(projectToday: Int64, deviceToday: Int64) -> String {
        guard deviceToday > 0 else { return "—" }
        return "\(Int((Double(projectToday) * 100 / Double(deviceToday)).rounded()))%"
    }

    /// Cache reads and writes as a whole percentage of all tokens.
    public static func cacheShare(_ tokens: Tokens) -> Int64 {
        tokens.total == 0 ? 0 : (tokens.cacheRead + tokens.cacheCreate) * 100 / tokens.total
    }

    /// `38 210 → 40 000`, so the chart's top gridline reads as a round number.
    public static func oneSigFig(_ value: Double) -> Int64 {
        guard value > 0 else { return 0 }
        let magnitude = pow(10, floor(log10(value)))
        return Int64(((value / magnitude).rounded() * magnitude).rounded())
    }
}
