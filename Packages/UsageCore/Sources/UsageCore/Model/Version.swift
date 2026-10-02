import Foundation

/// `MAJOR.MINOR.<commit-count>+<short-sha>`, the scheme the daemon and both apps use. Ordering
/// is by the three numbers only; the sha is a label, not a rank.
public struct Version: Sendable, Equatable, Hashable, Comparable, CustomStringConvertible {
    public var major: Int
    public var minor: Int
    public var build: Int
    public var sha: String

    public init(major: Int, minor: Int, build: Int, sha: String = "") {
        self.major = major
        self.minor = minor
        self.build = build
        self.sha = sha
    }

    /// Accepts `v0.1.417+3f9c2ab`, `0.1.417+3f9c2ab` and `0.1.417`; anything else is nil.
    public static func parse(_ string: String) -> Version? {
        let pattern = /^v?(\d+)\.(\d+)\.(\d+)(?:\+([0-9A-Za-z.\-]+))?$/
        guard let match = string.trimmingCharacters(in: .whitespacesAndNewlines).wholeMatch(of: pattern),
              let major = Int(match.1), let minor = Int(match.2), let build = Int(match.3)
        else { return nil }
        return Version(major: major, minor: minor, build: build, sha: match.4.map(String.init) ?? "")
    }

    public static func < (lhs: Version, rhs: Version) -> Bool {
        (lhs.major, lhs.minor, lhs.build) < (rhs.major, rhs.minor, rhs.build)
    }

    public static func == (lhs: Version, rhs: Version) -> Bool {
        (lhs.major, lhs.minor, lhs.build) == (rhs.major, rhs.minor, rhs.build)
    }

    public func hash(into hasher: inout Hasher) {
        hasher.combine(major)
        hasher.combine(minor)
        hasher.combine(build)
    }

    public var description: String {
        "\(major).\(minor).\(build)" + (sha.isEmpty ? "" : "+\(sha)")
    }
}
