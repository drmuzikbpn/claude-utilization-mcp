import Foundation

/// Every failure talking to a daemon. What the user sees is always [userMessage]: the
/// envelope's `hint`, else its `message`, else a per-code default.
public struct DaemonError: Error, Sendable, Equatable {
    public var code: String
    /// 0 when no HTTP response arrived (network failure, TLS pin mismatch).
    public var httpStatus: Int
    public var message: String?
    public var hint: String?

    public init(code: String, httpStatus: Int = 0, message: String? = nil, hint: String? = nil) {
        self.code = code
        self.httpStatus = httpStatus
        self.message = message
        self.hint = hint
    }

    public static let defaults: [String: String] = [
        "unauthorized": "Token rejected. Re-pair this device.",
        "network": "Device unreachable.",
        "pinning": "This device's certificate changed. Re-pair it.",
        "not_found": "Session no longer exists.",
        "conflict": "That session can't be hard-paused (no trusted pid).",
        "gone": "Session ended; pause cleared.",
        "rate_limited": "Too many attempts. Wait a minute and try again.",
        "forbidden": "The device refused the request.",
    ]

    public var userMessage: String {
        hint ?? message ?? Self.defaults[code] ?? "Daemon error (\(code))"
    }

    public static let network = DaemonError(code: "network")

    /// True when re-pairing, not retrying, is the fix.
    public var needsRepair: Bool {
        repairReason != nil
    }

    public var repairReason: RepairReason? {
        switch code {
        case "unauthorized": .tokenRejected
        case "pinning": .certificateChanged
        default: nil
        }
    }

    static func code(forStatus status: Int) -> String {
        switch status {
        case 401: "unauthorized"
        case 403: "forbidden"
        case 404: "not_found"
        case 409: "conflict"
        case 410: "gone"
        case 429: "rate_limited"
        default: "http_\(status)"
        }
    }

    /// Builds the error for a non-2xx response, preferring the daemon's error envelope.
    public static func from(status: Int, body: Data?) -> DaemonError {
        if let body, !body.isEmpty,
           let envelope = try? JSONDecoder().decode(ErrorEnvelopeDTO.self, from: body) {
            return DaemonError(
                code: envelope.error.code,
                httpStatus: status,
                message: envelope.error.message,
                hint: envelope.error.hint
            )
        }
        return DaemonError(code: code(forStatus: status), httpStatus: status)
    }

    /// Maps a transport failure. A `cancelled` URL error is a pin mismatch only when PinnedTrust
    /// refused a certificate moments ago (`PinRejections`); any other cancellation is not the
    /// device's fault and reads as an outage, never as "Needs re-pair".
    public static func from(transport error: any Error, rejections: PinRejections = .shared) -> DaemonError {
        if let daemon = error as? DaemonError {
            return daemon
        }
        guard let url = error as? URLError else {
            return .network
        }
        switch url.code {
        case .cancelled:
            return rejections.recent() ? DaemonError(code: "pinning") : .network
        case .serverCertificateUntrusted, .serverCertificateHasBadDate,
             .serverCertificateHasUnknownRoot, .serverCertificateNotYetValid:
            return DaemonError(code: "pinning")
        default:
            // The URL error's own text ("Could not connect to the server.") says less than ours.
            return .network
        }
    }

    /// True for failures where the next candidate address is worth trying.
    public var isTransport: Bool {
        code == "network"
    }
}
