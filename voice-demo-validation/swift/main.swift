import Foundation
import WatchCoordinatorAdapter

actor SyntheticTransport: HTTPTransport {
    enum Reply { case timeout; case json(Int, String) }
    var replies: [Reply]
    private(set) var requests: [URLRequest] = []
    init(_ replies: [Reply]) { self.replies = replies }
    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        requests.append(request)
        precondition(!replies.isEmpty, "Unexpected extra HTTP request")
        switch replies.removeFirst() {
        case .timeout: throw URLError(.timedOut)
        case let .json(status, value):
            return (Data(value.utf8), HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
        }
    }
}

@main
struct IndependentMacAcceptance {
    static func task(_ status: String, chat: String = "chat_synthetic", device: String = "device_synthetic") -> String {
        #"{"id":"task_synthetic","requestId":"00000000-0000-4000-8000-000000000001","chatId":"\#(chat)","deviceId":"\#(device)","status":"\#(status)","prompt":"Open example.com","text":"Example Domain","createdAt":"now","updatedAt":"now"}"#
    }
    static func main() async throws {
        let decoder = JSONDecoder()
        let chat = try decoder.decode(CoordinatorChat.self, from: Data(#"{"id":"chat_synthetic","name":"Synthetic Mac","deviceId":"device_synthetic","threadId":"thread_synthetic","online":true,"workspace":"/synthetic"}"#.utf8))
        let configuration = try ProvidenceCoordinatorConfiguration.decodeAndValidate(Data(#"{"baseURL":"https://providence.hani.so","chatId":"chat_synthetic","deviceId":"device_synthetic"}"#.utf8))
        let prepared = MacPreparedRequest(requestID: UUID(uuidString: "00000000-0000-4000-8000-000000000001")!, text: "Open example.com", chatID: chat.id, deviceID: chat.deviceID)
        let persisted = try JSONEncoder().encode(prepared)
        let reopened = try decoder.decode(MacPreparedRequest.self, from: persisted)
        precondition(reopened == prepared)
        // This tests the product persistence VALUE, not UserDefaults or actual app reopening.
        let first = try DirectMessageSubmission(requestID: prepared.requestID, text: prepared.text, chat: chat, expectedDeviceID: prepared.deviceID)
        let recovered = try DirectMessageSubmission(requestID: reopened.requestID, text: reopened.text, chat: chat, expectedDeviceID: reopened.deviceID)
        let transport = SyntheticTransport([.timeout, .json(202, task("queued")), .json(200, task("completed"))])
        let client = try CoordinatorClient(baseURL: URL(string: "https://synthetic.example")!, transport: transport, tokenProvider: ClosureBearerTokenProvider { "synthetic-token" })
        do { _ = try await client.submit(first); preconditionFailure("Synthetic timeout was hidden") }
        catch is URLError { }
        var requests = await transport.requests
        precondition(requests.count == 1, "Ambiguous failure must not retry automatically")
        _ = try await client.submit(recovered)
        _ = try await client.task(id: "task_synthetic")
        requests = await transport.requests
        precondition(requests.count == 3)
        precondition(requests.map(\.httpMethod) == ["POST", "POST", "GET"])
        precondition(requests[0].url?.path == "/v1/chats/chat_synthetic/messages")
        precondition(requests[0].httpBody == requests[1].httpBody, "Explicit recovery must keep exact body")
        precondition(!requests.contains { $0.url?.path == "/v1/messages" }, "Never fall back to master routing")

        for (wrongChat, wrongDevice) in [("chat_other", "device_synthetic"), ("chat_synthetic", "device_other")] {
            let wrong = SyntheticTransport([.json(202, task("queued", chat: wrongChat, device: wrongDevice))])
            let client = try CoordinatorClient(baseURL: URL(string: "https://synthetic.example")!, transport: wrong, tokenProvider: ClosureBearerTokenProvider { "synthetic-token" })
            do { _ = try await client.submit(first); preconditionFailure("Wrong route response accepted") }
            catch let error as CoordinatorClientError {
                guard case .responseTargetMismatch = error else { throw error }
            }
        }
        let pendingTask = try decoder.decode(CoordinatorTask.self, from: Data(task("needs_input").utf8))
        let data = Data(#"{"id":"approval_synthetic","taskId":"task_synthetic","deviceId":"device_synthetic","method":"item/commandExecution/requestApproval","details":{"command":"open https://example.com","turnId":"turn_synthetic","requestId":"provider_synthetic"},"status":"pending"}"#.utf8)
        let displayed = try decoder.decode(CoordinatorApproval.self, from: data)
        precondition(MacControlContracts.matchesDisplayedApproval(displayed, displayed: displayed, task: pendingTask, configuration: configuration))
        var changed = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        var details = changed["details"] as! [String: Any]
        details["turnId"] = "turn_other"; changed["details"] = details
        let stale = try decoder.decode(CoordinatorApproval.self, from: JSONSerialization.data(withJSONObject: changed))
        precondition(!MacControlContracts.matchesDisplayedApproval(stale, displayed: displayed, task: pendingTask, configuration: configuration))
        print("M01 exact chat/device, M02 ambiguous timeout/no automatic retry, M03 byte-identical explicit recovery, M04 GET-only polling, M05 prepared value roundtrip, M06 stale approval details: passed.")
        print("Native dictation cancellation and actual Watch app reopen: manual checks required.")
    }
}
