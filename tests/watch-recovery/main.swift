import Foundation
import SwiftUI
import WatchCoordinatorAdapter

// This executable exercises the Watch model through the public coordinator
// client using only an in-memory transport. It never contacts Providence.
actor WatchRecoveryTransport: HTTPTransport {
    enum Mode { case completed, needsInput, lostSubmitAck, lostApprovalAck, malformedTask, malformedBriefing, completedWithPending, completedWorkNeedsInput, pausePost, pauseApprovalPost }
    private var mode: Mode
    private var postBodies: [Data] = []
    private var methods: [String] = []
    private var requestID = "00000000-0000-4000-8000-000000000000"
    private var transcriptionRequestID = ""
    private var pause: CheckedContinuation<Void, Never>?
    private var postPaused = false
    private var pauseNextTaskGet = false
    private var approvalStates: [[String: String]]?
    private var approvalStatesOverridden = false
    private var malformedBriefingAfter = false
    private var lagAfterApproval = false
    private let rootID = "task-root"
    private let approvalID = "approval-exact"

    init(_ mode: Mode) { self.mode = mode }
    func release() { pause?.resume(); pause = nil }
    func bodyCount() -> Int { postBodies.count }
    func postCount() -> Int { methods.filter { $0.hasPrefix("POST ") }.count }
    func bodies() -> [Data] { postBodies }
    func requestMethods() -> [String] { methods }
    func isPostPaused() -> Bool { postPaused }
    func pauseTaskGet() { pauseNextTaskGet = true }
    func setApprovalStates(_ states: [[String: String]]?) { approvalStates = states; approvalStatesOverridden = true }
    func failBriefing() { malformedBriefingAfter = true }
    func lagAcknowledgedApproval() { lagAfterApproval = true }
    func completeOnAnotherClient() {
        mode = .completed
        approvalStates = [["id": approvalID, "method": "item/commandExecution/requestApproval", "status": "resolved"]]
        approvalStatesOverridden = true
    }

    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let path = request.url!.path
        methods.append("\(request.httpMethod ?? "") \(path)")
        let object: Any
        switch (request.httpMethod, path) {
        case ("GET", "/v1/transcriptions"):
            object = ["transcription": ["available": true, "devices": [["id": "mac", "name": "Test Mac", "online": true, "configured": true]],
                "mimeTypes": ["audio/mp4"], "maxAudioBytes": 524288, "provider": "Synthetic"]]
        case ("POST", "/v1/transcriptions"):
            let fields = try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: String]
            transcriptionRequestID = fields["requestId"]!
            object = ["id": "11111111-1111-4111-8111-111111111111", "requestId": transcriptionRequestID,
                "deviceId": "mac", "status": "completed", "text": "Preserved exact transcript"]
        case ("GET", "/v1/devices"):
            object = ["devices": [["id": "mac", "name": "Test Mac", "local": true, "online": true,
                                     "connectionState": "online", "platform": "macos",
                                     "capabilities": ["desktop": true]]]]
        case ("GET", "/v1/chats"):
            object = ["chats": [["id": "chat", "name": "Test", "deviceId": "mac", "threadId": "thread", "online": true]]]
        case ("POST", "/v1/chats/chat/messages"):
            let body = request.httpBody!
            postBodies.append(body)
            let fields = try JSONSerialization.jsonObject(with: body) as! [String: Any]
            requestID = fields["requestId"] as! String
            if mode == .pausePost {
                postPaused = true
                await withCheckedContinuation { pause = $0 }
            }
            if mode == .lostSubmitAck { throw URLError(.networkConnectionLost) }
            if mode == .malformedTask { return response(request, data: Data("[]".utf8)) }
            object = task(status: needsInput ? "needs_input" : "completed")
        case ("GET", "/v1/tasks/task-root"):
            if pauseNextTaskGet { pauseNextTaskGet = false; postPaused = true; await withCheckedContinuation { pause = $0 } }
            object = task(status: needsInput ? "needs_input" : "completed")
        case ("GET", "/v1/briefing"):
            if mode == .malformedBriefing || malformedBriefingAfter { return response(request, data: Data("[]".utf8)) }
            let pending = needsInput || mode == .completedWithPending || mode == .completedWorkNeedsInput
            object = ["devices": [], "tasks": [], "phone": [:], "approvals": pending ? [approval()] : []]
        case ("POST", "/v1/approvals/approval-exact"):
            if mode == .pauseApprovalPost { postPaused = true; await withCheckedContinuation { pause = $0 } }
            if mode == .lostApprovalAck { throw URLError(.networkConnectionLost) }
            if !lagAfterApproval {
                approvalStates = [["id": approvalID, "method": "item/commandExecution/requestApproval", "status": "resolved"]]
                approvalStatesOverridden = true
            }
            return response(request, data: try JSONSerialization.data(withJSONObject: ["resolved": true]), status: 200)
        default:
            fatalError("Unexpected synthetic request: \(request.httpMethod ?? "") \(path)")
        }
        return response(request, data: try JSONSerialization.data(withJSONObject: object))
    }

    private func task(status: String) -> [String: Any] {
        var value: [String: Any] = ["id": rootID, "requestId": requestID, "chatId": "chat", "deviceId": "mac", "status": status,
         "prompt": "synthetic", "text": status == "completed" ? "Done." : "Need your decision.",
         "createdAt": "now", "updatedAt": "now", "childTaskIds": []]
        if mode == .completedWorkNeedsInput { value["workStatus"] = "needs_input" }
        if approvalStatesOverridden {
            if let approvalStates { value["approvalStates"] = approvalStates }
        } else if needsInput {
            value["approvalStates"] = [["id": approvalID, "method": "item/commandExecution/requestApproval", "status": "pending"]]
        }
        return value
    }
    private var needsInput: Bool { mode == .needsInput || mode == .lostApprovalAck || mode == .pauseApprovalPost }
    private func approval() -> [String: Any] {
        ["id": approvalID, "taskId": rootID, "deviceId": "mac", "method": "item/commandExecution/requestApproval",
         "details": ["command": "echo hi"], "status": "pending"]
    }
    private func response(_ request: URLRequest, data: Data, status: Int? = nil) -> (Data, HTTPURLResponse) {
        let code = status ?? (request.httpMethod == "POST" ? 202 : 200)
        return (data, HTTPURLResponse(url: request.url!, statusCode: code, httpVersion: nil, headerFields: nil)!)
    }
}

@main struct WatchRecoveryTests {
    @MainActor static func main() async throws {
        try await malformedBriefingIsReadable()
        try await malformedTaskIsReadable()
        try await exactRetryKeepsBody()
        try await exactApprovalIsActionable()
        try await successfulApprovalAcknowledgementReconciles()
        try await acknowledgedButLaggingApprovalCannotReplay()
        try await legacyApprovalStateBlocksWatchPost()
        try await lostApprovalAcknowledgementBlocksReplay()
        try await approvalStateReconciliationPreservesUncertainty()
        try await ownerFingerprintCannotReleaseAttempt()
        try await exactTerminalStatePrecedesBriefingFailure()
        try await completedPendingMismatchCannotPlayOrReplace()
        try await completedWorkNeedsInputMismatchCannotPlay()
        try await dismissalDropsPausedCallbacks()
        adapterNSErrorNeverLeaksDiagnostic()
        try await backgroundPostCannotReplaceSavedIdentity()
        try await completedFollowUpRetainsFrozenCapture()
        try await discardCompletedUnsubmittedRecording()
        try await unsupportedPreflightCanDismissAndStartOver()
        try await corruptReceiptBlocksNewRequest()
        try await externalApprovalSettlementIsObserved()
        try await DelegatedRecoveryScenarios.run()
        try await MirroringRecoveryScenarios.run()
        print("PASS: 19 watch recovery scenarios plus delegated/phone integration (exact identities, external approval settlement and safe dismissal)")
    }

    @MainActor private static func externalApprovalSettlementIsObserved() async throws {
        let (model, transport, _) = try make(.needsInput)
        defer { model.stoppedDisplaying() }
        model.submitVoiceRequest("Stage a harmless synthetic action")
        try await settle(model)
        require(model.pendingApproval != nil)
        await transport.completeOnAnotherClient()
        for _ in 0..<500 where !model.canPlayResult { try await Task.sleep(for: .milliseconds(10)) }
        require(model.canPlayResult && model.pendingApproval == nil)
        let methods = await transport.requestMethods()
        require(methods.contains("GET /v1/tasks/task-root"))
        require(!methods.contains(where: { $0.hasPrefix("POST /v1/approvals/") }), "external settlement must not generate a Watch approval POST")
    }

    @MainActor private static func completedFollowUpRetainsFrozenCapture() async throws {
        let (model, transport, _) = try make(.completed)
        model.submitVoiceRequest("open notes"); try await settle(model)
        require(model.isFinished && model.canPlayResult)
        require(model.beginVoiceCapture())
        model.newRequest(preservingVoiceCapture: true)
        require(!model.hasPendingTask && model.canPlayResult == false)
        model.submitVoiceRequest("open calendar"); try await settle(model)
        let bodies = await transport.bodies()
        require(bodies.count == 2, "Follow-up replaced the frozen capture instead of submitting one exact new request")
    }

    @MainActor private static func discardCompletedUnsubmittedRecording() async throws {
        let (model, transport, _) = try make(.completed)
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("watch-discard-\(UUID())")
        defer { try? FileManager.default.removeItem(at: directory) }
        let session = VoiceTranscriptionSession(directory: directory)
        require(model.beginVoiceCapture())
        let transcript = try await model.transcribe(Data([1, 2, 3]), session: session, purpose: "task")
        require(transcript == "Preserved exact transcript")
        require(model.canDiscardUnsubmittedRecording(session))
        require(model.discardUnsubmittedRecording(session) && !session.hasRecovery)
        require(model.beginVoiceCapture(), "Discarded recording should permit a new frozen request")
        model.submitVoiceRequest("open calendar"); try await settle(model)
        require(!(model.canDiscardUnsubmittedRecording(session)), "A task POST must make a recording non-discardable")
        let bodies = await transport.bodies()
        require(bodies.count == 1, "Discarding a local transcript must not submit work")
    }

    @MainActor private static func malformedTaskIsReadable() async throws {
        let (model, _, _) = try make(.malformedTask)
        model.submitVoiceRequest("open notes")
        try await settle(model)
        require(model.errorMessage?.contains("unreadable update") == true)
        require(!(model.errorMessage?.contains("CoordinatorClientError") ?? false))
        require(model.hasPreparedIdentity && model.canRetryPrepared)
    }

    @MainActor private static func malformedBriefingIsReadable() async throws {
        let (model, transport, _) = try make(.malformedBriefing)
        model.submitVoiceRequest("open notes")
        try await settle(model)
        require(model.errorMessage?.contains("unreadable update") == true)
        require(!(model.errorMessage?.contains("WatchCoordinatorAdapter") ?? false))
        require(!model.canPlayResult && model.needsRecovery)
        let before = await transport.bodyCount(); model.refresh(); try await settle(model)
        let after = await transport.bodyCount()
        require(after == before, "Checking status submitted a new request")
    }

    @MainActor private static func exactRetryKeepsBody() async throws {
        let (model, transport, defaults) = try make(.lostSubmitAck)
        model.submitVoiceRequest("open notes")
        try await settle(model)
        require(model.hasPreparedIdentity && model.canRetryPrepared && model.errorMessage?.contains("Outcome unknown") == true)
        model.dismissRecovery(); require(model.recoveryDismissed && model.hasPreparedIdentity)
        let reopened = try buildModel(defaults: defaults, transport: transport)
        reopened.showRecovery(); reopened.sendOrRetry(); try await settle(reopened)
        let bodies = await transport.bodies()
        require(bodies.count == 2 && bodies[0] == bodies[1], "Retry changed request identity or body")
    }

    @MainActor private static func exactApprovalIsActionable() async throws {
        let (model, transport, _) = try make(.needsInput)
        model.submitVoiceRequest("send hi")
        try await settle(model)
        guard let approval = model.pendingApproval else { fatalError("Missing exact pending approval") }
        require(approval.id == "approval-exact" && model.status.contains("decision"))
        let stale = try approvalRecord(id: "approval-stale", details: ["command": "echo different"])
        let before = await transport.postCount()
        model.resolve(stale, .accept); try await briefYield()
        let stillBefore = await transport.postCount()
        require(stillBefore == before, "Stale approval details were posted")
        model.resolve(approval, .accept); try await settle(model)
        let after = await transport.postCount()
        require(after == before + 1)
    }

    @MainActor private static func completedPendingMismatchCannotPlayOrReplace() async throws {
        let (model, _, _) = try make(.completedWithPending)
        model.submitVoiceRequest("send hi"); try await settle(model)
        require(model.approvalRecoveryMessage?.contains("disagree") == true)
        require(!model.canPlayResult && !model.canStartNewRequest && model.pendingApproval == nil)
        model.dismissRecovery()
        require(!model.canStartNewRequest, "Dismissal replaced a completed task with a stale approval")
    }

    @MainActor private static func successfulApprovalAcknowledgementReconciles() async throws {
        let (model, transport, _) = try make(.needsInput)
        model.submitVoiceRequest("send hi"); try await settle(model)
        guard let approval = model.pendingApproval else { fatalError("Missing approval") }
        model.resolve(approval, .accept); try await settle(model)
        require(!model.hasApprovalAttempt && model.errorMessage == nil)
        let posts = await transport.postCount()
        require(posts == 2, "Successful approval did not use exactly one approval POST")
        require(!model.status.lowercased().contains("sent"), "Approval acknowledgement claimed the requested action completed")
    }

    @MainActor private static func acknowledgedButLaggingApprovalCannotReplay() async throws {
        let (model, transport, defaults) = try make(.needsInput)
        await transport.lagAcknowledgedApproval()
        model.submitVoiceRequest("send hi"); try await settle(model)
        guard let approval = model.pendingApproval else { fatalError("Missing approval") }
        model.resolve(approval, .accept); try await settle(model)
        require(model.hasApprovalAttempt && model.pendingApproval == nil)
        model.dismissRecovery()
        let reopened = try buildModel(defaults: defaults, transport: transport)
        reopened.refresh(); try await settle(reopened)
        reopened.resolve(approval, .accept); try await briefYield()
        require(reopened.hasApprovalAttempt && reopened.pendingApproval == nil)
        let posts = await transport.postCount()
        require(posts == 2, "A lagging task read replayed an acknowledged approval")
    }

    @MainActor private static func legacyApprovalStateBlocksWatchPost() async throws {
        let (model, transport, _) = try make(.needsInput)
        await transport.setApprovalStates(nil) // Explicit old-server fixture: task has no authoritative states.
        model.submitVoiceRequest("send hi"); try await settle(model)
        require(model.pendingApproval == nil && model.approvalRecoveryMessage?.contains("Update Providence") == true)
        let posts = await transport.postCount()
        require(posts == 1, "Legacy approval state enabled a Watch approval POST")
        let stale = try approvalRecord(id: "approval-exact", details: ["command": "echo hi"])
        model.resolve(stale, .accept); try await briefYield()
        let after = await transport.postCount()
        require(after == posts && model.hasPendingTask && model.needsRecovery)
    }

    @MainActor private static func completedWorkNeedsInputMismatchCannotPlay() async throws {
        let (model, _, _) = try make(.completedWorkNeedsInput)
        model.submitVoiceRequest("send hi"); try await settle(model)
        require(model.approvalRecoveryMessage?.contains("disagree") == true)
        require(!model.canPlayResult && !model.canStartNewRequest && model.pendingApproval == nil)
    }

    @MainActor private static func lostApprovalAcknowledgementBlocksReplay() async throws {
        let (model, transport, defaults) = try make(.lostApprovalAck)
        model.submitVoiceRequest("send hi"); try await settle(model)
        guard let approval = model.pendingApproval else { fatalError("Missing approval") }
        model.resolve(approval, .accept); try await settle(model)
        require(model.hasApprovalAttempt && !model.canStartNewRequest)
        model.dismissRecovery()
        let reopened = try buildModel(defaults: defaults, transport: transport)
        require(reopened.hasApprovalAttempt && !reopened.canStartNewRequest && !reopened.canRetryPrepared)
        let count = await transport.postCount()
        reopened.sendOrRetry(); try await briefYield()
        let after = await transport.postCount()
        require(after == count, "Dismissal replayed an uncertain approval")
    }

    @MainActor private static func approvalStateReconciliationPreservesUncertainty() async throws {
        let (model, transport, defaults) = try make(.lostApprovalAck)
        model.submitVoiceRequest("send hi"); try await settle(model)
        guard let approval = model.pendingApproval else { fatalError("Missing approval") }
        model.resolve(approval, .accept); try await settle(model)
        require(model.hasApprovalAttempt)
        for states in [
            [["id": "approval-exact", "method": approval.method, "status": "resolving"]],
            nil,
            [["id": "approval-exact", "method": approval.method, "status": "future_state"]],
            [["id": "wrong-id", "method": approval.method, "status": "resolved"]],
            [["id": "approval-exact", "method": "different/method", "status": "resolved"]],
        ] as [[[String: String]]?] {
            await transport.setApprovalStates(states)
            model.showRecovery(); model.refresh(); try await settle(model)
            require(model.hasApprovalAttempt && !model.canStartNewRequest && !model.canRetryPrepared)
        }
        for terminal in ["resolved", "expired"] {
            await transport.setApprovalStates([["id": "approval-exact", "method": approval.method, "status": terminal]])
            model.showRecovery(); model.refresh(); try await settle(model)
            require(!model.hasApprovalAttempt, "Exact \(terminal) state did not release attempt")
            require(!(model.status.lowercased().contains("sent") || model.status.lowercased().contains("completed")), "Decision state claimed a send outcome")
            // Recreate the uncertain marker for the next terminal state without a second POST.
            if terminal == "resolved" {
                guard let owner = model.task else { fatalError("Lost task identity") }
                let encoded = try JSONEncoder().encode(WatchApprovalAttempt(root: owner, owner: owner, approval: approval))
                // The isolated suite supplies the same persisted crash-recovery
                // receipt written before the original POST boundary.
                defaults.set(encoded, forKey: "macControl.approvalAttempt")
            }
        }
    }

    @MainActor private static func ownerFingerprintCannotReleaseAttempt() async throws {
        let (model, transport, defaults) = try make(.lostApprovalAck)
        model.submitVoiceRequest("send hi"); try await settle(model)
        guard let approval = model.pendingApproval, let owner = model.task else { fatalError("Missing approval identity") }
        model.resolve(approval, .accept); try await settle(model)
        let valid = try JSONEncoder().encode(WatchApprovalAttempt(root: owner, owner: owner, approval: approval))
        var tampered = try JSONSerialization.jsonObject(with: valid) as! [String: Any]
        tampered["ownerDeviceID"] = "different-mac"
        defaults.set(try JSONSerialization.data(withJSONObject: tampered), forKey: "macControl.approvalAttempt")
        await transport.setApprovalStates([["id": approval.id, "method": approval.method, "status": "resolved"]])
        let before = await transport.postCount(); model.showRecovery(); model.refresh(); try await settle(model)
        let after = await transport.postCount()
        require(model.hasApprovalAttempt && model.approvalRecoveryMessage?.contains("unknown") == true && after == before)
    }

    @MainActor private static func exactTerminalStatePrecedesBriefingFailure() async throws {
        let (model, transport, _) = try make(.lostApprovalAck)
        model.submitVoiceRequest("send hi"); try await settle(model)
        guard let approval = model.pendingApproval else { fatalError("Missing approval") }
        model.resolve(approval, .accept); try await settle(model)
        await transport.setApprovalStates([["id": approval.id, "method": approval.method, "status": "resolved"]])
        await transport.failBriefing()
        let before = await transport.postCount(); model.showRecovery(); model.refresh(); try await settle(model)
        let after = await transport.postCount()
        require(!model.hasApprovalAttempt && model.errorMessage?.contains("unreadable update") == true && after == before)
    }

    @MainActor private static func dismissalDropsPausedCallbacks() async throws {
        let (model, transport, _) = try make(.pauseApprovalPost)
        model.submitVoiceRequest("send hi"); try await settle(model)
        guard let approval = model.pendingApproval else { fatalError("Missing approval") }
        model.resolve(approval, .accept); model.resolve(approval, .accept)
        try await waitUntil { await transport.isPostPaused() }
        let postCount = await transport.postCount(); require(postCount == 2, "Repeated approval taps made multiple POSTs")
        model.dismissRecovery(); await transport.release(); try await briefYield()
        require(model.hasApprovalAttempt && model.recoveryDismissed && model.pendingApproval == nil)

        let (checking, checkTransport, _) = try make(.lostApprovalAck)
        checking.submitVoiceRequest("send hi"); try await settle(checking)
        guard let pending = checking.pendingApproval else { fatalError("Missing approval") }
        checking.resolve(pending, .accept); try await settle(checking)
        await checkTransport.pauseTaskGet()
        checking.showRecovery(); checking.refresh()
        try await waitUntil { await checkTransport.isPostPaused() }
        checking.dismissRecovery(); await checkTransport.release(); try await briefYield()
        require(checking.hasApprovalAttempt && checking.recoveryDismissed && checking.pendingApproval == nil,
                "Dismissal during status check lost the uncertain approval marker")
    }

    private static func adapterNSErrorNeverLeaksDiagnostic() {
        let typed = CoordinatorClientError.malformedResponse(endpoint: "/v1/tasks/synthetic", description: "synthetic decode failure")
        require((typed as NSError).code == 1 && typed.localizedDescription.contains("CoordinatorClientError"),
                "The photo-shaped adapter error was not reproduced on this toolchain")
        require(WatchRecoveryPresentation.message(for: typed).contains("unreadable update"))
        let raw = NSError(domain: "WatchCoordinatorAdapter.CoordinatorClientError", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "private server body: token=secret"])
        let displayed = WatchRecoveryPresentation.message(for: raw)
        require(!displayed.contains("WatchCoordinatorAdapter") && !displayed.contains("token=secret"))
    }

    @MainActor private static func backgroundPostCannotReplaceSavedIdentity() async throws {
        let (model, transport, defaults) = try make(.pausePost)
        model.submitVoiceRequest("open notes")
        try await waitUntil { await transport.isPostPaused() }
        model.sceneChanged(.background)
        await transport.release()
        try await briefYield()
        require(model.hasPreparedIdentity && !model.hasPendingTask, "Late POST acknowledgement replaced saved recovery identity")
        let reopened = try buildModel(defaults: defaults, transport: transport)
        require(reopened.hasPreparedIdentity && reopened.canRetryPrepared)
    }

    @MainActor private static func unsupportedPreflightCanDismissAndStartOver() async throws {
        let (model, transport, _) = try make(.completed)
        model.submitVoiceRequest("call my phone")
        try await settle(model)
        require(model.errorMessage?.contains("Phone calls are not available") == true && !model.hasPreparedIdentity)
        let posts = await transport.bodyCount()
        require(posts == 0)
        model.dismissRecovery(); model.newRequest()
        require(model.canStartNewRequest && model.text.isEmpty && !model.needsRecovery)
    }

    @MainActor private static func corruptReceiptBlocksNewRequest() async throws {
        let (_, _, defaults) = try make(.completed)
        defaults.set(Data("not json".utf8), forKey: "macControl.preparedRequest")
        let reopened = try buildModel(defaults: defaults, transport: WatchRecoveryTransport(.completed))
        require(reopened.hasPreparedIdentity && !reopened.canStartNewRequest && !reopened.canRetryPrepared)
        reopened.dismissRecovery()
        require(reopened.hasPreparedIdentity && !reopened.canStartNewRequest)
    }

    @MainActor private static func make(_ mode: WatchRecoveryTransport.Mode) throws -> (MacControlModel, WatchRecoveryTransport, UserDefaults) {
        let transport = WatchRecoveryTransport(mode)
        let defaults = UserDefaults(suiteName: "watch-recovery.\(UUID().uuidString)")!
        return (try buildModel(defaults: defaults, transport: transport), transport, defaults)
    }
    @MainActor private static func buildModel(defaults: UserDefaults, transport: WatchRecoveryTransport) throws -> MacControlModel {
        let configuration = try ProvidenceCoordinatorConfiguration.decodeAndValidate(Data("{\"baseURL\":\"https://providence.hani.so/\",\"deviceId\":\"mac\",\"chatId\":\"chat\"}".utf8))
        let client = try CoordinatorClient(baseURL: configuration.baseURL, transport: transport, tokenProvider: ClosureBearerTokenProvider { "synthetic" })
        return MacControlModel(defaults: defaults, configuration: configuration, client: client)
    }
    private static func approvalRecord(id: String, details: [String: String]) throws -> CoordinatorApproval {
        let value: [String: Any] = ["id": id, "taskId": "task-root", "deviceId": "mac",
                                    "method": "item/commandExecution/requestApproval", "details": details, "status": "pending"]
        return try JSONDecoder().decode(CoordinatorApproval.self, from: JSONSerialization.data(withJSONObject: value))
    }
    @MainActor private static func settle(_ model: MacControlModel) async throws {
        for _ in 0..<100 { if !model.busy { return }; try await Task.sleep(nanoseconds: 10_000_000) }
        throw NSError(domain: "WatchRecoveryTests", code: 1, userInfo: [NSLocalizedDescriptionKey: "Timed out waiting for synthetic work"])
    }
    @MainActor private static func briefYield() async throws { try await Task.sleep(nanoseconds: 20_000_000) }
    @MainActor private static func waitUntil(_ condition: @escaping () async -> Bool) async throws {
        for _ in 0..<100 { if await condition() { return }; try await Task.sleep(nanoseconds: 10_000_000) }
        throw NSError(domain: "WatchRecoveryTests", code: 1, userInfo: [NSLocalizedDescriptionKey: "Timed out waiting for synthetic work"])
    }
}

private func require(_ condition: @autoclosure () -> Bool, _ message: String = "requirement failed", line: Int = #line) {
    precondition(condition(), "\(message) at test line \(line)")
}
