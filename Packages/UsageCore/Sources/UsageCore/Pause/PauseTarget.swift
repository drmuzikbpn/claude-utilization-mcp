import Foundation

/// What a pause gesture acts on. Session and project scopes address exactly one device; only
/// `.all` fans out.
public enum PauseTarget: Codable, Sendable, Hashable {
    case session(deviceId: String, sessionId: String)
    case project(deviceId: String, projectKey: String)
    case all

    /// The daemon's scope grammar (daemon spec §18.1).
    public var scope: String {
        switch self {
        case let .session(_, sessionId): "session:\(sessionId)"
        case let .project(_, projectKey): "project:\(projectKey)"
        case .all: "all"
        }
    }

    /// The one device a session or project scope belongs to; nil for `.all`.
    public var deviceId: String? {
        switch self {
        case let .session(deviceId, _), let .project(deviceId, _): deviceId
        case .all: nil
        }
    }
}
