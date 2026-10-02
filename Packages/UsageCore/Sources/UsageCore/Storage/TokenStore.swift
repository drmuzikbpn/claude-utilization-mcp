import Foundation
import Security
import Synchronization

/// Where bearer tokens live. On the iPhone that is the Keychain and nowhere else: never
/// UserDefaults, never the App Group, never a WatchConnectivity payload, never a log line.
public protocol TokenStore: Sendable {
    func token(for deviceId: String) -> String?
    func setToken(_ token: String, for deviceId: String) throws
    func removeToken(for deviceId: String)
}

public struct KeychainError: Error, Sendable, Equatable {
    public var status: OSStatus
}

/// Generic-password items, `AfterFirstUnlockThisDeviceOnly` (background refresh can read them
/// once the phone has been unlocked; never synced to iCloud, never restored to another phone).
public struct KeychainTokenStore: TokenStore {
    public static let defaultService = "com.evenseal.usagedeck.token"

    private let service: String

    public init(service: String = defaultService) {
        self.service = service
    }

    private func query(_ deviceId: String) -> [CFString: Any] {
        [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: deviceId,
            kSecUseDataProtectionKeychain: true,
            kSecAttrSynchronizable: false,
        ]
    }

    public func token(for deviceId: String) -> String? {
        var q = query(deviceId)
        q[kSecReturnData] = true
        q[kSecMatchLimit] = kSecMatchLimitOne
        var result: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data
        else { return nil }
        return String(data: data, encoding: .utf8)
    }

    public func setToken(_ token: String, for deviceId: String) throws {
        let data = Data(token.utf8)
        let update: [CFString: Any] = [
            kSecValueData: data,
            kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        var status = SecItemUpdate(query(deviceId) as CFDictionary, update as CFDictionary)
        if status == errSecItemNotFound {
            var add = query(deviceId)
            add[kSecValueData] = data
            add[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            status = SecItemAdd(add as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw KeychainError(status: status) }
    }

    public func removeToken(for deviceId: String) {
        SecItemDelete(query(deviceId) as CFDictionary)
    }
}

/// For tests and previews.
public final class InMemoryTokenStore: TokenStore {
    private let tokens = Mutex<[String: String]>([:])

    public init() {}

    public func token(for deviceId: String) -> String? {
        tokens.withLock { $0[deviceId] }
    }

    public func setToken(_ token: String, for deviceId: String) throws {
        tokens.withLock { $0[deviceId] = token }
    }

    public func removeToken(for deviceId: String) {
        _ = tokens.withLock { $0.removeValue(forKey: deviceId) }
    }
}
