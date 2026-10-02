import Foundation

/// Everything about a paired device except its bearer token. Safe to persist outside the
/// Keychain and safe to show; never safe to send to the watch together with a token.
public struct DeviceRecord: Codable, Sendable, Equatable, Hashable, Identifiable {
    public var id: String
    public var name: String
    /// Candidate host names or IPv4 literals, tried in order (LAN IP, `<host>.local`, tailnet IP).
    public var addrs: [String]
    /// The HTTPS listener's port (`config.tls.port`).
    public var port: Int
    /// Lowercase hex SHA-256 of the daemon certificate's SubjectPublicKeyInfo.
    public var fingerprint: String

    public init(id: String, name: String, addrs: [String], port: Int, fingerprint: String) {
        self.id = id
        self.name = name
        self.addrs = addrs
        self.port = port
        self.fingerprint = fingerprint
    }

    /// `https://<addr>:<port>` for every candidate, in order. IPv6 literals are bracketed.
    public var baseURLs: [URL] {
        addrs.compactMap { addr in
            let host = addr.contains(":") ? "[\(addr)]" : addr
            return URL(string: "https://\(host):\(port)")
        }
    }
}

/// A device plus the bearer token that unlocks it. Lives only on the iPhone.
///
/// The token is deliberately left out of every textual and reflected form so that a stray
/// `print`, `dump` or log interpolation can never leak it.
public struct DeviceConfig: Sendable, Equatable {
    public var record: DeviceRecord
    public var token: String

    public init(record: DeviceRecord, token: String) {
        self.record = record
        self.token = token
    }

    public var id: String {
        record.id
    }

    public var name: String {
        record.name
    }
}

extension DeviceConfig: CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
    public var description: String {
        "DeviceConfig(id: \(record.id), name: \(record.name), token: <redacted>)"
    }

    public var debugDescription: String {
        description
    }

    public var customMirror: Mirror {
        Mirror(self, children: ["record": record])
    }
}

public enum Health: Int, Codable, Sendable, Comparable, CaseIterable {
    case fresh
    case stale
    case dead

    public static func < (lhs: Health, rhs: Health) -> Bool {
        lhs.rawValue < rhs.rawValue
    }
}

public struct User: Codable, Sendable, Equatable, Hashable {
    public var emailAddress: String?
    public var accountUuid: String?
    public var displayName: String?
    /// Team-plan limits are per organisation, so one account in two orgs is two quotas.
    public var organizationUuid: String?
    public var organizationName: String?

    public init(
        emailAddress: String?,
        accountUuid: String?,
        displayName: String?,
        organizationUuid: String? = nil,
        organizationName: String? = nil
    ) {
        self.emailAddress = emailAddress
        self.accountUuid = accountUuid
        self.displayName = displayName
        self.organizationUuid = organizationUuid
        self.organizationName = organizationName
    }
}

public enum LimitStatus: String, Codable, Sendable, Comparable {
    case ok
    case warn
    case critical

    private var rank: Int {
        switch self {
        case .ok: 0
        case .warn: 1
        case .critical: 2
        }
    }

    public static func < (lhs: LimitStatus, rhs: LimitStatus) -> Bool {
        lhs.rank < rhs.rank
    }
}

public enum LimitID {
    /// The 5-hour window.
    public static let session = "session"
    /// The 7-day all-models window.
    public static let weeklyAll = "weekly_all"
    public static let weeklyScopedKind = "weekly_scoped"
}

public struct Limit: Codable, Sendable, Equatable, Hashable {
    public var id: String
    public var kind: String
    public var group: String
    public var percent: Int
    public var severity: String
    /// May be null on the wire; render "resets: unknown".
    public var resetsAt: Date?
    public var scopeModel: String?
    public var isActive: Bool
    public var status: LimitStatus

    public init(
        id: String,
        kind: String,
        group: String,
        percent: Int,
        severity: String,
        resetsAt: Date?,
        scopeModel: String?,
        isActive: Bool,
        status: LimitStatus
    ) {
        self.id = id
        self.kind = kind
        self.group = group
        self.percent = percent
        self.severity = severity
        self.resetsAt = resetsAt
        self.scopeModel = scopeModel
        self.isActive = isActive
        self.status = status
    }
}

public struct Tokens: Codable, Sendable, Equatable, Hashable {
    public var input: Int64
    public var output: Int64
    public var cacheCreate: Int64
    public var cacheRead: Int64
    public var messages: Int64

    public init(input: Int64 = 0, output: Int64 = 0, cacheCreate: Int64 = 0, cacheRead: Int64 = 0, messages: Int64 = 0) {
        self.input = input
        self.output = output
        self.cacheCreate = cacheCreate
        self.cacheRead = cacheRead
        self.messages = messages
    }

    public static let zero = Tokens()

    /// The four counters; `messages` is a count of turns, not tokens.
    public var total: Int64 {
        input + output + cacheCreate + cacheRead
    }

    public static func + (lhs: Tokens, rhs: Tokens) -> Tokens {
        Tokens(
            input: lhs.input + rhs.input,
            output: lhs.output + rhs.output,
            cacheCreate: lhs.cacheCreate + rhs.cacheCreate,
            cacheRead: lhs.cacheRead + rhs.cacheRead,
            messages: lhs.messages + rhs.messages
        )
    }
}

public enum PauseMode: String, Codable, Sendable, Comparable {
    case soft
    case hard

    public static func < (lhs: PauseMode, rhs: PauseMode) -> Bool {
        lhs == .soft && rhs == .hard
    }
}

public struct PauseState: Codable, Sendable, Equatable, Hashable {
    public var mode: PauseMode
    public var ruleId: String
    public var scope: String
    public var since: Date
    /// Stopped tool subprocesses (daemon §23.16). Empty under a hard rule means "held at the gate", not a failure.
    public var frozenPids: [Int]
    /// 0 under soft; 1 frozen once; 2+ frozen again under the same standing rule.
    public var freezes: Int

    public init(mode: PauseMode, ruleId: String, scope: String, since: Date, frozenPids: [Int], freezes: Int = 0) {
        self.mode = mode
        self.ruleId = ruleId
        self.scope = scope
        self.since = since
        self.frozenPids = frozenPids
        self.freezes = freezes
    }
}

public struct LastTool: Codable, Sendable, Equatable, Hashable {
    public var name: String
    public var at: Date

    public init(name: String, at: Date) {
        self.name = name
        self.at = at
    }
}

public enum Discovered: String, Codable, Sendable {
    case hook
    case transcript
}

public struct Session: Codable, Sendable, Equatable, Hashable, Identifiable {
    public var sessionId: String
    public var pid: Int?
    public var alive: Bool
    public var discovered: Discovered
    public var cwd: String
    public var transcriptPath: String?
    public var projectKey: String
    public var projectName: String
    public var worktree: String?
    public var model: String?
    public var startedAt: Date
    public var lastActivityAt: Date
    public var tokens: Tokens
    public var pause: PauseState?
    public var lastTool: LastTool?
    /// The `/rename` title Claude Code stores next to the transcript; nil when never renamed.
    public var title: String?

    public init(
        sessionId: String,
        pid: Int?,
        alive: Bool,
        discovered: Discovered,
        cwd: String,
        transcriptPath: String?,
        projectKey: String,
        projectName: String,
        worktree: String?,
        model: String?,
        startedAt: Date,
        lastActivityAt: Date,
        tokens: Tokens,
        pause: PauseState?,
        lastTool: LastTool?,
        title: String? = nil
    ) {
        self.sessionId = sessionId
        self.pid = pid
        self.alive = alive
        self.discovered = discovered
        self.cwd = cwd
        self.transcriptPath = transcriptPath
        self.projectKey = projectKey
        self.projectName = projectName
        self.worktree = worktree
        self.model = model
        self.startedAt = startedAt
        self.lastActivityAt = lastActivityAt
        self.tokens = tokens
        self.pause = pause
        self.lastTool = lastTool
        self.title = title
    }

    public var id: String {
        sessionId
    }

    /// A hard freeze needs a pid the SessionStart hook registered; transcript back-fill has none.
    public var canHardPause: Bool {
        discovered == .hook && pid != nil
    }
}

public struct PauseRule: Codable, Sendable, Equatable, Hashable {
    public var id: String
    public var scope: String
    public var mode: PauseMode
    public var reason: String?
    public var createdAt: Date
    public var createdBy: String

    public init(id: String, scope: String, mode: PauseMode, reason: String?, createdAt: Date, createdBy: String) {
        self.id = id
        self.scope = scope
        self.mode = mode
        self.reason = reason
        self.createdAt = createdAt
        self.createdBy = createdBy
    }
}

public struct UpdateState: Codable, Sendable, Equatable {
    public var channel: String
    public var current: String
    public var available: String?
    public var state: String
    public var deferredReason: String?

    public init(channel: String, current: String, available: String?, state: String, deferredReason: String?) {
        self.channel = channel
        self.current = current
        self.available = available
        self.state = state
        self.deferredReason = deferredReason
    }
}

public struct ProjectTokens: Codable, Sendable, Equatable {
    public var key: String
    /// The session cwd the daemon grouped by.
    public var label: String
    public var tokens: Tokens

    public init(key: String, label: String, tokens: Tokens) {
        self.key = key
        self.label = label
        self.tokens = tokens
    }
}

/// One paired device's live state, as `DeviceClient` maintains it.
/// Why a paired device no longer accepts this iPhone.
public enum RepairReason: String, Sendable, Equatable, Codable {
    /// 401: its bearer token was rotated (or this pairing was revoked).
    case tokenRejected
    /// Its TLS certificate no longer hashes to the paired fingerprint (regenerated).
    case certificateChanged
}

public struct DeviceState: Sendable, Equatable {
    public enum Transport: String, Sendable, Codable {
        case sse
        case polling
        case disconnected
    }

    public var record: DeviceRecord
    public var health: Health = .dead
    public var lastHeartbeatAt: Date?
    public var name: String?
    public var version: String?
    public var user: User?
    public var limits: [Limit] = []
    /// When the *daemon* last read the account's usage, never when this phone received it.
    public var limitsFetchedAt: Date?
    public var today: Tokens = .zero
    public var sessions: [Session] = []
    public var rules: [PauseRule] = []
    public var update: UpdateState?
    public var projectTokens: [ProjectTokens] = []
    public var rev: Int64 = 0
    /// A stream snapshot or a `/v1/summary` has landed: limits and spend are this device's
    /// answer, not the empty defaults (which may be the answer too, on a fresh install).
    public var summaryLoaded = false
    public var lastError: String?
    /// Why the device stopped accepting this iPhone, when it has: re-pairing, not a retry, fixes it.
    public var repairReason: RepairReason?
    public var transport: Transport = .disconnected
    /// The candidate address that answered last, if any.
    public var activeAddr: String?

    public init(record: DeviceRecord) {
        self.record = record
    }

    public var id: String {
        record.id
    }

    /// The device rejected the token (401) or its certificate no longer matches the pin.
    /// Setting it without a reason means a rejected token.
    public var needsRepair: Bool {
        get { repairReason != nil }
        set { repairReason = newValue ? (repairReason ?? .tokenRejected) : nil }
    }

    /// The daemon's own name for itself, else the name it was paired under.
    public var displayName: String {
        name ?? record.name
    }
}
