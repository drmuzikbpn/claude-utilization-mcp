import Foundation
import Synchronization
@testable import UsageCore

/// Reads fixtures copied verbatim from the Android deck (themselves copies of the daemon repo's
/// `test/fixtures/`), plus the pinning certificate generated for this repo.
enum Fixtures {
    static func url(_ name: String) -> URL {
        guard let url = Bundle.module.url(forResource: name, withExtension: nil, subdirectory: "Fixtures") else {
            fatalError("missing fixture \(name)")
        }
        return url
    }

    static func data(_ name: String) -> Data {
        (try? Data(contentsOf: url(name))) ?? Data()
    }

    static func text(_ name: String) -> String {
        String(decoding: data(name), as: UTF8.self)
    }

    private static func errorCase(_ name: String, _ file: String) -> [String: Any] {
        let all = (try? JSONSerialization.jsonObject(with: data(file))) as? [String: Any]
        return all?[name] as? [String: Any] ?? [:]
    }

    /// One named case out of `errors.json`, as the raw response body the daemon would send.
    static func errorBody(_ name: String, file: String = "errors.json") -> Data {
        (try? JSONSerialization.data(withJSONObject: errorCase(name, file)["body"] ?? [:])) ?? Data()
    }

    static func errorStatus(_ name: String, file: String = "errors.json") -> Int {
        errorCase(name, file)["status"] as? Int ?? 0
    }

    static func decode<T: Decodable>(_ type: T.Type, _ name: String) throws -> T {
        try JSONDecoder().decode(type, from: data(name))
    }
}

func date(_ iso: String) -> Date {
    ISODate.parse(iso) ?? .distantPast
}

/// A `URLProtocol` stub. Each test registers a handler under its own unique host, so suites can
/// run in parallel without seeing each other's traffic.
final class StubURLProtocol: URLProtocol, @unchecked Sendable {
    struct Response: Sendable {
        var status: Int = 200
        var headers: [String: String] = [:]
        var body: Data = .init()
    }

    enum Outcome: Sendable {
        case respond(Response)
        case fail(URLError.Code)
    }

    typealias Handler = @Sendable (URLRequest) -> Outcome

    private static let handlers = Mutex<[String: Handler]>([:])
    private static let requests = Mutex<[String: [URLRequest]]>([:])

    static func register(host: String, _ handler: @escaping Handler) {
        handlers.withLock { $0[host] = handler }
    }

    static func recorded(host: String) -> [URLRequest] {
        requests.withLock { $0[host] ?? [] }
    }

    static func session() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        return URLSession(configuration: configuration)
    }

    override static func canInit(with _: URLRequest) -> Bool {
        true
    }

    override static func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        let host = request.url?.host() ?? ""
        var recorded = request
        if recorded.httpBody == nil, let stream = request.httpBodyStream {
            recorded.httpBody = Self.read(stream)
        }
        Self.requests.withLock { $0[host, default: []].append(recorded) }
        guard let handler = Self.handlers.withLock({ $0[host] }) else {
            client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost))
            return
        }
        switch handler(recorded) {
        case let .fail(code):
            client?.urlProtocol(self, didFailWithError: URLError(code))
        case let .respond(response):
            let http = HTTPURLResponse(
                url: request.url ?? URL(fileURLWithPath: "/"),
                statusCode: response.status,
                httpVersion: "HTTP/1.1",
                headerFields: response.headers
            )
            if let http {
                client?.urlProtocol(self, didReceive: http, cacheStoragePolicy: .notAllowed)
            }
            client?.urlProtocol(self, didLoad: response.body)
            client?.urlProtocolDidFinishLoading(self)
        }
    }

    override func stopLoading() {}

    private static func read(_ stream: InputStream) -> Data {
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count <= 0 {
                break
            }
            data.append(buffer, count: count)
        }
        return data
    }
}

/// A unique host per test.
func uniqueHost(_ label: String = "t") -> String {
    "\(label)-\(UUID().uuidString.prefix(8).lowercased()).test"
}

func record(id: String = "d1", name: String = "studio", addrs: [String], port: Int = 47292) -> DeviceRecord {
    DeviceRecord(id: id, name: name, addrs: addrs, port: port, fingerprint: String(repeating: "a", count: 64))
}

// MARK: - model builders shared by the model, alert and pause tests

let t0 = date("2026-09-13T14:00:00Z")

func limit(
    _ id: String,
    _ percent: Int,
    resetsAt: Date? = nil,
    kind: String? = nil,
    model: String? = nil
) -> Limit {
    Limit(
        id: id,
        kind: kind ?? id,
        group: id == "session" ? "session" : "weekly",
        percent: percent,
        severity: "normal",
        resetsAt: resetsAt,
        scopeModel: model,
        isActive: false,
        status: .ok
    )
}

func session(
    _ id: String,
    cwd: String = "/g",
    projectKey: String = "/g/.git",
    projectName: String = "g",
    worktree: String? = nil,
    tokens: Tokens = .zero,
    alive: Bool = true,
    discovered: Discovered = .hook,
    pid: Int? = 42,
    pause: PauseState? = nil
) -> Session {
    Session(
        sessionId: id,
        pid: pid,
        alive: alive,
        discovered: discovered,
        cwd: cwd,
        transcriptPath: nil,
        projectKey: projectKey,
        projectName: projectName,
        worktree: worktree,
        model: "claude-opus-5",
        startedAt: t0,
        lastActivityAt: t0,
        tokens: tokens,
        pause: pause,
        lastTool: nil
    )
}

func device(
    _ id: String,
    user: User? = nil,
    health: Health = .fresh,
    limits: [Limit] = [],
    limitsFetchedAt: Date? = nil,
    sessions: [Session] = [],
    rules: [PauseRule] = [],
    today: Tokens = .zero,
    projectTokens: [ProjectTokens] = []
) -> DeviceState {
    var state = DeviceState(record: DeviceRecord(id: id, name: id, addrs: ["192.168.1.20"], port: 47292, fingerprint: ""))
    state.health = health
    state.lastHeartbeatAt = t0
    state.name = id
    state.user = user
    state.limits = limits
    state.limitsFetchedAt = limitsFetchedAt
    state.sessions = sessions
    state.rules = rules
    state.today = today
    state.projectTokens = projectTokens
    return state
}

let alan = User(emailAddress: "alan@example.com", accountUuid: "uuid-alan", displayName: "Alan")
let jamie = User(emailAddress: "jamie@example.com", accountUuid: "uuid-jamie", displayName: "Jamie")
