import Foundation

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
    public func redeem(_ invite: PairingInvite, id: String = UUID().uuidString) async throws -> DeviceConfig {
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
