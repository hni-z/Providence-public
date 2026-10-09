import Foundation
import SwiftUI
import WatchCoordinatorAdapter

private actor MirroringRecoveryTransport: HTTPTransport {
    enum Mode { case completed, lostAck, omittedEcho, changedEcho, rejected, untrustedRejection, running }
    var mode: Mode
    var stale = false
    var completed = false
    private var posts: [Data] = []
    private var reads = 0
    private var acceptedBody: [String: Any]?
    init(_ mode: Mode) { self.mode = mode }
    func expire() { stale = true; mode = .completed }
    func changeEcho() { mode = .changedEcho }
    func finish() { completed = true }
    func postBodies() -> [Data] { posts }
    func taskReads() -> Int { reads }

    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let path = request.url!.path
        var status = 200
        let value: Any
        switch (request.httpMethod, path) {
        case ("GET", "/v1/devices"):
            let now = Date().timeIntervalSince1970
            let capability: [String: Any] = ["schemaVersion": 1, "transport": "apple-iphone-mirroring",
                "appBundleId": "com.apple.ScreenContinuity", "deviceId": "mac", "chatId": "chat",
                "phoneId": "phone", "phoneName": "Fixture iPhone", "sessionId": stale ? "changed_lease" : "lease",
                "observedAt": now - (stale ? 120 : 1), "expiresAt": now + (stale ? -60 : 30),
                "configured": true, "appPresent": true, "phoneReachable": true, "authenticated": true,
                "identityVerified": true, "controllable": true, "effectVerified": true, "executable": true,
                "supportedActions": ["general", "browser", "messaging", "email"]]
            value = ["devices": [["id": "mac", "name": "Fixture Mac", "local": true, "online": true, "connectionState": "online",
                "platform": "darwin", "capabilities": ["desktop": true, "iphoneMirroring": capability]]]]
        case ("GET", "/v1/chats"):
            value = ["chats": [["id": "chat", "name": "Fixture", "deviceId": "mac", "threadId": "thread", "online": true]]]
        case ("POST", "/v1/chats/chat/messages"):
            let body = request.httpBody!
            posts.append(body)
            acceptedBody = try JSONSerialization.jsonObject(with: body) as? [String: Any]
            if mode == .lostAck { throw URLError(.networkConnectionLost) }
            if mode == .rejected || mode == .untrustedRejection {
                status = 409
                value = ["error": "Fixture rejection", "requestStatus": "not_accepted", "errorCode": "staleEvidence",
                    "requestId": mode == .rejected ? acceptedBody!["requestId"]! : UUID().uuidString]
            } else { status = 202; value = task() }
        case ("GET", "/v1/tasks/phone-task"):
            reads += 1; value = task()
        case ("GET", "/v1/briefing"):
            value = ["devices": [], "tasks": [], "approvals": [], "phone": [:]]
        default: fatalError("Unexpected in-memory path \(path)")
        }
        return (try JSONSerialization.data(withJSONObject: value),
            HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
    }
    private func task() -> [String: Any] {
        var result: [String: Any] = ["id": "phone-task", "requestId": acceptedBody!["requestId"]!,
            "chatId": "chat", "deviceId": "mac", "status": mode == .running && !completed ? "running" : "completed",
            "prompt": "synthetic", "text": "Verified synthetic result", "createdAt": "now", "updatedAt": "now", "approvalStates": []]
        if mode != .omittedEcho, let target = acceptedBody?["executionTarget"] as? [String: Any] {
            var echo = target
            if mode == .changedEcho { echo["phoneId"] = "other-phone" }
            result["executionTarget"] = echo
        }
        return result
    }
}

@MainActor enum MirroringRecoveryScenarios {
    static func run() async throws {
        for mode in [MirroringRecoveryTransport.Mode.completed, .omittedEcho, .changedEcho, .rejected, .untrustedRejection] {
            let transport = MirroringRecoveryTransport(mode)
            let (model, defaults, suite) = try make(transport)
            defer { model.stoppedDisplaying(); defaults.removePersistentDomain(forName: suite) }
            precondition(model.submitVoiceRequest("Open Settings on my iPhone"))
            try await settle(model)
            let bodies = await transport.postBodies()
            precondition(bodies.count == 1, "Mode \(mode), status: \(model.status), error: \(model.errorMessage ?? "none")")
            let json = try JSONSerialization.jsonObject(with: bodies[0]) as! [String: Any]
            let target = json["executionTarget"] as! [String: String]
            precondition(target["phoneId"] == "phone" && target["leaseId"] == "lease")
            if mode == .completed { precondition(model.canPlayResult && model.canStartNewRequest) }
            else if mode == .rejected {
                precondition(!model.hasPreparedIdentity && !model.hasPendingTask && model.canStartNewRequest)
                precondition(model.errorMessage?.contains("Recheck iPhone Mirroring") == true)
            } else {
                precondition(model.hasPreparedIdentity && !model.canStartNewRequest && !model.canPlayResult)
                model.dismissRecovery(); precondition(!model.canStartNewRequest)
            }
        }
        let transport = MirroringRecoveryTransport(.lostAck)
        let (model, defaults, suite) = try make(transport)
        defer { model.stoppedDisplaying(); defaults.removePersistentDomain(forName: suite) }
        model.submitVoiceRequest("Open Settings on my iPhone"); try await settle(model)
        precondition(model.hasPreparedIdentity)
        model.dismissRecovery(); model.stoppedDisplaying()
        await transport.expire()
        let reopened = try build(defaults, transport)
        defer { reopened.stoppedDisplaying() }
        reopened.sendOrRetry(); try await settle(reopened)
        let bodies = await transport.postBodies()
        precondition(bodies.count == 2 && bodies[0] == bodies[1], "uncertain retry must keep exact UUID/text/old target lease")
        precondition(reopened.canPlayResult)
        await transport.changeEcho(); reopened.refresh(); try await settle(reopened)
        precondition(!reopened.canPlayResult && !reopened.canStartNewRequest, "changed target must not replace a saved result")

        let running = MirroringRecoveryTransport(.running)
        let (polling, pollingDefaults, pollingSuite) = try make(running)
        defer { polling.stoppedDisplaying(); pollingDefaults.removePersistentDomain(forName: pollingSuite) }
        polling.submitVoiceRequest("Open Settings on my iPhone"); try await settle(polling)
        await running.finish()
        for _ in 0..<400 where !polling.canPlayResult { try await Task.sleep(for: .milliseconds(10)) }
        precondition(polling.canPlayResult, "short action completion should be observed without the old eight-second poll delay")
        let reads = await running.taskReads()
        precondition(reads >= 1)
        print("PASS: phone target recovery, exact rejection proof, stale-lease UUID retry and fast status observation")
    }

    private static func make(_ transport: MirroringRecoveryTransport) throws -> (MacControlModel, UserDefaults, String) {
        let suite = "mirroring-recovery.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        return (try build(defaults, transport), defaults, suite)
    }
    private static func build(_ defaults: UserDefaults, _ transport: MirroringRecoveryTransport) throws -> MacControlModel {
        let config = try ProvidenceCoordinatorConfiguration.decodeAndValidate(Data(#"{"baseURL":"https://providence.hani.so","deviceId":"mac","chatId":"chat","iphoneMirroringTarget":{"deviceId":"mac","chatId":"chat","phoneId":"phone","phoneName":"Fixture iPhone"}}"#.utf8))
        let client = try CoordinatorClient(baseURL: config.baseURL, transport: transport, tokenProvider: ClosureBearerTokenProvider { "synthetic" })
        return MacControlModel(defaults: defaults, configuration: config, client: client)
    }
    private static func settle(_ model: MacControlModel) async throws {
        for _ in 0..<200 { if !model.busy { return }; try await Task.sleep(for: .milliseconds(5)) }
        preconditionFailure("Synthetic model did not settle")
    }
}
