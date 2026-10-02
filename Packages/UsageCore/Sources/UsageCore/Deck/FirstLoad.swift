import Foundation

/// Whether a freshly paired device has delivered enough for its screen to open fully populated,
/// rather than on rows of "unknown". The phone shows "Connecting to <name>…" until this says
/// `ready`, and never longer than `timeout`.
public enum FirstLoad {
    public enum Phase: Sendable, Equatable {
        case loading
        /// `/health` (the setup check) and a summary or snapshot are both in.
        case ready
        /// Stop waiting and open the device anyway, saying why.
        case failed(String)
    }

    public static let timeout: TimeInterval = 12

    /// `settled` is true once the store's bootstrap pass (one REST refresh, then the setup check)
    /// has finished; after that, anything still missing is not on its way.
    public static func phase(state: DeviceState?, check: SetupCheck?, settled: Bool, elapsed: TimeInterval) -> Phase {
        guard let state else {
            return elapsed >= timeout ? .failed(DaemonError.network.userMessage) : .loading
        }
        if state.needsRepair {
            return .failed(state.lastError ?? DaemonError(code: "unauthorized").userMessage)
        }
        if let check, check.items.contains(where: { $0.id == "reachable" && $0.status == .failing }) {
            return .failed(state.lastError ?? DaemonError.network.userMessage)
        }
        if check != nil, state.summaryLoaded {
            return .ready
        }
        if settled || elapsed >= timeout {
            return .failed(state.lastError ?? slow(state.displayName))
        }
        return .loading
    }

    /// Nothing went wrong that the daemon could name; it is just not all here yet.
    public static func slow(_ name: String) -> String {
        "\(name) is taking a while to answer. Showing what has arrived so far."
    }
}
