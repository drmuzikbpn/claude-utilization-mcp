import Foundation

/// A raw server-sent event: the `event:` name (nil when the frame had none) and its joined `data:`.
public struct SSEFrame: Sendable, Equatable {
    public var event: String?
    public var data: String
    public var id: String?

    public init(event: String?, data: String, id: String? = nil) {
        self.event = event
        self.data = data
        self.id = id
    }
}

/// Incremental `text/event-stream` parser (WHATWG §9.2) fed one byte at a time.
///
/// It works on bytes rather than `AsyncBytes.lines` on purpose: `lines` drops empty lines, and
/// the empty line is exactly what dispatches an event.
public struct SSEParser: Sendable {
    private var line: [UInt8] = []
    private var lastWasCR = false
    private var event: String?
    private var data: [String] = []
    private var id: String?

    public init() {}

    /// Consumes one byte; returns a frame when that byte completed one.
    public mutating func feed(_ byte: UInt8) -> SSEFrame? {
        switch byte {
        case 0x0A: // \n
            if lastWasCR {
                lastWasCR = false
                return nil
            }
            return endLine()
        case 0x0D: // \r
            lastWasCR = true
            return endLine()
        default:
            lastWasCR = false
            line.append(byte)
            return nil
        }
    }

    /// Convenience for tests and fixtures: every frame in `text`.
    public static func frames(in text: String) -> [SSEFrame] {
        var parser = SSEParser()
        return text.utf8.compactMap { parser.feed($0) }
    }

    private mutating func endLine() -> SSEFrame? {
        defer { line.removeAll(keepingCapacity: true) }
        if line.isEmpty {
            return dispatch()
        }
        let text = String(decoding: line, as: UTF8.self)
        if text.hasPrefix(":") {
            return nil
        }
        let field: Substring
        var value: Substring
        if let colon = text.firstIndex(of: ":") {
            field = text[..<colon]
            value = text[text.index(after: colon)...]
            if value.hasPrefix(" ") {
                value = value.dropFirst()
            }
        } else {
            field = Substring(text)
            value = ""
        }
        switch field {
        case "event": event = String(value)
        case "data": data.append(String(value))
        case "id": id = String(value)
        default: break // `retry` and unknown fields: reconnection pacing is ours, not the server's.
        }
        return nil
    }

    private mutating func dispatch() -> SSEFrame? {
        defer {
            event = nil
            data = []
        }
        guard !data.isEmpty else { return nil }
        return SSEFrame(event: event, data: data.joined(separator: "\n"), id: id)
    }
}

/// What one connection to `/v1/events` yields: `.open`, then events, then exactly one `.closed`.
public enum StreamItem: Sendable, Equatable {
    case open
    case event(DaemonEvent)
    case closed(DaemonError?)
}

/// Opens the daemon's `GET /v1/events` SSE stream over the device's candidate addresses.
///
/// Each call to `connect()` is one connection; reconnection and backoff are the caller's job
/// (`DeviceClient`). Cancelling the consuming task closes the connection.
public final class EventStream: Sendable {
    /// Idle allowance between bytes; the daemon heartbeats well inside it.
    public static let idleTimeout: TimeInterval = 90

    private let token: String
    private let session: URLSession
    private let endpoints: Endpoints

    public init(config: DeviceConfig, session: URLSession, endpoints: Endpoints) {
        token = config.token
        self.session = session
        self.endpoints = endpoints
    }

    public func connect() -> AsyncStream<StreamItem> {
        let (stream, continuation) = AsyncStream<StreamItem>.makeStream()
        let task = Task { [token, session, endpoints] in
            await Self.run(token: token, session: session, endpoints: endpoints, into: continuation)
            continuation.finish()
        }
        continuation.onTermination = { _ in task.cancel() }
        return stream
    }

    private static func run(
        token: String,
        session: URLSession,
        endpoints: Endpoints,
        into continuation: AsyncStream<StreamItem>.Continuation
    ) async {
        let bytes: URLSession.AsyncBytes
        do {
            bytes = try await endpoints.first { base in
                guard let url = URL(string: "/v1/events", relativeTo: base)?.absoluteURL else {
                    throw DaemonError(code: "bad_url")
                }
                var request = URLRequest(url: url, timeoutInterval: idleTimeout)
                request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
                request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                let (bytes, response) = try await session.bytes(for: request)
                guard let http = response as? HTTPURLResponse else { throw DaemonError.network }
                guard (200 ..< 300).contains(http.statusCode) else {
                    var body = Data()
                    for try await byte in bytes {
                        body.append(byte)
                        if body.count > 64 * 1024 {
                            break
                        }
                    }
                    throw DaemonError.from(status: http.statusCode, body: body)
                }
                return bytes
            }
        } catch is CancellationError {
            continuation.yield(.closed(nil))
            return
        } catch {
            continuation.yield(.closed(DaemonError.from(transport: error)))
            return
        }

        continuation.yield(.open)
        var parser = SSEParser()
        do {
            for try await byte in bytes {
                if let frame = parser.feed(byte) {
                    continuation.yield(.event(SSEDecoder.decode(event: frame.event, data: frame.data)))
                }
            }
            continuation.yield(.closed(nil))
        } catch {
            if Task.isCancelled {
                continuation.yield(.closed(nil))
            } else {
                // A stream that opened and then dropped is an outage, never a pin failure.
                continuation.yield(.closed(.network))
            }
        }
    }
}
