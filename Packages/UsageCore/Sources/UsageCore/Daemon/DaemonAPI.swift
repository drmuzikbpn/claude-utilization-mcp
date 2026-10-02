import Foundation

public enum SessionsResult: Sendable, Equatable {
    case changed(SessionsDTO, etag: String?)
    case unchanged
}

/// The daemon's REST surface. Every method throws `DaemonError` (or `CancellationError`).
public protocol DaemonAPI: Sendable {
    func health() async throws -> HealthDTO
    func summary() async throws -> SummaryDTO
    /// `GET /v1/sessions`, conditional on `ifNoneMatch` (the daemon's weak ETag `W/"<rev>"`).
    func sessions(ifNoneMatch: String?) async throws -> SessionsResult
    /// `GET /v1/tokens?since=today&groupBy=project` — the spend endpoint (never `/v1/spend`).
    func tokensByProjectToday() async throws -> TokensDTO
    func pause(scope: String, mode: PauseMode, reason: String) async throws -> PauseResponseDTO
    func resume(scope: String) async throws -> ResumeResponseDTO
    func rules() async throws -> RulesDTO
}

/// `DaemonAPI` over a pinned `URLSession`, trying each of the device's candidate addresses.
public final class URLSessionDaemonAPI: DaemonAPI {
    public static let requestTimeout: TimeInterval = 6

    private let token: String
    private let session: URLSession
    public let endpoints: Endpoints

    public init(config: DeviceConfig, session: URLSession, endpoints: Endpoints? = nil) {
        token = config.token
        self.session = session
        self.endpoints = endpoints ?? Endpoints(record: config.record)
    }

    public func health() async throws -> HealthDTO {
        try await decode(send(get("/health")).0)
    }

    public func summary() async throws -> SummaryDTO {
        try await decode(send(get("/v1/summary")).0)
    }

    public func sessions(ifNoneMatch: String?) async throws -> SessionsResult {
        let (data, response) = try await send(get("/v1/sessions")) { request in
            if let ifNoneMatch {
                request.setValue(ifNoneMatch, forHTTPHeaderField: "If-None-Match")
            }
        }
        if response.statusCode == 304 {
            return .unchanged
        }
        return try .changed(decode(data), etag: response.value(forHTTPHeaderField: "ETag"))
    }

    public func tokensByProjectToday() async throws -> TokensDTO {
        try await decode(send(get("/v1/tokens?since=today&groupBy=project")).0)
    }

    public func pause(scope: String, mode: PauseMode, reason: String) async throws -> PauseResponseDTO {
        let body = try JSONEncoder().encode(PauseRequestDTO(scope: scope, mode: mode.rawValue, reason: reason))
        return try await decode(send(post("/v1/pause", body)).0)
    }

    public func resume(scope: String) async throws -> ResumeResponseDTO {
        let body = try JSONEncoder().encode(ResumeRequestDTO(scope: scope))
        return try await decode(send(post("/v1/resume", body)).0)
    }

    public func rules() async throws -> RulesDTO {
        try await decode(send(get("/v1/pause/rules")).0)
    }

    // MARK: - plumbing

    private struct Spec {
        var path: String
        var method: String
        var body: Data?
    }

    private func get(_ path: String) -> Spec {
        Spec(path: path, method: "GET", body: nil)
    }

    private func post(_ path: String, _ body: Data) -> Spec {
        Spec(path: path, method: "POST", body: body)
    }

    /// Sends `spec` to the first candidate that answers. 2xx and 304 return; anything else
    /// becomes the daemon's error envelope.
    private func send(
        _ spec: Spec,
        configure: (inout URLRequest) -> Void = { _ in }
    ) async throws -> (Data, HTTPURLResponse) {
        try await endpoints.first { base in
            guard let url = URL(string: spec.path, relativeTo: base)?.absoluteURL else {
                throw DaemonError(code: "bad_url")
            }
            var request = URLRequest(url: url, timeoutInterval: Self.requestTimeout)
            request.httpMethod = spec.method
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            request.setValue("application/json", forHTTPHeaderField: "Accept")
            if let body = spec.body {
                request.httpBody = body
                request.setValue("application/json; charset=utf-8", forHTTPHeaderField: "Content-Type")
            }
            configure(&request)
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else { throw DaemonError.network }
            guard (200 ..< 300).contains(http.statusCode) || http.statusCode == 304 else {
                throw DaemonError.from(status: http.statusCode, body: data)
            }
            return (data, http)
        }
    }

    private func decode<T: Decodable>(_ data: Data) throws -> T {
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw DaemonError(code: "bad_response", message: "The device sent a response this app can't read.")
        }
    }
}
