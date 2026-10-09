#if DEBUG
import Foundation
import WatchCoordinatorAdapter

/// Simulator-only fixtures exercise the real model and controls. The transport
/// is in-memory and rejects every unexpected path; no request opens a socket.
@MainActor
enum WatchRecoveryFixtures {
    static func silentRehearsalModel() -> MacControlModel {
        let suite = "so.demo.providence.watch.silent-rehearsal"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        let client = try! CoordinatorClient(baseURL: URL(string: "https://recovery.invalid")!,
            transport: WatchRecoveryFixtureTransport(name: "rehearsal"),
            tokenProvider: ClosureBearerTokenProvider { "synthetic-fixture-token" })
        return MacControlModel(defaults: defaults,
            configuration: ProvidenceCoordinatorConfiguration(baseURL: URL(string: "https://recovery.invalid")!,
                deviceID: "fixture-mac", chatID: "fixture-chat"), client: client)
    }

    static func modelFromArguments() -> MacControlModel? {
        let prefix = "--preview-watch-recovery="
        guard let argument = ProcessInfo.processInfo.arguments.first(where: { $0.hasPrefix(prefix) }) else { return nil }
        let name = String(argument.dropFirst(prefix.count))
        let suite = "so.demo.providence.watch.recovery-fixture.\(name)"
        guard let defaults = UserDefaults(suiteName: suite) else { fatalError("Cannot create isolated fixture storage") }
        let preserve = ProcessInfo.processInfo.arguments.contains("--preserve-watch-recovery")
        if !preserve { defaults.removePersistentDomain(forName: suite) }
        let route = MacPreparedRequest(requestID: UUID(uuidString: "11111111-1111-4111-8111-111111111111")!,
            text: "Synthetic request", chatID: "fixture-chat", deviceID: "fixture-mac", spokenText: "Synthetic request")
        if !preserve {
            if name == "unknown" {
                defaults.set(try? JSONEncoder().encode(route), forKey: "macControl.preparedRequest")
            } else if name != "unsupported" && !name.hasPrefix("targets") {
                defaults.set("fixture-task", forKey: "macControl.taskID")
                defaults.set(try? JSONEncoder().encode(route), forKey: "macControl.selectedRoute")
            }
        }
        let client = try! CoordinatorClient(baseURL: URL(string: "https://recovery.invalid")!,
            transport: WatchRecoveryFixtureTransport(name: name),
            tokenProvider: ClosureBearerTokenProvider { "synthetic-fixture-token" })
        let model = MacControlModel(defaults: defaults,
            configuration: ProvidenceCoordinatorConfiguration(baseURL: URL(string: "https://recovery.invalid")!,
                deviceID: "fixture-mac", chatID: "fixture-chat"), client: client)
        if !preserve {
            if name == "unsupported" { model.text = "Open Safari on my phone"; model.sendOrRetry() }
            if name == "unknown" { model.sendOrRetry() }
        }
        return model
    }
}

private actor WatchRecoveryFixtureTransport: HTTPTransport {
    let name: String
    var resolved = false
    init(name: String) { self.name = name }

    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let path = request.url!.path
        var code = 200
        let body: [String: Any]
        switch (request.httpMethod, path) {
        case ("GET", "/v1/tasks/fixture-task"):
            if name == "malformed" { body = ["task": "not a task"] }
            else { body = task() }
        case ("GET", "/v1/briefing"):
            body = ["devices": [], "tasks": [], "phone": NSNull(),
                "approvals": !resolved && ["approval", "mismatch", "decision-unknown"].contains(name) ? [approval()] : []]
        case ("GET", "/v1/devices"):
            if name == "targets-error" {
                code = 503; body = ["error": "Synthetic registry unavailable"]
            } else if name.hasPrefix("targets") {
                body = ["devices": [
                    ["id": "fixture-mac", "name": "Demo's Mac", "local": true,
                     "online": true, "connectionState": "connected", "platform": "darwin"],
                    ["id": "fixture-review", "name": "Review's Mac", "local": false,
                     "online": true, "connectionState": "connected", "platform": "darwin"],
                    ["id": "fixture-windows", "name": "DemoPC", "local": false,
                     "online": name != "targets-offline", "connectionState": name == "targets-offline" ? "disconnected" : "connected",
                     "platform": "win32"]
                ]]
            } else {
                body = ["devices": [["id": "fixture-mac", "name": "Demo Mac", "local": true,
                    "online": true, "connectionState": "connected", "platform": "darwin"]]]
            }
        case ("GET", "/v1/chats"):
            if name.hasPrefix("targets") {
                body = ["chats": [
                    ["id": "fixture-chat", "name": "Demo", "deviceId": "fixture-mac", "threadId": "fixture-thread", "online": true],
                    ["id": "fixture-review-demo", "name": "Demo", "deviceId": "fixture-review", "threadId": "fixture-review-thread", "online": true],
                    ["id": "fixture-review-research", "name": "Research", "deviceId": "fixture-review", "threadId": "fixture-research-thread", "online": true],
                    ["id": "fixture-windows-demo", "name": "Windows demo", "deviceId": "fixture-windows", "threadId": "fixture-windows-thread", "online": name != "targets-offline"]
                ]]
            } else {
                body = ["chats": [["id": "fixture-chat", "name": "Demo", "deviceId": "fixture-mac", "threadId": "fixture-thread", "online": true]]]
            }
        case ("POST", "/v1/chats/fixture-chat/messages"):
            throw URLError(.networkConnectionLost)
        case ("POST", "/v1/approvals/fixture-approval"):
            if name == "decision-unknown" { throw URLError(.timedOut) }
            resolved = true
            body = ["resolved": true]
        default:
            code = 404; body = ["error": "Unsupported synthetic fixture path"]
        }
        return (try JSONSerialization.data(withJSONObject: body), HTTPURLResponse(url: request.url!, statusCode: code, httpVersion: nil, headerFields: nil)!)
    }

    private func task() -> [String: Any] {
        let needsInput = ["approval", "decision-unknown"].contains(name) && !resolved
        let status = needsInput ? "needs_input" : name == "running" ? "running" : name == "failed" ? "failed" : "completed"
        return ["id": "fixture-task", "requestId": "11111111-1111-4111-8111-111111111111",
            "deviceId": "fixture-mac", "chatId": "fixture-chat", "status": status,
            "prompt": "Synthetic request", "text": name == "playback" ? "This is a safe simulator playback check. Use Options to pause or resume this spoken result. No message is being sent. Your next request will use a new recording when you are ready." : resolved ? "Decision received. No real message was sent." : "Nothing sent yet. Approval is pending for the demo message.",
            "error": "The task could not finish. Check its result before trying again.",
            "createdAt": "2026-09-19T20:00:00Z", "updatedAt": "2026-09-19T20:00:00Z",
            "approvalStates": ["approval", "mismatch", "decision-unknown"].contains(name)
                ? [["id": "fixture-approval", "method": "item/tool/requestUserInput", "status": resolved ? "resolved" : "pending"]] : []]
    }

    private func approval() -> [String: Any] {
        ["id": "fixture-approval", "taskId": "fixture-task", "deviceId": "fixture-mac", "status": "pending",
         "method": "item/tool/requestUserInput", "details": ["questions": [["id": "send", "question": "Send ‘hi’ from Demo Sender to Demo Recipient?",
            "options": [["label": "Send hi"], ["label": "Cancel this task"]]]]]]
    }
}
#endif
