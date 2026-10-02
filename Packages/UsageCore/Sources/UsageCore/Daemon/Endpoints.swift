import Foundation
import Synchronization

/// The ordered candidate base URLs for one device, with a memory of which one answered last.
///
/// Pairing hands over `addrs` in the daemon's preferred order (LAN IP, `<host>.local`, tailnet
/// IP). Each request tries the address that worked last time first and then the rest in their
/// original order, so a phone that walks from Wi-Fi onto a VPN finds the device again without
/// re-pairing. The same certificate pin applies to every address.
public final class Endpoints: Sendable {
    private struct State {
        var urls: [URL]
        var preferred: URL?
    }

    private let state: Mutex<State>

    public init(_ urls: [URL]) {
        state = Mutex(State(urls: urls, preferred: nil))
    }

    public convenience init(record: DeviceRecord) {
        self.init(record.baseURLs)
    }

    /// Candidates in the order to try them now.
    public func ordered() -> [URL] {
        state.withLock { s in
            guard let preferred = s.preferred, s.urls.contains(preferred) else { return s.urls }
            return [preferred] + s.urls.filter { $0 != preferred }
        }
    }

    /// The base URL that answered most recently, if any did.
    public var current: URL? {
        state.withLock { $0.preferred }
    }

    public func succeeded(_ url: URL) {
        state.withLock { $0.preferred = url }
    }

    /// Replaces the candidate list (pairing refresh from `/health.install.listeners`),
    /// keeping the preferred address when it is still a candidate.
    public func replace(_ urls: [URL]) {
        guard !urls.isEmpty else { return }
        state.withLock { s in
            s.urls = urls
            if let preferred = s.preferred, !urls.contains(preferred) {
                s.preferred = nil
            }
        }
    }

    /// Tries `attempt` against each candidate in turn. Moves on only for transport failures
    /// (unreachable, wrong certificate on that address); an HTTP error from a daemon that did
    /// answer is final. When every candidate fails, the error is `pinning` only if every one
    /// of them presented the wrong certificate, otherwise `network`.
    public func first<T>(_ attempt: (URL) async throws -> T) async throws -> T {
        var sawNetwork = false
        var sawPinning = false
        for base in ordered() {
            do {
                let value = try await attempt(base)
                succeeded(base)
                return value
            } catch {
                if Task.isCancelled {
                    throw CancellationError()
                }
                let mapped = DaemonError.from(transport: error)
                switch mapped.code {
                case "network": sawNetwork = true
                case "pinning": sawPinning = true
                default: throw mapped
                }
            }
        }
        throw sawPinning && !sawNetwork ? DaemonError(code: "pinning") : DaemonError.network
    }
}
