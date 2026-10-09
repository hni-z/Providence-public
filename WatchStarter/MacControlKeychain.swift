import Foundation
import Security

enum MacControlKeychain {
    private static let service = "so.demo.providence.watch.coordinator"
    private static let account = "client-token"

    static func readToken() throws -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data,
              let token = String(data: data, encoding: .utf8), !token.isEmpty else {
            throw MacControlError.message("The Watch could not read its private Providence credential.")
        }
        return token
    }

    static func saveToken(_ token: String) throws {
        guard token.count >= 32, !token.contains(where: { $0.isWhitespace }) else {
            throw MacControlError.message("The pairing response did not contain a valid client credential.")
        }
        let data = Data(token.utf8)
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
        let attributes: [String: Any] = [kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        let existing = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if existing == errSecItemNotFound {
            var add = query; attributes.forEach { add[$0.key] = $0.value }
            guard SecItemAdd(add as CFDictionary, nil) == errSecSuccess else {
                throw MacControlError.message("The Watch could not save its private Providence credential.")
            }
        } else if existing != errSecSuccess {
            throw MacControlError.message("The Watch could not save its private Providence credential.")
        }
    }

    static func clearRejectedToken() {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
        SecItemDelete(query as CFDictionary)
    }
}
