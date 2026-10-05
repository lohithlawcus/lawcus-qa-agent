import Foundation
import Security

// Only this application's own credentials are addressable. Values travel through
// private pipes, never command arguments, environment variables or log messages.
// 'lawcus-login-*' added 2026-09-17 — one dedicated account per additional
// Lawcus environment (Co Server, Prod USA, Prod EU), same discipline as
// 'lawcus-login' itself: a literal, deliberate allowlist entry per real
// credential, never a wildcard/pattern match.
let service = "com.lawcus.qa-agent.local.v1"
let allowed = Set(["lawcus-login", "lawcus-login-co-server", "lawcus-login-prod-usa", "lawcus-login-prod-eu", "openai-api", "ai-openrouter", "ai-anthropic", "ai-huggingface", "artifact-key"])
func reply(_ object: [String: Any]) -> Never {
    if let data = try? JSONSerialization.data(withJSONObject: object) {
        FileHandle.standardOutput.write(data)
    }
    exit(0)
}
let data = FileHandle.standardInput.readDataToEndOfFile()
guard data.count <= 16384,
      let input = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
      let account = input["account"] as? String, allowed.contains(account),
      let operation = input["operation"] as? String else { reply(["ok": false, "code": "invalid-request"]) }
let query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: service,
    kSecAttrAccount as String: account
]
if operation == "set" {
    guard let value = input["value"] as? String, value.utf8.count <= 10000 else { reply(["ok": false, "code": "invalid-value"]) }
    let attributes = [kSecValueData as String: Data(value.utf8)]
    var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
    if status == errSecItemNotFound {
        var item = query
        for (key, value) in attributes { item[key] = value }
        item[kSecAttrLabel as String] = "Lawcus QA Agent — \(account)"
        status = SecItemAdd(item as CFDictionary, nil)
    }
    reply(["ok": status == errSecSuccess, "code": status])
}
if operation == "delete" {
    let status = SecItemDelete(query as CFDictionary)
    reply(["ok": status == errSecSuccess || status == errSecItemNotFound, "code": status])
}
if operation == "get" || operation == "exists" {
    var search = query
    search[kSecMatchLimit as String] = kSecMatchLimitOne
    search[kSecReturnData as String] = operation == "get"
    var result: CFTypeRef?
    let status = SecItemCopyMatching(search as CFDictionary, &result)
    if status == errSecItemNotFound { reply(["ok": true, "exists": false]) }
    if status != errSecSuccess { reply(["ok": false, "code": status]) }
    if operation == "exists" { reply(["ok": true, "exists": true]) }
    guard let resultData = result as? Data, let value = String(data: resultData, encoding: .utf8) else { reply(["ok": false, "code": "invalid-data"]) }
    reply(["ok": true, "exists": true, "value": value])
}
reply(["ok": false, "code": "invalid-operation"])
