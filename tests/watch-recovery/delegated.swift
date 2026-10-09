import Foundation
import SwiftUI
import WatchCoordinatorAdapter

/// Task-family recovery through the real client/model with no network or send surface.
@MainActor enum DelegatedRecoveryScenarios {
    static func run() async throws {
        try await settlementMustBelongToExactChild("resolved")
        try await settlementMustBelongToExactChild("expired")
        try await settlementMustBelongToExactChild("resolved", coordinated: true)
        try await settlementMustBelongToExactChild("expired", coordinated: true)
        try await coordinatedSubmissionRetryIsExact()
        print("PASS: direct/coordinated delegated approval recovery and exact master retry (opaque child IDs, no replay)")
    }

    private static func settlementMustBelongToExactChild(_ terminal: String, coordinated: Bool = false) async throws {
        let suite = "delegated-recovery.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let transport = DelegatedRecoveryTransport(coordinated: coordinated)
        let original = try model(defaults, transport)
        original.submitVoiceRequest(coordinated ? "Coordinate across my computers: prepare, validate, and assemble the demo." : "send hi")
        try await settle(original)
        guard let approval = original.pendingApproval else { throw Failure("Child approval was not presented") }
        try check(approval.taskID == "child-owner", "Approval belonged to the parent or sibling")
        original.resolve(approval, .accept)
        try await settle(original)
        try check(original.hasApprovalAttempt, "Lost child acknowledgement lost the durable marker")
        guard let receipt = defaults.data(forKey: "macControl.approvalAttempt") else { throw Failure("No saved receipt") }
        let attempt = try JSONDecoder().decode(WatchApprovalAttempt.self, from: receipt)
        try check(attempt.rootTaskID == "parent-root" && attempt.taskID == "child-owner", "Root/owner identities were conflated")
        try check(attempt.rootRequestID != attempt.ownerRequestID && attempt.rootChatID != attempt.ownerChatID,
                  "Fixture did not establish distinct parent and owner fingerprints")

        original.dismissRecovery()
        original.sceneChanged(.background)
        let reopened = try model(defaults, transport)
        defer { reopened.sceneChanged(.background) }
        try check(reopened.hasApprovalAttempt && !reopened.canStartNewRequest && !reopened.canRetryPrepared,
                  "Reopening released an uncertain child decision")
        reopened.resolve(approval, .accept)
        reopened.sendOrRetry()
        try await settle(reopened)
        try await assertSinglePost(transport)

        // A root or sibling's similarly named settled record cannot substitute
        // for the child which owns the submitted approval.
        await transport.setStates(owner: states("resolving"), root: states("resolved"), sibling: states("expired"))
        try await checkStillBlocked(reopened, transport)
        for unsafe in [nil, [], states("future_state"), states("resolved", id: "other-approval"),
                       states("resolved", method: "different/method")] as [[[String: String]]?] {
            await transport.setStates(owner: unsafe, root: states("resolved"), sibling: states("resolved"))
            try await checkStillBlocked(reopened, transport)
        }
        await transport.setStates(owner: states("resolved"), root: [], sibling: [])
        await transport.includeOwner(false)
        try await checkStillBlocked(reopened, transport)
        await transport.includeOwner(true)

        // A real state on the right ID is still insufficient if either saved
        // root or owner fingerprint no longer matches the observed task family.
        let fingerprints = [
            "rootTaskID": "other-root", "rootRequestID": "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
            "rootDeviceID": "other-root-mac", "rootChatID": "other-root-chat",
            "taskID": "sibling-task", "ownerRequestID": "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB",
            "ownerDeviceID": "other-child-mac", "ownerChatID": "other-child-chat",
        ]
        for (key, value) in fingerprints {
            var changed = try JSONSerialization.jsonObject(with: receipt) as! [String: Any]
            changed[key] = value
            defaults.set(try JSONSerialization.data(withJSONObject: changed), forKey: "macControl.approvalAttempt")
            try await checkStillBlocked(reopened, transport)
        }

        defaults.set(receipt, forKey: "macControl.approvalAttempt")
        await transport.setStates(owner: states("resolving"), root: [], sibling: [])
        try await checkStillBlocked(reopened, transport)
        await transport.setStates(owner: states(terminal), root: [], sibling: [], ownerStatus: terminal == "resolved" ? "running" : "interrupted")
        reopened.showRecovery(); reopened.refresh(); try await settle(reopened)
        try check(!reopened.hasApprovalAttempt, "Exact child \(terminal) state did not release the marker")
        try check(!reopened.status.lowercased().contains("sent"), "Decision settlement claimed a message was sent")
        try await assertSinglePost(transport)
    }

    private static func coordinatedSubmissionRetryIsExact() async throws {
        for text in ["Coordinate across my computers: make a report", "  COORDINATE across our connected computers: check it"] {
            try check(WatchCoordinationIntent.isExplicit(text), "Explicit orchestration was not recognized")
        }
        for text in ["Message him coordinate across my computers", "Do not coordinate across my computers", "Explain how to coordinate across my computers", "Open a page on my Mac"] {
            try check(!WatchCoordinationIntent.isExplicit(text), "Ordinary request was silently changed to a master request")
        }
        let suite = "coordinated-retry.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let transport = DelegatedRecoveryTransport(coordinated: true, loseFirstSubmission: true)
        let original = try model(defaults, transport)
        original.submitVoiceRequest("Coordinate across my computers: prepare, validate, then assemble.")
        try await settle(original)
        try check(original.hasPreparedIdentity && original.preparedRequest?.coordinated == true, "Lost master reply lost the intended route")
        original.dismissRecovery(); original.stoppedDisplaying()
        let reopened = try model(defaults, transport)
        defer { reopened.stoppedDisplaying() }
        reopened.sendOrRetry(); try await settle(reopened)
        let requests = await transport.submissions()
        try check(requests.count == 2 && requests[0].path == "/v1/messages" && requests[0].body == requests[1].body,
                  "Master recovery changed the endpoint, UUID or request body")
        try check(reopened.pendingApproval?.taskID == "child-owner" && !reopened.canPlayResult,
                  "Master planner completion hid unfinished child work")
        await transport.setStates(owner: [], root: [], sibling: [], ownerStatus: "completed")
        reopened.refresh(); try await settle(reopened)
        try check(reopened.canPlayResult && !(reopened.result?.spokenText.contains("Parent planner") ?? true),
                  "Final result must come from actual leaves, not parent planning prose")
    }

    private static func states(_ status: String, id: String = "child-approval", method: String = "item/commandExecution/requestApproval") -> [[String: String]] {
        [["id": id, "method": method, "status": status]]
    }

    private static func model(_ defaults: UserDefaults, _ transport: DelegatedRecoveryTransport) throws -> MacControlModel {
        let config = try ProvidenceCoordinatorConfiguration.decodeAndValidate(Data("{\"baseURL\":\"https://providence.hani.so/\",\"deviceId\":\"mac\",\"chatId\":\"root-chat\"}".utf8))
        let client = try CoordinatorClient(baseURL: config.baseURL, transport: transport,
                                          tokenProvider: ClosureBearerTokenProvider { "synthetic" })
        return MacControlModel(defaults: defaults, configuration: config, client: client)
    }

    private static func checkStillBlocked(_ model: MacControlModel, _ transport: DelegatedRecoveryTransport) async throws {
        model.showRecovery(); model.refresh(); try await settle(model)
        try check(model.hasApprovalAttempt && !model.canStartNewRequest && !model.canRetryPrepared && model.pendingApproval == nil,
                  "An unrelated, changed or unknown child decision unlocked replay")
        model.dismissRecovery()
        try check(model.hasApprovalAttempt, "Dismissal discarded a child decision identity")
        try await assertSinglePost(transport)
    }

    private static func assertSinglePost(_ transport: DelegatedRecoveryTransport) async throws {
        let counts = await transport.postCounts()
        try check(counts.submission == 1 && counts.approval == 1, "Recovery duplicated submission or approval POST")
    }

    private static func settle(_ model: MacControlModel) async throws {
        for _ in 0..<100 {
            if !model.busy { return }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        throw Failure("Synthetic delegated recovery did not settle")
    }
    private static func check(_ condition: Bool, _ reason: String) throws { if !condition { throw Failure(reason) } }
    private struct Failure: Error { let reason: String; init(_ reason: String) { self.reason = reason } }
}

private actor DelegatedRecoveryTransport: HTTPTransport {
    private let coordinated: Bool
    private let loseFirstSubmission: Bool
    private var submitted: [(path: String, body: Data)] = []
    private var requestID = "00000000-0000-4000-8000-000000000000"
    private var submissionPosts = 0
    private var approvalPosts = 0
    private var ownerIncluded = true
    private var ownerStatus = "needs_input"
    private var ownerStates: [[String: String]]? = [["id": "child-approval", "method": "item/commandExecution/requestApproval", "status": "pending"]]
    private var rootStates: [[String: String]] = []
    private var siblingStates: [[String: String]] = []

    init(coordinated: Bool = false, loseFirstSubmission: Bool = false) {
        self.coordinated = coordinated; self.loseFirstSubmission = loseFirstSubmission
    }
    func submissions() -> [(path: String, body: Data)] { submitted }

    func postCounts() -> (submission: Int, approval: Int) { (submissionPosts, approvalPosts) }
    func includeOwner(_ included: Bool) { ownerIncluded = included }
    func setStates(owner: [[String: String]]?, root: [[String: String]], sibling: [[String: String]], ownerStatus: String = "needs_input") {
        ownerStates = owner; rootStates = root; siblingStates = sibling; self.ownerStatus = ownerStatus
    }

    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let path = request.url!.path
        let object: [String: Any]
        switch (request.httpMethod, path) {
        case ("GET", "/v1/devices"):
            object = ["devices": [["id": "mac", "name": "Fixture Mac", "local": true, "online": true, "connectionState": "online", "platform": "macos", "capabilities": ["desktop": true]]]]
        case ("GET", "/v1/chats"):
            object = ["chats": [["id": "root-chat", "name": "Fixture", "deviceId": "mac", "threadId": "root-thread", "online": true]]]
        case ("POST", "/v1/chats/root-chat/messages"), ("POST", "/v1/messages"):
            precondition(path == (coordinated ? "/v1/messages" : "/v1/chats/root-chat/messages"))
            submissionPosts += 1
            submitted.append((path, request.httpBody!))
            let body = try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: Any]
            requestID = body["requestId"] as! String
            if loseFirstSubmission && submissionPosts == 1 { throw URLError(.networkConnectionLost) }
            object = root()
        case ("GET", "/v1/tasks/parent-root"): object = root()
        case ("GET", "/v1/tasks/child-owner"):
            object = task("child-owner", request: "provider-child-call-42", chat: "child-chat", status: ownerStatus, states: ownerStates)
        case ("GET", "/v1/tasks/sibling-task"):
            object = task("sibling-task", request: "provider-sibling-call-17", chat: "sibling-chat", status: "completed", states: siblingStates)
        case ("GET", "/v1/briefing"):
            let pending = ownerStates?.contains(where: { $0["status"] == "pending" }) == true
            object = ["devices": [], "tasks": [], "phone": [:], "approvals": pending ? [[
                "id": "child-approval", "taskId": "child-owner", "deviceId": "mac", "method": "item/commandExecution/requestApproval",
                "details": ["command": "synthetic-no-operation"], "status": "pending",
            ]] : []]
        case ("POST", "/v1/approvals/child-approval"):
            approvalPosts += 1
            ownerStates = [["id": "child-approval", "method": "item/commandExecution/requestApproval", "status": "resolving"]]
            throw URLError(.networkConnectionLost)
        default: throw URLError(.unsupportedURL)
        }
        return (try JSONSerialization.data(withJSONObject: object), HTTPURLResponse(url: request.url!, statusCode: request.httpMethod == "POST" ? 202 : 200, httpVersion: nil, headerFields: nil)!)
    }

    private func root() -> [String: Any] {
        var value = task("parent-root", request: requestID, chat: coordinated ? "master" : "root-chat", status: "completed", states: rootStates)
        if coordinated { value["deviceId"] = "coordinator" }
        value.removeValue(forKey: "parentTaskId")
        value["childTaskIds"] = ownerIncluded ? ["child-owner", "sibling-task"] : ["sibling-task"]
        value["workStatus"] = ownerIncluded ? ownerStatus : "completed"
        value["text"] = "Parent planner text only."
        return value
    }

    private func task(_ id: String, request: String, chat: String, status: String, states: [[String: String]]?) -> [String: Any] {
        var value: [String: Any] = ["id": id, "requestId": request, "chatId": chat, "deviceId": "mac", "parentTaskId": "parent-root", "status": status,
                                  "prompt": "synthetic", "text": status == "completed" ? "Fixture complete." : "Fixture work in progress.",
                                  "createdAt": "now", "updatedAt": "now", "childTaskIds": []]
        if let states { value["approvalStates"] = states }
        return value
    }
}
