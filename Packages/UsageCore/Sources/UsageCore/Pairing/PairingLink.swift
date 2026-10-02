import Foundation

/// What `claude-usage pair` puts in its QR (contract v2). It never carries the bearer: the
/// single-use `code` is redeemed over pinned HTTPS for the token (`PairingClient`).
public struct PairingInvite: Sendable, Equatable {
    public var name: String
    public var addrs: [String]
    public var port: Int
    /// Lowercase hex SHA-256 of the daemon's SubjectPublicKeyInfo.
    public var fingerprint: String
    public var code: String

    public init(name: String, addrs: [String], port: Int, fingerprint: String, code: String) {
        self.name = name
        self.addrs = addrs
        self.port = port
        self.fingerprint = fingerprint
        self.code = code
    }
}

extension PairingInvite: CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
    public var description: String {
        "PairingInvite(name: \(name), addrs: \(addrs), port: \(port), code: <redacted>)"
    }

    public var debugDescription: String {
        description
    }

    public var customMirror: Mirror {
        Mirror(self, children: ["name": name, "addrs": addrs, "port": port, "fingerprint": fingerprint])
    }
}

/// The v1 JSON that `claude-usage configure pairing` prints: a live bearer for plain HTTP.
/// Parsed so a paste can be recognised and explained; the iOS app only pairs over pinned HTTPS.
public struct LegacyPairing: Sendable, Equatable {
    public var name: String
    public var addr: String
    public var port: Int
    public var token: String
}

extension LegacyPairing: CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
    public var description: String {
        "LegacyPairing(name: \(name), addr: \(addr), port: \(port), token: <redacted>)"
    }

    public var debugDescription: String {
        description
    }

    public var customMirror: Mirror {
        Mirror(self, children: ["name": name, "addr": addr, "port": port])
    }
}

public enum PairingLink: Sendable, Equatable {
    case invite(PairingInvite)
    case legacy(LegacyPairing)

    public static let scheme = "usagedeck"
    public static let supportedVersion = 2

    /// The message is shown on the pairing screen verbatim.
    public struct ParseError: Error, Sendable, Equatable, CustomStringConvertible {
        public var message: String

        public var description: String {
            message
        }
    }

    /// Parses a scanned, opened or pasted pairing: a `usagedeck://pair?...` link, or the v1 JSON.
    public static func parse(_ raw: String) -> Result<PairingLink, ParseError> {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.hasPrefix("{") {
            return parseLegacy(text).map(PairingLink.legacy)
        }
        guard let components = URLComponents(string: text),
              components.scheme?.lowercased() == scheme,
              components.host?.lowercased() == "pair"
        else { return .failure(ParseError(message: "That isn't a Usage Deck pairing link. Run `claude-usage pair` on the device.")) }
        return parseInvite(components).map(PairingLink.invite)
    }

    public static func parse(_ url: URL) -> Result<PairingLink, ParseError> {
        parse(url.absoluteString)
    }

    private static func parseInvite(_ components: URLComponents) -> Result<PairingInvite, ParseError> {
        var query: [String: String] = [:]
        for item in components.queryItems ?? [] where query[item.name] == nil {
            query[item.name] = item.value ?? ""
        }
        func fail(_ message: String) -> Result<PairingInvite, ParseError> {
            .failure(ParseError(message: message))
        }

        guard let v = query["v"].flatMap(Int.init) else { return fail("The pairing link has no version.") }
        guard v == supportedVersion else {
            return fail("This pairing link is version \(v); update Usage Deck to use it.")
        }
        let name = (query["name"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return fail("The pairing link has no device name.") }
        let addrs = (query["addrs"] ?? "")
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        guard !addrs.isEmpty else { return fail("The pairing link has no addresses.") }
        if let bad = addrs.first(where: { !HostValidation.isValid($0) }) {
            return fail("The pairing link has an invalid address '\(bad)'.")
        }
        guard let port = query["port"].flatMap(Int.init), (1 ... 65535).contains(port) else {
            return fail("The pairing link has an invalid port.")
        }
        let fp = (query["fp"] ?? "").lowercased()
        guard fp.count == 64, fp.allSatisfy(\.isHexDigit) else {
            return fail("The pairing link has an invalid certificate fingerprint.")
        }
        let code = query["code"] ?? ""
        guard (22 ... 256).contains(code.count),
              code.unicodeScalars.allSatisfy({ base64URL.contains($0) })
        else { return fail("The pairing link has an invalid pairing code.") }
        return .success(PairingInvite(name: name, addrs: deduplicated(addrs), port: port, fingerprint: fp, code: code))
    }

    private static let base64URL = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")

    private static func deduplicated(_ addrs: [String]) -> [String] {
        var seen = Set<String>()
        return addrs.filter { seen.insert($0.lowercased()).inserted }
    }

    private struct LegacyDTO: Decodable {
        var v: Int
        var name: String
        var addr: String
        var port: Int
        var token: String
    }

    private static func parseLegacy(_ text: String) -> Result<LegacyPairing, ParseError> {
        guard let dto = try? JSONDecoder().decode(LegacyDTO.self, from: Data(text.utf8)) else {
            return .failure(ParseError(message: "That isn't a Usage Deck pairing code."))
        }
        guard dto.v == 1 else {
            return .failure(ParseError(message: "Unsupported pairing version \(dto.v); update Usage Deck."))
        }
        guard !dto.token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return .failure(ParseError(message: "The pairing code has no token."))
        }
        guard (1 ... 65535).contains(dto.port) else {
            return .failure(ParseError(message: "The pairing code has an invalid port \(dto.port)."))
        }
        guard HostValidation.isValid(dto.addr) else {
            return .failure(ParseError(message: "The pairing code has an invalid address '\(dto.addr)'."))
        }
        return .success(LegacyPairing(name: dto.name, addr: dto.addr, port: dto.port, token: dto.token))
    }
}

/// IPv4 literals and DNS host names (including `.local`). Same rules as the deck's pairing.
public enum HostValidation {
    public static func isValid(_ addr: String) -> Bool {
        guard !addr.isEmpty, addr.count <= 253 else { return false }
        let labels = addr.split(separator: ".", omittingEmptySubsequences: false)
        if labels.allSatisfy({ !$0.isEmpty && $0.allSatisfy(\.isASCIIDigit) }) {
            // All-numeric: must be a well-formed IPv4 address, never a "hostname" like 100.1.1.
            return labels.count == 4 && labels.allSatisfy { Int($0).map { (0 ... 255).contains($0) } ?? false }
        }
        return labels.allSatisfy(isLabel)
    }

    private static func isLabel(_ label: Substring) -> Bool {
        guard (1 ... 63).contains(label.count),
              let first = label.first, let last = label.last,
              first.isASCIIAlphanumeric, last.isASCIIAlphanumeric
        else { return false }
        return label.allSatisfy { $0.isASCIIAlphanumeric || $0 == "-" }
    }
}

private extension Character {
    var isASCIIDigit: Bool {
        isASCII && isNumber
    }

    var isASCIIAlphanumeric: Bool {
        isASCII && (isLetter || isNumber)
    }
}
