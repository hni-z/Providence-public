import Foundation
import WatchCoordinatorAdapter

@main
struct MacControlContractTests {
    static func main() throws {
        let configuration = try ProvidenceCoordinatorConfiguration.decodeAndValidate(
            Data(#"{"baseURL":"https://providence.hani.so","deviceId":"device_review","chatId":"chat_review"}"#.utf8)
        )
        precondition(configuration.deviceID == "device_review")
        precondition(configuration.chatID == "chat_review")
        precondition(Self.throws {
            _ = try ProvidenceCoordinatorConfiguration.decodeAndValidate(
                Data(#"{"baseURL":"https://evil.example","deviceId":"device_review","chatId":"chat_review"}"#.utf8)
            )
        })

        let task = try JSONDecoder().decode(CoordinatorTask.self, from: Data(#"{"id":"task-1","requestId":"00000000-0000-0000-0000-000000000001","chatId":"chat_review","deviceId":"device_review","status":"needs_input","prompt":"p","text":"t","createdAt":"now","updatedAt":"now"}"#.utf8))
        let displayed = try JSONDecoder().decode(CoordinatorApproval.self, from: Data(#"{"id":"approval-1","taskId":"task-1","deviceId":"device_review","method":"item/commandExecution/requestApproval","details":{"command":"pwd"},"status":"pending"}"#.utf8))
        precondition(MacControlContracts.isBasicApproval(displayed))
        precondition(MacControlContracts.matchesDisplayedApproval(displayed, displayed: displayed, task: task, configuration: configuration))
        let changed = try JSONDecoder().decode(CoordinatorApproval.self, from: Data(#"{"id":"approval-1","taskId":"task-1","deviceId":"device_review","method":"item/commandExecution/requestApproval","details":{"command":"rm -rf"},"status":"pending"}"#.utf8))
        precondition(!MacControlContracts.matchesDisplayedApproval(changed, displayed: displayed, task: task, configuration: configuration))
        let unsupported = try JSONDecoder().decode(CoordinatorApproval.self, from: Data(#"{"id":"approval-2","taskId":"task-1","deviceId":"device_review","method":"item/permissions/requestApproval","details":{},"status":"pending"}"#.utf8))
        precondition(!MacControlContracts.isBasicApproval(unsupported))
        let encoder = JSONEncoder()
        let approvalData = try encoder.encode(displayed)
        let original = try JSONSerialization.jsonObject(with: approvalData) as! [String: Any]
        for (key, value) in [("id", "approval-other"), ("taskId", "task-other"), ("deviceId", "device-other"), ("status", "resolved")] {
            var modified = original; modified[key] = value
            let fresh = try JSONDecoder().decode(CoordinatorApproval.self, from: JSONSerialization.data(withJSONObject: modified))
            precondition(!MacControlContracts.matchesDisplayedApproval(fresh, displayed: displayed, task: task, configuration: configuration))
        }
        let completedData = try encoder.encode(task)
        var completedObject = try JSONSerialization.jsonObject(with: completedData) as! [String: Any]
        completedObject["status"] = "completed"
        let completed = try JSONDecoder().decode(CoordinatorTask.self, from: JSONSerialization.data(withJSONObject: completedObject))
        precondition(!MacControlContracts.matchesDisplayedApproval(displayed, displayed: displayed, task: completed, configuration: configuration))
        print("Mac routing configuration and exact approval contracts passed.")
    }

    static func `throws`(_ action: () throws -> Void) -> Bool {
        do { try action(); return false } catch { return true }
    }
}
