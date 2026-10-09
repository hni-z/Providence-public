import Foundation
import SwiftUI
import WatchCoordinatorAdapter

/// Three registered computers, recorded entirely in memory.  This is deliberately
/// a model-level harness: no sockets, credentials, pairing, or installed Watch.
actor WorkflowTransport: HTTPTransport {
    struct Request: Sendable { let method: String; let path: String; let body: Data? }
    enum Reply { case normal, lostAcknowledgement, workflowMismatch, transcriptionRejected, malformedCatalog, historicalChat }
    private var reply: Reply = .normal
    private var requests: [Request] = []
    private var accepted: [String: Data] = [:]
    private let devices = ["research", "analysis", "presentation"]

    func setReply(_ value: Reply) { reply = value }
    func recorded() -> [Request] { requests }
    func clear() { requests = [] }

    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let path = request.url!.path
        let method = request.httpMethod ?? ""
        requests.append(Request(method: method, path: path, body: request.httpBody))
        switch (method, path) {
        case ("GET", "/v1/devices"):
            if reply == .malformedCatalog { return json(request, []) }
            return json(request, ["devices": devices.map { ["id": $0, "name": $0, "local": false, "online": true, "connectionState": "online", "platform": "macos", "capabilities": [:]] }])
        case ("GET", "/v1/chats"):
            var chats: [[String: Any]] = devices.map { ["id": "\($0)-chat", "name": "\($0) chat", "deviceId": $0, "threadId": "\($0)-thread", "online": true] }
            if reply == .historicalChat {
                chats.append(["id": "old-chat", "name": "Retained history", "deviceId": "retired-computer", "threadId": "old-thread", "online": true])
            }
            return json(request, ["chats": chats])
        case ("GET", "/v1/transcriptions"):
            return json(request, ["transcription": ["available": reply != .transcriptionRejected, "devices": [["id": "research", "name": "research", "online": true, "configured": true]], "mimeTypes": ["audio/mp4"], "maxAudioBytes": 524288, "provider": "synthetic"]])
        case ("POST", "/v1/transcriptions"):
            if reply == .transcriptionRejected { return json(request, ["error": "rejected"], status: 400) }
            let body = try fields(request)
            return json(request, ["id": "11111111-1111-4111-8111-111111111111", "requestId": body["requestId"]!, "deviceId": "research", "status": "completed", "text": "real synthetic STT"], status: 202)
        case ("POST", "/v1/messages"):
            let body = try fields(request)
            let id = body["requestId"] as! String
            if accepted[id] == nil { accepted[id] = request.httpBody! }
            if reply == .lostAcknowledgement { throw URLError(.networkConnectionLost) }
            return task(request, requestID: id, workflow: body["workflow"] as? [String: Any])
        case ("POST", let direct) where direct.hasPrefix("/v1/chats/") && direct.hasSuffix("/messages"):
            let body = try fields(request); let id = body["requestId"] as! String
            if accepted[id] == nil { accepted[id] = request.httpBody! }
            if reply == .lostAcknowledgement { throw URLError(.networkConnectionLost) }
            let chat = direct.split(separator: "/")[2]
            return task(request, requestID: id, chatID: String(chat), deviceID: String(chat.dropLast(5)))
        case ("GET", let taskPath) where taskPath.hasPrefix("/v1/tasks/"):
            return task(request, requestID: "00000000-0000-4000-8000-000000000000", chatID: "research-chat", deviceID: "research")
        case ("GET", "/v1/briefing"):
            return json(request, ["devices": [], "tasks": [], "phone": [:], "approvals": []])
        default: fatalError("unexpected synthetic request \(method) \(path)")
        }
    }

    private func task(_ request: URLRequest, requestID: String, chatID: String = "master", deviceID: String = "coordinator", workflow: [String: Any]? = nil) -> (Data, HTTPURLResponse) {
        var object: [String: Any] = ["id": "root-\(requestID)", "requestId": requestID, "chatId": chatID, "deviceId": deviceID, "status": "completed", "prompt": "synthetic", "text": "done", "createdAt": "now", "updatedAt": "now", "childTaskIds": []]
        if let workflow {
            object["workflow"] = reply == .workflowMismatch ? ["version": 1, "bindings": workflow["bindings"]!] : workflow
            if reply == .workflowMismatch {
                object["workflow"] = ["version": 1, "bindings": [["role": "research", "deviceId": "presentation", "chatId": "presentation-chat"], ["role": "analysis", "deviceId": "analysis", "chatId": "analysis-chat"], ["role": "presentation", "deviceId": "research", "chatId": "research-chat"]]]
            }
        }
        return json(request, object, status: 202)
    }
    private func fields(_ request: URLRequest) throws -> [String: Any] { try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: Any] }
    private func json(_ request: URLRequest, _ object: Any, status: Int = 200) -> (Data, HTTPURLResponse) {
        (try! JSONSerialization.data(withJSONObject: object), HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!)
    }
}

@main struct WatchWorkflowTests {
    static func main() async throws {
        try await directRoutePostsOnlyExactChat()
        try await workflowAdmissionAndFrozenCapture()
        try await lockedTargetRejectsExplicitWorkflowSpeech()
        try await rejectedAndOfflineRoutesDoNotAdmit()
        try await historicalChatDoesNotBlockRecording()
        try await retryAndMismatchStaySafe()
        try await completedTaskCanSubmitFrozenFollowUp()
        try await rejectedWorkflowSpeechKeepsCompletedSTTRecoverable()
        try await transcriptionAndFollowUpAreNotSticky()
        print("Watch workflow integration passed: direct routing, frozen manifests, admission guards, retry identity, mismatch and voice recovery.")
    }

    @MainActor private static func directRoutePostsOnlyExactChat() async throws {
        let (model, transport, _) = try make()
        await model.refreshTargetCatalog()
        let research = try option(model, "research")
        model.selectLockedTarget(research)
        require(model.submitVoiceRequest("open Notes")); try await settle(model)
        let posts = await transport.recorded().filter { $0.method == "POST" }
        require(posts.count == 1 && posts[0].path == "/v1/chats/research-chat/messages")
        let body = try decode(posts[0]); require(body["workflow"] == nil && (body["text"] as? String)?.hasSuffix("open Notes") == true)
    }

    @MainActor private static func workflowAdmissionAndFrozenCapture() async throws {
        let (model, transport, defaults) = try make()
        await model.refreshTargetCatalog()
        for role in CoordinatorWorkflowRole.allCases { model.setWorkflowTarget(try option(model, role.rawValue), for: role) }
        require(model.selectWorkflowMode())
        require(model.beginVoiceCapture())
        let frozenIDs = CoordinatorWorkflowRole.allCases.map { model.workflowTargetID(for: $0)! }
        await transport.setReply(.lostAcknowledgement)
        require(model.submitVoiceRequest("compare findings")); try await settle(model)
        let posts = await transport.recorded().filter { $0.method == "POST" }
        require(posts.count == 1 && posts[0].path == "/v1/messages")
        let first = try decode(posts[0]); let workflow = first["workflow"] as? [String: Any]
        require((workflow?["bindings"] as? [[String: Any]])?.map { $0["deviceId"] as? String } == ["research", "analysis", "presentation"])
        require(model.workflowMode, "uncertain workflow admission cleared the selected mode")
        model.selectVoiceTarget()
        let pending = model.preparedRequest
        require(pending?.requestID.uuidString.lowercased() == first["requestId"] as? String && pending?.workflow != nil)
        let reopened = try build(defaults, transport)
        require(reopened.preparedRequest?.workflow?.bindings.map(\.deviceID) == ["research", "analysis", "presentation"])
        require(frozenIDs == ["research:research-chat", "analysis:analysis-chat", "presentation:presentation-chat"])

        let (voiceModel, voiceTransport, _) = try make()
        await voiceModel.refreshTargetCatalog()
        for role in CoordinatorWorkflowRole.allCases { voiceModel.setWorkflowTarget(try option(voiceModel, role.rawValue), for: role) }
        require(voiceModel.beginVoiceCapture())
        await voiceTransport.setReply(.lostAcknowledgement)
        require(voiceModel.submitVoiceRequest("use all three computers to prepare the brief")); try await settle(voiceModel)
        let voicePosts = await voiceTransport.recorded().filter { $0.method == "POST" }
        let voiceBody = try decode(try requireValue(voicePosts.first))
        require(voicePosts.count == 1 && voicePosts[0].path == "/v1/messages" && voiceBody["workflow"] != nil,
                "explicit workflow speech did not use the roster captured before speech")

        let (ackModel, _, _) = try make()
        await ackModel.refreshTargetCatalog()
        for role in CoordinatorWorkflowRole.allCases { ackModel.setWorkflowTarget(try option(ackModel, role.rawValue), for: role) }
        require(ackModel.selectWorkflowMode() && ackModel.submitVoiceRequest("acknowledged workflow")); try await settle(ackModel)
        require(!ackModel.workflowMode, "exact workflow acknowledgement did not reset one-shot mode")
    }

    @MainActor private static func lockedTargetRejectsExplicitWorkflowSpeech() async throws {
        let (model, transport, _) = try make()
        await model.refreshTargetCatalog(); model.selectLockedTarget(try option(model, "research"))
        require(model.submitVoiceRequest("use all three computers to make a brief")); try await settle(model)
        let posts = await transport.recorded().filter { $0.method == "POST" }
        require(posts.isEmpty && model.errorMessage?.contains("workflow") == true,
                "locked direct target admitted an explicit three-computer workflow")
    }

    @MainActor private static func rejectedAndOfflineRoutesDoNotAdmit() async throws {
        let (model, transport, _) = try make()
        await model.refreshTargetCatalog(); model.selectLockedTarget(try option(model, "research"))
        // Refresh preserves a catalog only while the selected exact pair remains online.
        await transport.clear(); model.selectVoiceTarget(); model.selectLockedTarget(WatchTargetOption(id: "bad:bad-chat", deviceID: "bad", chatID: "bad-chat", deviceName: "bad", chatName: "bad", online: false))
        require(!model.beginVoiceCapture())
        let requests = await transport.recorded()
        require(requests.filter { $0.method == "POST" }.isEmpty)

        let (malformed, malformedTransport, _) = try make()
        await malformedTransport.setReply(.malformedCatalog)
        await malformed.refreshTargetCatalog()
        require(malformed.beginVoiceCapture(), "optional catalog error blocked voice capture")
        require(malformed.submitVoiceRequest("explain this idea")); try await settle(malformed)
        let malformedRequests = await malformedTransport.recorded()
        require(malformedRequests.filter { $0.method == "POST" }.isEmpty)
        require(!malformed.voiceHandoffComplete && malformed.preparedRequest == nil,
                "failed fresh routing was treated as submitted")
    }

    @MainActor private static func historicalChatDoesNotBlockRecording() async throws {
        let (model, transport, defaults) = try make()
        await transport.setReply(.historicalChat)
        await model.refreshTargetCatalog()
        require(model.targetCatalogError == nil && model.targetOptions.count == 4)
        model.selectLockedTarget(try option(model, "research"))
        require(model.beginVoiceCapture(), "unrelated orphan blocked the valid explicit target")
        model.cancelVoiceCapture()
        let retired = try option(model, "retired-computer")
        require(!retired.online, "an orphan conversation was falsely made available")
        model.selectLockedTarget(retired)
        require(!model.beginVoiceCapture() && model.lockedTargetID == retired.id,
                "unavailable explicit target silently fell back")
        let reopened = try build(defaults, transport)
        await reopened.refreshTargetCatalog()
        require(!reopened.beginVoiceCapture() && reopened.lockedTargetID == retired.id)
        reopened.selectVoiceTarget()
        require(reopened.beginVoiceCapture())
        require(reopened.submitVoiceRequest("explain this idea")); try await settle(reopened)
        let actions = await transport.recorded().filter { $0.method == "POST" }
        require(actions.count == 1 && actions[0].path == "/v1/chats/research-chat/messages",
                "voice request did not preserve its configured default route")
    }

    @MainActor private static func retryAndMismatchStaySafe() async throws {
        let (model, transport, _) = try make()
        await model.refreshTargetCatalog(); model.selectLockedTarget(try option(model, "research"))
        await transport.setReply(.lostAcknowledgement)
        require(model.submitVoiceRequest("same exact request")); try await settle(model)
        let one = try decode((await transport.recorded()).first { $0.method == "POST" }!)
        model.sendOrRetry(); try await settle(model)
        let posts = (await transport.recorded()).filter { $0.method == "POST" }
        let two = try decode(posts[1])
        require(posts.count == 2 && two["requestId"] as? String == one["requestId"] as? String && two["text"] as? String == one["text"] as? String && two["workflow"] == nil, "retry changed request UUID/text/manifest")
        let (workflow, mismatchTransport, _) = try make(); await workflow.refreshTargetCatalog()
        await mismatchTransport.setReply(.workflowMismatch)
        for role in CoordinatorWorkflowRole.allCases { workflow.setWorkflowTarget(try option(workflow, role.rawValue), for: role) }
        require(workflow.selectWorkflowMode() && workflow.submitVoiceRequest("workflow result")); try await settle(workflow)
        require(workflow.result == nil && workflow.errorMessage?.contains("different workflow") == true)
        let mismatchRequests = await mismatchTransport.recorded()
        require(mismatchRequests.filter { $0.path == "/v1/messages" }.count == 1)
    }

    @MainActor private static func transcriptionAndFollowUpAreNotSticky() async throws {
        let (model, transport, defaults) = try make()
        await model.refreshTargetCatalog(); model.selectLockedTarget(try option(model, "research"))
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("watch-workflow-\(UUID())", isDirectory: true)
        let session = VoiceTranscriptionSession(directory: directory, pollingTimeout: 0)
        let transcript = try await model.transcribe(Data([1, 2, 3]), session: session, purpose: "task")
        let initialTranscription = try transcriptionRequestID(await transport.recorded())
        require(transcript == "real synthetic STT" && model.submitVoiceRequest(transcript)); try await settle(model)
        require(model.isFinished, "completed direct task was not reconciled: \(model.errorMessage ?? model.status)")
        model.newRequest(); require(model.beginVoiceCapture()); model.cancelVoiceCapture(); model.selectVoiceTarget()
        require(model.usesVoiceTarget, "cancelled capture left a target sticky")
        await transport.setReply(.transcriptionRejected)
        let fresh = VoiceTranscriptionSession(directory: directory.appendingPathComponent("reject"), pollingTimeout: 0)
        require(model.beginVoiceCapture())
        let rejectedIdentity = try frozenTranscriptionRequestID(defaults)
        do { _ = try await model.transcribe(Data([1]), session: fresh, purpose: "task"); preconditionFailure("rejected transcription succeeded") } catch { }
        require(defaults.data(forKey: "macControl.voiceCapture") == nil,
                "preflight rejection retained an unowned frozen capture")
        require(model.beginVoiceCapture(), "preflight rejection without a durable receipt blocked a fresh recording")
        let freshIdentity = try frozenTranscriptionRequestID(defaults)
        require(freshIdentity != rejectedIdentity && freshIdentity != initialTranscription,
                "preflight transcription rejection reused its frozen capture identity")
    }

    @MainActor private static func completedTaskCanSubmitFrozenFollowUp() async throws {
        let (model, transport, defaults) = try make()
        await model.refreshTargetCatalog(); model.selectLockedTarget(try option(model, "research"))
        require(model.submitVoiceRequest("first completed request")); try await settle(model)
        require(model.isFinished, "first direct request did not finish: \(model.errorMessage ?? model.status)")
        require(model.beginVoiceCapture())
        let frozenRequestID = try frozenActionRequestID(defaults)
        require(model.submitVoiceRequest("new follow-up text")); try await settle(model)
        let posts = await transport.recorded().filter { $0.method == "POST" && $0.path == "/v1/chats/research-chat/messages" }
        require(posts.count == 2, "finished task did not admit exactly one follow-up POST")
        let followUp = try decode(posts[1])
        require((followUp["requestId"] as? String)?.lowercased() == frozenRequestID.lowercased(),
                "follow-up changed the frozen action UUID")
        require((followUp["text"] as? String)?.hasSuffix("new follow-up text") == true,
                "follow-up did not carry the current spoken text")
    }

    @MainActor private static func rejectedWorkflowSpeechKeepsCompletedSTTRecoverable() async throws {
        let (model, transport, _) = try make()
        await model.refreshTargetCatalog(); model.selectLockedTarget(try option(model, "research"))
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("watch-workflow-reject-\(UUID())", isDirectory: true)
        let session = VoiceTranscriptionSession(directory: directory, pollingTimeout: 0)
        let transcript = try await model.transcribe(Data([7, 8, 9]), session: session, purpose: "task")
        require(model.submitVoiceRequest("use all three computers \(transcript)")); try await settle(model)
        let actions = await transport.recorded().filter { $0.method == "POST" && $0.path.hasSuffix("/messages") }
        require(actions.isEmpty && !model.voiceHandoffComplete,
                "rejected route consumed STT or crossed the action POST boundary")
        require(model.canDiscardUnsubmittedRecording(session), "completed STT lost its discard path after route rejection")
        require(model.discardUnsubmittedRecording(session), "matching unsubmitted STT receipt could not be discarded")
    }

    @MainActor private static func make() throws -> (MacControlModel, WorkflowTransport, UserDefaults) {
        let defaults = UserDefaults(suiteName: "watch-workflow.\(UUID().uuidString)")!
        let transport = WorkflowTransport()
        return (try build(defaults, transport), transport, defaults)
    }
    @MainActor private static func build(_ defaults: UserDefaults, _ transport: WorkflowTransport) throws -> MacControlModel {
        let config = try ProvidenceCoordinatorConfiguration.decodeAndValidate(Data("{\"baseURL\":\"https://providence.hani.so/\",\"deviceId\":\"research\",\"chatId\":\"research-chat\",\"transcriptionDeviceId\":\"research\"}".utf8))
        let client = try CoordinatorClient(baseURL: config.baseURL, transport: transport, tokenProvider: ClosureBearerTokenProvider { "synthetic" })
        return MacControlModel(defaults: defaults, configuration: config, client: client)
    }
    @MainActor private static func option(_ model: MacControlModel, _ id: String) throws -> WatchTargetOption { try requireValue(model.targetOptions.first { $0.deviceID == id }) }
    private static func decode(_ request: WorkflowTransport.Request) throws -> [String: Any] { try JSONSerialization.jsonObject(with: request.body!) as! [String: Any] }
    private static func transcriptionRequestID(_ requests: [WorkflowTransport.Request]) throws -> String {
        let request = try requireValue(requests.first { $0.method == "POST" && $0.path == "/v1/transcriptions" })
        return try requireValue(try decode(request)["requestId"] as? String)
    }
    private static func frozenTranscriptionRequestID(_ defaults: UserDefaults) throws -> String {
        let data = try requireValue(defaults.data(forKey: "macControl.voiceCapture"))
        let value = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        let identity = try requireValue(value["identity"] as? [String: Any])
        return try requireValue(identity["transcriptionRequestID"] as? String)
    }
    private static func frozenActionRequestID(_ defaults: UserDefaults) throws -> String {
        let data = try requireValue(defaults.data(forKey: "macControl.voiceCapture"))
        let value = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        let identity = try requireValue(value["identity"] as? [String: Any])
        return try requireValue(identity["actionRequestID"] as? String)
    }
    @MainActor private static func settle(_ model: MacControlModel) async throws { for _ in 0..<100 { if !model.busy { return }; try await Task.sleep(nanoseconds: 10_000_000) }; throw NSError(domain: "workflow", code: 1) }
}

private func require(_ condition: @autoclosure () -> Bool, _ message: String = "requirement failed", line: Int = #line) { precondition(condition(), "\(message) at line \(line)") }
private func requireValue<T>(_ value: T?, line: Int = #line) throws -> T { guard let value else { throw NSError(domain: "workflow", code: line) }; return value }
