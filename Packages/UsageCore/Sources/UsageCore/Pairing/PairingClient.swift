import Foundation

/// How long `redeem` keeps trying while no candidate address answers.
///
/// The very first request to a LAN address is what makes iOS ask for Local Network access, and
/// that request fails while the question is still on screen. Nothing reached the daemon, so the
/// one-time code is unspent and the same invite goes through once the user has answered.
public struct PairingPatience: Sendable {
    /// Seconds of failed attempts before giving up.
    public var window: TimeInterval
    public var pause: Duration
    /// Awaited after each failed attempt. Returns once the app is active again, and true when
    /// that took a wait (a system alert was up): the window then starts over.
    public var ready: @Sendable () async -> Bool

    public init(window: TimeInterval, pause: Duration = .seconds(1), ready: @escaping @Sendable () async -> Bool = { false }) {
        self.window = window
        self.pause = pause
        self.ready = ready
    }

    /// One attempt; the first failure is final.
    public static let none = PairingPatience(window: 0, pause: .zero)
}

/// Redeems a pairing invite for the device's bearer token: `POST /v1/pair { code }` over pinned
/// HTTPS, trying each candidate address in order. The one daemon endpoint that takes no bearer.
public struct PairingClient: Sendable {
    private let session: URLSession

    /// `session` must pin `invite.fingerprint`; `PairingClient(invite:)` builds one that does.
    public init(session: URLSession) {
        self.session = session
    }

    public init(invite: PairingInvite) {
        session = PinnedTrust.session(fingerprint: invite.fingerprint)
    }

    /// The paired device. `id` defaults to a fresh UUID. The returned token must go straight
    /// into the Keychain; nothing else may keep it.
    ///
    /// Only an attempt that reached no address at all is repeated (`patience`); a daemon that
    /// answered, even with a refusal, has had its say.
    public func redeem(
        _ invite: PairingInvite,
        id: String = UUID().uuidString,
        patience: PairingPatience = .none
    ) async throws -> DeviceConfig {
        var spent: TimeInterval = 0
        var attempt = 1
        DiagLog.shared.log(.pairing, "redeeming for \(invite.name), \(invite.addrs.count) address(es)")
        while true {
            let began = Date()
            do {
                let config = try await redeemOnce(invite, id: id)
                DiagLog.shared.log(.pairing, "redeemed on attempt \(attempt)")
                return config
            } catch let error as DaemonError where error.isTransport {
                spent += Date().timeIntervalSince(began)
                if await patience.ready() {
                    DiagLog.shared.log(.pairing, "attempt \(attempt) was interrupted (app left the foreground); trying again")
                    spent = 0
                } else if spent >= patience.window {
                    DiagLog.shared.log(.pairing, "gave up after \(attempt) attempt(s): no address answered")
                    throw error
                }
                attempt += 1
                try await Task.sleep(for: patience.pause)
                spent += Double(patience.pause.components.seconds) + Double(patience.pause.components.attoseconds) / 1e18
            }
        }
    }

    private func redeemOnce(_ invite: PairingInvite, id: String) async throws -> DeviceConfig {
        let record = DeviceRecord(id: id, name: invite.name, addrs: invite.addrs, port: invite.port, fingerprint: invite.fingerprint)
        let body = try JSONEncoder().encode(PairRequestDTO(code: invite.code))
        let response: PairResponseDTO = try await Endpoints(record: record).first { base in
            guard let url = URL(string: "/v1/pair", relativeTo: base)?.absoluteURL else {
                throw DaemonError(code: "bad_url")
            }
            var request = URLRequest(url: url, timeoutInterval: URLSessionDaemonAPI.requestTimeout)
            request.httpMethod = "POST"
            request.httpBody = body
            request.setValue("application/json; charset=utf-8", forHTTPHeaderField: "Content-Type")
            request.setValue("application/json", forHTTPHeaderField: "Accept")
            let (data, raw) = try await session.data(for: request)
            guard let http = raw as? HTTPURLResponse else { throw DaemonError.network }
            guard (200 ..< 300).contains(http.statusCode) else {
                throw DaemonError.from(status: http.statusCode, body: data)
            }
            guard let decoded = try? JSONDecoder().decode(PairResponseDTO.self, from: data),
                  !decoded.token.isEmpty
            else { throw DaemonError(code: "bad_response", message: "The device sent a pairing reply this app can't read.") }
            return decoded
        }
        // Belt and braces: the TLS pin already proved the key; a reply naming another key is a bug.
        if let fp = response.fp, fp.lowercased() != invite.fingerprint {
            throw DaemonError(code: "pinning")
        }
        var paired = record
        if let name = response.name, !name.isEmpty {
            paired.name = name
        }
        return DeviceConfig(record: paired, token: response.token)
    }
}
