import Foundation

/// One decoded frame of the daemon's `GET /v1/events` stream.
public enum DaemonEvent: Sendable, Equatable {
    public struct Snapshot: Sendable, Equatable {
        public var name: String?
        public var version: String?
        public var user: UserDTO?
        public var limits: [LimitDTO]
        public var status: StatusDTO
        public var thresholds: ThresholdsDTO
        public var today: TokensCountsDTO
        public var sessions: [SessionDTO]
        public var rules: [PauseRuleDTO]
        public var update: UpdateDTO?
        public var rev: Int64
        /// When the *daemon* last read the account's usage, not when this phone received it.
        public var fetchedAt: String?
        /// `/health.install` riding along in the snapshot (contract v2); nil on older daemons.
        public var install: InstallDTO?
    }

    case snapshot(Snapshot)
    /// The `/v1/limits` body minus `raw`. It carries no status map: the client keeps the last
    /// one a snapshot gave it and falls back to thresholds for ids it has never seen.
    case limits([LimitDTO], fetchedAt: String?, stale: Bool)
    /// Device-wide spend. `today` is cumulative and authoritative; `delta` is per-event (the sum
    /// inside the daemon's 1 s coalesce window), so burn rates come from `today`, never `delta`.
    case spend(today: TokensCountsDTO, delta: TokensCountsDTO)
    /// `type` is one of `start`, `end`, `update`.
    case session(type: String, session: SessionDTO)
    case pause(rules: [PauseRuleDTO], affected: [String])
    case update(UpdateDTO)
    /// Both fields are advisory; the client ages devices off its own clock.
    case heartbeat(rev: Int64, at: String?)
    case unknown(String)

    public static let emptyHeartbeat = DaemonEvent.heartbeat(rev: 0, at: nil)
}

/// `snapshot` payload. `summary` is the `/v1/summary` body, `limits` the `/v1/limits` body
/// minus `raw`, and `sessions` the §17.3 session objects as a bare array.
private struct SnapshotDTO: Decodable {
    var name: String?
    var version: String?
    var user: UserDTO?
    var summary: SummaryDTO
    var limits: LimitsBodyDTO
    var sessions: [SessionDTO]
    var rules: [PauseRuleDTO]
    var update: UpdateDTO?
    var rev: Int64
    var health: HealthDTO?
    var install: InstallDTO?

    enum CodingKeys: String, CodingKey {
        case name, version, user, summary, limits, sessions, rules, update, rev, health, install
    }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = c.optional(.name)
        version = c.optional(.version)
        user = c.optional(.user)
        summary = try c.decodeIfPresent(SummaryDTO.self, forKey: .summary) ?? SummaryDTO()
        limits = try c.decodeIfPresent(LimitsBodyDTO.self, forKey: .limits) ?? LimitsBodyDTO()
        sessions = try c.decodeIfPresent([SessionDTO].self, forKey: .sessions) ?? []
        // Either the `/v1/pause/rules` body or a bare array of rules; both are accepted.
        if let array = try? c.decodeIfPresent([PauseRuleDTO].self, forKey: .rules) {
            rules = array
        } else {
            rules = try c.decodeIfPresent(RulesDTO.self, forKey: .rules)?.rules ?? []
        }
        update = c.optional(.update)
        rev = c.value(.rev, or: 0)
        health = c.optional(.health)
        install = c.optional(.install)
    }
}

private struct HeartbeatDTO: Decodable {
    var rev: Int64
    var at: String?

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        rev = c.value(.rev, or: 0)
        at = c.optional(.at)
    }

    enum CodingKeys: String, CodingKey { case rev, at }
}

private struct SpendEventDTO: Decodable {
    var today: TokensCountsDTO
    var delta: TokensCountsDTO

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        today = c.value(.today, or: TokensCountsDTO())
        delta = c.value(.delta, or: TokensCountsDTO())
    }

    enum CodingKeys: String, CodingKey { case today, delta }
}

private struct SessionEventDTO: Decodable {
    var type: String
    var session: SessionDTO

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        type = c.value(.type, or: "update")
        session = try c.decode(SessionDTO.self, forKey: .session)
    }

    enum CodingKeys: String, CodingKey { case type, session }
}

private struct PauseEventDTO: Decodable {
    var rules: [PauseRuleDTO]
    var affected: [String]

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        rules = try c.decodeIfPresent([PauseRuleDTO].self, forKey: .rules) ?? []
        affected = c.value(.affected, or: [])
    }

    enum CodingKeys: String, CodingKey { case rules, affected }
}

/// Decodes a raw `(event, data)` SSE pair. Never throws: malformed payloads become `.unknown`.
public enum SSEDecoder {
    public static func decode(event: String?, data: String) -> DaemonEvent {
        let name = event ?? ""
        let bytes = Data(data.utf8)
        let decoder = JSONDecoder()
        do {
            switch name {
            case "heartbeat":
                if data.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    return .emptyHeartbeat
                }
                let dto = try decoder.decode(HeartbeatDTO.self, from: bytes)
                return .heartbeat(rev: dto.rev, at: dto.at)
            case "snapshot":
                return try .snapshot(snapshot(decoder.decode(SnapshotDTO.self, from: bytes)))
            case "limits":
                let dto = try decoder.decode(LimitsBodyDTO.self, from: bytes)
                return .limits(dto.limits, fetchedAt: dto.fetchedAt, stale: dto.stale)
            case "spend":
                let dto = try decoder.decode(SpendEventDTO.self, from: bytes)
                return .spend(today: dto.today, delta: dto.delta)
            case "session":
                let dto = try decoder.decode(SessionEventDTO.self, from: bytes)
                return .session(type: dto.type, session: dto.session)
            case "pause":
                let dto = try decoder.decode(PauseEventDTO.self, from: bytes)
                return .pause(rules: dto.rules, affected: dto.affected)
            case "update":
                return try .update(decoder.decode(UpdateDTO.self, from: bytes))
            default:
                return .unknown(name)
            }
        } catch {
            return name == "heartbeat" ? .emptyHeartbeat : .unknown(name)
        }
    }

    private static func snapshot(_ dto: SnapshotDTO) -> DaemonEvent.Snapshot {
        DaemonEvent.Snapshot(
            name: dto.name,
            version: dto.version,
            user: dto.user,
            limits: dto.summary.limits.limits.isEmpty ? dto.limits.limits : dto.summary.limits.limits,
            status: dto.summary.status,
            thresholds: dto.summary.thresholds,
            today: dto.summary.today,
            sessions: dto.sessions,
            rules: dto.rules,
            update: dto.update,
            rev: dto.rev,
            fetchedAt: dto.summary.fetchedAt ?? dto.limits.fetchedAt,
            install: dto.install ?? dto.health?.install
        )
    }
}
