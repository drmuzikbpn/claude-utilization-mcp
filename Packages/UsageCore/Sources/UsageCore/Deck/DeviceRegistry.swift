import Foundation

/// The paired devices, in pairing order, as JSON in `UserDefaults`. Records hold no secret: the
/// bearer for each lives in the Keychain under the record's `id` (`KeychainTokenStore`).
public struct DeviceRegistry: Sendable {
    public static let key = "deck.devices"

    /// UserDefaults is documented thread-safe but not annotated `Sendable`.
    private nonisolated(unsafe) let defaults: UserDefaults

    public init(defaults: UserDefaults) {
        self.defaults = defaults
    }

    public func load() -> [DeviceRecord] {
        guard let data = defaults.data(forKey: Self.key) else { return [] }
        return (try? JSONDecoder().decode([DeviceRecord].self, from: data)) ?? []
    }

    public func save(_ records: [DeviceRecord]) {
        if records.isEmpty {
            defaults.removeObject(forKey: Self.key)
        } else if let data = try? JSONEncoder().encode(records) {
            defaults.set(data, forKey: Self.key)
        }
    }

    /// Replaces the record with the same id in place, or appends a new one.
    public func upsert(_ record: DeviceRecord) {
        var records = load()
        if let index = records.firstIndex(where: { $0.id == record.id }) {
            records[index] = record
        } else {
            records.append(record)
        }
        save(records)
    }

    public func remove(_ id: String) {
        save(load().filter { $0.id != id })
    }
}

/// This install's id, the `<installId>` in the pause reason `usage-deck:<installId>`. Generated
/// once on first launch and kept for the life of the install.
public enum InstallID {
    public static let key = "deck.installId"

    public static func load(_ defaults: UserDefaults) -> String {
        if let existing = defaults.string(forKey: key), UUID(uuidString: existing) != nil {
            return existing
        }
        let fresh = UUID().uuidString.lowercased()
        defaults.set(fresh, forKey: key)
        return fresh
    }
}

/// Folds the TLS listeners a daemon reports in `/health.install.listeners` into the addresses a
/// device was paired with. The paired list is never replaced or reordered — the `.local` name
/// in it survives a LAN IP change that `/health` would not mention — new addresses only append.
public enum AddressMerge {
    public static func merge(paired: [String], reported: [String]) -> [String] {
        var seen = Set(paired.map { $0.lowercased() })
        var merged = paired
        for addr in reported {
            let trimmed = addr.trimmingCharacters(in: .whitespaces)
            guard HostValidation.isValid(trimmed), seen.insert(trimmed.lowercased()).inserted else { continue }
            merged.append(trimmed)
        }
        return merged
    }
}
