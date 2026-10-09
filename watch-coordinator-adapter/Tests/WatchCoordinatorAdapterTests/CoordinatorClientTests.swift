import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import WatchCoordinatorAdapter

// Exercise every client call across the same MainActor boundary as the Watch UI.
@MainActor
final class CoordinatorClientTests: XCTestCase {
    private let baseURL = URL(string: "https://providence.example")!
    private let requestID = UUID(uuidString: "aaecb697-430a-4e6b-9938-7c9c874e74c1")!

    func testWorkflowSubmissionEncodesExactCanonicalManifestAndLegacyOmitsIt() async throws {
        let bindings = try [
            CoordinatorWorkflowBinding(role: .research, deviceID: "research-device", chatID: "research-chat"),
            CoordinatorWorkflowBinding(role: .analysis, deviceID: "analysis-device", chatID: "analysis-chat"),
            CoordinatorWorkflowBinding(role: .presentation, deviceID: "presentation-device", chatID: "presentation-chat")
        ]
        let manifest = try CoordinatorWorkflowManifest(bindings: bindings)
        let legacy = try MessageSubmission(requestID: requestID, text: "legacy")
        let workflow = try MessageSubmission(requestID: requestID, text: "workflow", workflow: manifest)
        XCTAssertNil(legacy.workflow)
        XCTAssertEqual(workflow.workflow, manifest)
        XCTAssertThrowsError(try CoordinatorWorkflowManifest(bindings: [bindings[0], bindings[0], bindings[2]]))
    }

    func testSubmissionKeepsRequestIdentitySeparateFromReturnedTaskID() async throws {
        let transport = MockTransport([.json(status: 202, taskJSON(status: "queued"))])
        let client = try makeClient(transport)
        let submission = try MessageSubmission(requestID: requestID, text: "Exact / text")

        let task = try await client.submit(submission)

        XCTAssertEqual(task.requestID, requestID.uuidString.lowercased())
        XCTAssertEqual(task.id, "task-42")
        XCTAssertNotEqual(task.id, task.requestID)
        let requests = await transport.requests
        let request = try XCTUnwrap(requests.first)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path, "/v1/messages")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer test-token")
        XCTAssertEqual(
            String(data: try XCTUnwrap(request.httpBody), encoding: .utf8),
            #"{"requestId":"aaecb697-430a-4e6b-9938-7c9c874e74c1","text":"Exact / text"}"#
        )
    }

    func testPollingNeverSubmitsAndDecodesTerminalState() async throws {
        let transport = MockTransport([
            .json(status: 200, taskJSON(status: "running")),
            .json(status: 200, taskJSON(status: "completed", text: "Done")),
        ])
        let client = try makeClient(transport)

        let running = try await client.task(id: "task-42")
        let completed = try await client.task(id: "task-42")

        XCTAssertEqual(running.status, .running)
        XCTAssertFalse(running.status.isTerminal)
        XCTAssertEqual(completed.status, .completed)
        XCTAssertTrue(completed.status.isTerminal)
        XCTAssertEqual(completed.text, "Done")
        let requests = await transport.requests
        XCTAssertEqual(requests.map(\.httpMethod), ["GET", "GET"])
        XCTAssertTrue(requests.allSatisfy { $0.url?.path == "/v1/tasks/task-42" })
    }

    func testExactTaskGETRetainsMirroringTargetForRecovery() async throws {
        let transport = MockTransport([.json(status: 200, taskJSON(
            status: "queued", chatID: "review-chat", deviceID: "review-mac", executionTargetJSON: mirroringTargetJSON()
        ))])
        let client = try makeClient(transport)

        let task = try await client.task(id: "task-42")

        XCTAssertEqual(task.executionTarget, try mirroringTarget())
        let requests = await transport.requests
        XCTAssertEqual(requests.map(\.url?.path), ["/v1/tasks/task-42"])
    }

    func testExplicitRetryUsesIdenticalRequestIDAndBody() async throws {
        let response = MockResponse.json(status: 202, taskJSON(status: "queued"))
        let transport = MockTransport([response, response])
        let client = try makeClient(transport)
        let submission = try MessageSubmission(requestID: requestID, text: "Do this once")

        _ = try await client.submit(submission)
        _ = try await client.submit(submission)

        let requests = await transport.requests
        XCTAssertEqual(requests.count, 2)
        XCTAssertEqual(requests[0].httpBody, requests[1].httpBody)
    }

    func testDirectSubmissionPinsRegisteredChatAndDevice() async throws {
        let response = taskJSON(
            status: "queued",
            chatID: "review-chat",
            deviceID: "review-mac"
        )
        let transport = MockTransport([.json(status: 202, response)])
        let client = try makeClient(transport)
        let submission = try DirectMessageSubmission(
            requestID: requestID,
            text: "Work on my current Mac",
            chat: targetChat(),
            expectedDeviceID: "review-mac",
            sourceChatIDs: ["context-chat"]
        )

        let task = try await client.submit(submission)

        XCTAssertEqual(task.chatID, "review-chat")
        XCTAssertEqual(task.deviceID, "review-mac")
        let requests = await transport.requests
        let request = try XCTUnwrap(requests.first)
        XCTAssertEqual(request.url?.path, "/v1/chats/review-chat/messages")
        XCTAssertEqual(
            String(data: try XCTUnwrap(request.httpBody), encoding: .utf8),
            #"{"requestId":"aaecb697-430a-4e6b-9938-7c9c874e74c1","sourceChatIds":["context-chat"],"text":"Work on my current Mac"}"#
        )
    }

    func testDirectSubmissionEncodesAndRequiresExactMirroringTargetEcho() async throws {
        let target = try mirroringTarget()
        let response = taskJSON(
            status: "queued",
            chatID: "review-chat",
            deviceID: "review-mac",
            executionTargetJSON: mirroringTargetJSON()
        )
        let transport = MockTransport([.json(status: 202, response)])
        let client = try makeClient(transport)
        let submission = try DirectMessageSubmission(
            requestID: requestID,
            text: "Open the selected phone browser",
            chat: targetChat(),
            expectedDeviceID: "review-mac",
            executionTarget: target
        )

        let task = try await client.submit(submission)

        XCTAssertEqual(task.executionTarget, target)
        let requests = await transport.requests
        let request = try XCTUnwrap(requests.first)
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: try XCTUnwrap(request.httpBody)) as? [String: Any])
        let encodedTarget = try XCTUnwrap(body["executionTarget"] as? [String: String])
        XCTAssertEqual(encodedTarget["transport"], "apple-iphone-mirroring")
        XCTAssertEqual(encodedTarget["deviceId"], "review-mac")
        XCTAssertEqual(encodedTarget["chatId"], "review-chat")
        XCTAssertEqual(encodedTarget["phoneId"], "phone-1")
        XCTAssertEqual(encodedTarget["phoneName"], "Demo's iPhone")
        XCTAssertEqual(encodedTarget["leaseId"], "lease-1")
        XCTAssertEqual(encodedTarget["action"], "browser")
    }

    func testDirectSubmissionRejectsMissingOrChangedMirroringTargetEcho() async throws {
        let target = try mirroringTarget()
        let variants: [String?] = [
            nil,
            mirroringTargetJSON().replacingOccurrences(of: "phone-1", with: "phone-2"),
            mirroringTargetJSON().replacingOccurrences(of: "lease-1", with: "lease-2"),
            mirroringTargetJSON().replacingOccurrences(of: #""action":"browser""#, with: #""action":"email""#),
        ]
        for executionTargetJSON in variants {
            let transport = MockTransport([.json(status: 202, taskJSON(
                status: "queued", chatID: "review-chat", deviceID: "review-mac", executionTargetJSON: executionTargetJSON
            ))])
            let client = try makeClient(transport)
            let submission = try DirectMessageSubmission(
                requestID: requestID, text: "Use phone", chat: targetChat(), expectedDeviceID: "review-mac", executionTarget: target
            )
            await XCTAssertThrowsCoordinatorError(
                try await client.submit(submission),
                expected: .responseTargetMismatch(taskID: "task-42", expectedChatID: "review-chat", expectedDeviceID: "review-mac")
            )
        }
    }

    func testOrdinaryDirectSubmissionRejectsUnexpectedMirroringTargetEcho() async throws {
        let transport = MockTransport([.json(status: 202, taskJSON(
            status: "queued", chatID: "review-chat", deviceID: "review-mac", executionTargetJSON: mirroringTargetJSON()
        ))])
        let client = try makeClient(transport)
        let submission = try DirectMessageSubmission(
            requestID: requestID, text: "Ordinary Mac task", chat: targetChat(), expectedDeviceID: "review-mac"
        )
        await XCTAssertThrowsCoordinatorError(
            try await client.submit(submission),
            expected: .responseTargetMismatch(taskID: "task-42", expectedChatID: "review-chat", expectedDeviceID: "review-mac")
        )
    }

    func testMirroringTargetRejectsInvalidFieldsAndTransport() throws {
        for invalid in ["", "phone/id", String(repeating: "a", count: 201)] {
            XCTAssertThrowsError(try IPhoneMirroringExecutionTarget(
                deviceID: "review-mac", chatID: "review-chat", phoneID: invalid,
                phoneName: "Demo's iPhone", leaseID: "lease-1", action: .browser
            ))
        }
        for phoneName in ["   ", "Demo\nPhone", String(repeating: "🙂", count: 81)] {
            XCTAssertThrowsError(try IPhoneMirroringExecutionTarget(
                deviceID: "review-mac", chatID: "review-chat", phoneID: "phone-1",
                phoneName: phoneName, leaseID: "lease-1", action: .browser
            ))
        }
        XCTAssertNoThrow(try IPhoneMirroringExecutionTarget(
            deviceID: "review-mac", chatID: "review-chat", phoneID: "phone-1",
            phoneName: "  Demo’s iPhone 📱  ", leaseID: "lease-1", action: .browser
        ))
        let invalidTransport = Data(mirroringTargetJSON().replacingOccurrences(
            of: "apple-iphone-mirroring", with: "other-route"
        ).utf8)
        XCTAssertThrowsError(try JSONDecoder().decode(IPhoneMirroringExecutionTarget.self, from: invalidTransport))
        var extra = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(mirroringTargetJSON().utf8)) as? [String: Any])
        extra["unexpected"] = true
        let extraField = try JSONSerialization.data(withJSONObject: extra)
        XCTAssertThrowsError(try JSONDecoder().decode(IPhoneMirroringExecutionTarget.self, from: extraField))
        var missing = extra
        missing.removeValue(forKey: "unexpected")
        missing.removeValue(forKey: "leaseId")
        let missingField = try JSONSerialization.data(withJSONObject: missing)
        XCTAssertThrowsError(try JSONDecoder().decode(IPhoneMirroringExecutionTarget.self, from: missingField))
    }

    func testDirectSubmissionRejectsWrongOrOfflineTargetBeforeNetwork() throws {
        XCTAssertThrowsError(
            try DirectMessageSubmission(
                requestID: requestID,
                text: "Do not misroute",
                chat: targetChat(),
                expectedDeviceID: "demo-mac"
            )
        ) { error in
            XCTAssertEqual(
                error as? CoordinatorClientError,
                .targetDeviceMismatch(
                    chatID: "review-chat",
                    expectedDeviceID: "demo-mac",
                    actualDeviceID: "review-mac"
                )
            )
        }
        XCTAssertThrowsError(
            try DirectMessageSubmission(
                requestID: requestID,
                text: "Do not queue offline",
                chat: targetChat(online: false),
                expectedDeviceID: "review-mac"
            )
        ) { error in
            XCTAssertEqual(
                error as? CoordinatorClientError,
                .targetChatOffline(chatID: "review-chat", deviceID: "review-mac")
            )
        }
    }

    func testListsDeviceAndChatTargetMetadata() async throws {
        let deviceBody = Data(#"{"devices":[{"id":"review-mac","name":"Review Mac","local":false,"online":true,"connectionState":"online","workspace":"/workspace","capabilities":{"files":true}}]}"#.utf8)
        let chatBody = Data(#"{"chats":[{"id":"review-chat","name":"Watch tasks","deviceId":"review-mac","threadId":"thread-1","online":true,"workspace":"/workspace","providerState":"active"}]}"#.utf8)
        let transport = MockTransport([
            .json(status: 200, deviceBody),
            .json(status: 200, chatBody),
        ])
        let client = try makeClient(transport)

        let devices = try await client.devices()
        let chats = try await client.chats()

        XCTAssertEqual(devices.first?.id, "review-mac")
        XCTAssertEqual(devices.first?.online, true)
        XCTAssertEqual(chats.first?.deviceID, "review-mac")
        XCTAssertEqual(chats.first?.workspace, "/workspace")
    }

    func testBriefingDecodesNeedsInputAndPendingApproval() async throws {
        let body = """
        {
          "devices": [],
          "tasks": [\(taskJSONString(status: "needs_input"))],
          "approvals": [{
            "id": "approval-7",
            "taskId": "task-42",
            "deviceId": "mac",
            "method": "item/commandExecution/requestApproval",
            "details": {"command": "swift test", "reason": "Verify"},
            "status": "pending"
          }],
          "phone": {"capability": {"executable": false}, "jobs": []}
        }
        """
        let transport = MockTransport([.json(status: 200, Data(body.utf8))])
        let client = try makeClient(transport)

        let briefing = try await client.briefing()

        XCTAssertEqual(briefing.tasks.first?.status, .needsInput)
        XCTAssertEqual(briefing.approvals.first?.taskID, "task-42")
        XCTAssertEqual(briefing.approvals.first?.status, "pending")
    }

    func testBriefingRetainsMixedOpaqueAndUUIDRequestIDsWithPendingApproval() async throws {
        let body = """
        {
          "devices": [],
          "tasks": [
            \(taskJSONString(status: "needs_input", requestID: "provider-turn:opaque-42")),
            \(taskJSONString(status: "queued"))
          ],
          "approvals": [{
            "id": "approval-7", "taskId": "task-42", "deviceId": "mac",
            "method": "item/commandExecution/requestApproval", "details": {}, "status": "pending"
          }],
          "phone": {"capability": {}, "jobs": []}
        }
        """
        let client = try makeClient(MockTransport([.json(status: 200, Data(body.utf8))]))

        let briefing = try await client.briefing()

        XCTAssertEqual(briefing.tasks.map(\.requestID), ["provider-turn:opaque-42", requestID.uuidString.lowercased()])
        XCTAssertEqual(briefing.approvals.first?.status, "pending")
    }

    func testTaskGETDecodesOpaqueRequestID() async throws {
        let client = try makeClient(MockTransport([.json(status: 200, taskJSON(
            status: "queued", requestID: "coordinator-child/opaque:17"
        ))]))

        let task = try await client.task(id: "task-42")

        XCTAssertEqual(task.requestID, "coordinator-child/opaque:17")
    }

    func testDecisionPostsOnlyExactTaskApprovalAndPayload() async throws {
        let transport = MockTransport([.json(status: 200, Data(#"{"resolved":true}"#.utf8))])
        let client = try makeClient(transport)
        let task = try decodeTask(status: "needs_input")
        let approval = pendingApproval(taskID: task.id)

        let result = try await client.resolveApproval(
            approval,
            for: task,
            with: .decision(.accept)
        )

        XCTAssertTrue(result.resolved)
        let requests = await transport.requests
        let request = try XCTUnwrap(requests.first)
        XCTAssertEqual(request.url?.path, "/v1/approvals/approval-7")
        XCTAssertEqual(
            String(data: try XCTUnwrap(request.httpBody), encoding: .utf8),
            #"{"decision":"accept"}"#
        )
    }

    func testQuestionAnswersUseDocumentedNestedPayload() async throws {
        let transport = MockTransport([.json(status: 200, Data(#"{"resolved":true}"#.utf8))])
        let client = try makeClient(transport)
        let task = try decodeTask(status: "needs_input")

        _ = try await client.resolveApproval(
            pendingApproval(taskID: task.id),
            for: task,
            with: .answers(["choice": ApprovalAnswer(["Friendly"])])
        )

        let requests = await transport.requests
        XCTAssertEqual(
            String(data: try XCTUnwrap(requests.first?.httpBody), encoding: .utf8),
            #"{"answers":{"choice":{"answers":["Friendly"]}}}"#
        )
    }

    func testTypedApprovalResponseKeepsProviderShapeInsideResponseKey() async throws {
        let transport = MockTransport([.json(status: 200, Data(#"{"resolved":true}"#.utf8))])
        let client = try makeClient(transport)
        let task = try decodeTask(status: "needs_input")

        _ = try await client.resolveApproval(
            pendingApproval(taskID: task.id),
            for: task,
            with: .response(
                .elicitation(
                    action: .accept,
                    content: .object(["tone": .string("Friendly")])
                )
            )
        )

        let requests = await transport.requests
        XCTAssertEqual(
            String(data: try XCTUnwrap(requests.first?.httpBody), encoding: .utf8),
            #"{"response":{"action":"accept","content":{"tone":"Friendly"},"kind":"elicitation"}}"#
        )
    }

    func testDirectResponseForDifferentDeviceIsRejected() async throws {
        let transport = MockTransport([
            .json(
                status: 202,
                taskJSON(
                    status: "queued",
                    chatID: "review-chat",
                    deviceID: "demo-mac"
                )
            ),
        ])
        let client = try makeClient(transport)
        let submission = try DirectMessageSubmission(
            requestID: requestID,
            text: "Stay on Review's Mac",
            chat: targetChat(),
            expectedDeviceID: "review-mac"
        )

        await XCTAssertThrowsCoordinatorError(
            try await client.submit(submission),
            expected: .responseTargetMismatch(
                taskID: "task-42",
                expectedChatID: "review-chat",
                expectedDeviceID: "review-mac"
            )
        )
    }

    func testMismatchedApprovalTaskIsRejectedWithoutNetworkRequest() async throws {
        let transport = MockTransport([])
        let client = try makeClient(transport)
        let task = try decodeTask(status: "needs_input")

        do {
            _ = try await client.resolveApproval(
                pendingApproval(taskID: "some-other-task"),
                for: task,
                with: .decision(.accept)
            )
            XCTFail("Expected task identity rejection")
        } catch let error as CoordinatorClientError {
            XCTAssertEqual(
                error,
                .approvalTaskMismatch(
                    approvalID: "approval-7",
                    expectedTaskID: "task-42",
                    actualTaskID: "some-other-task"
                )
            )
        }
        let requests = await transport.requests
        XCTAssertTrue(requests.isEmpty)
    }

    func testNonPendingApprovalAndNonNeedsInputTaskAreRejectedLocally() async throws {
        let transport = MockTransport([])
        let client = try makeClient(transport)
        let task = try decodeTask(status: "running")
        let resolved = CoordinatorApproval(
            id: "approval-7",
            taskID: task.id,
            deviceID: "mac",
            method: "item/commandExecution/requestApproval",
            details: .object([:]),
            status: "resolved"
        )

        await XCTAssertThrowsCoordinatorError(
            try await client.resolveApproval(resolved, for: task, with: .decision(.accept)),
            expected: .approvalNotPending(approvalID: "approval-7", status: "resolved")
        )
        await XCTAssertThrowsCoordinatorError(
            try await client.resolveApproval(
                pendingApproval(taskID: task.id),
                for: task,
                with: .decision(.accept)
            ),
            expected: .taskDoesNotNeedInput(taskID: task.id, status: .running)
        )
        let requests = await transport.requests
        XCTAssertTrue(requests.isEmpty)
    }

    func testMissingAuthNon2xxAndMalformedResponseAreDistinct() async throws {
        let missingTokenClient = try CoordinatorClient(
            baseURL: baseURL,
            transport: MockTransport([]),
            tokenProvider: ClosureBearerTokenProvider { "  " }
        )
        await XCTAssertThrowsCoordinatorError(
            try await missingTokenClient.task(id: "task-42"),
            expected: .missingBearerToken
        )

        let rejected = try makeClient(
            MockTransport([.json(status: 401, Data(#"{"error":"Unauthorized"}"#.utf8))])
        )
        await XCTAssertThrowsCoordinatorError(
            try await rejected.task(id: "task-42"),
            expected: .unexpectedStatus(code: 401, message: "Unauthorized")
        )

        let proxyFailure = try makeClient(
            MockTransport([.json(status: 502, Data("Bad gateway".utf8))])
        )
        await XCTAssertThrowsCoordinatorError(
            try await proxyFailure.task(id: "task-42"),
            expected: .unexpectedStatus(code: 502, message: nil)
        )

        let malformed = try makeClient(
            MockTransport([.json(status: 200, Data(#"{"id":"task-42"}"#.utf8))])
        )
        do {
            _ = try await malformed.task(id: "task-42")
            XCTFail("Expected malformed response")
        } catch let error as CoordinatorClientError {
            guard case let .malformedResponse(endpoint, _) = error else {
                return XCTFail("Unexpected error: \(error)")
            }
            XCTAssertEqual(endpoint, "/v1/tasks/task-42")
        }
    }

    func testRejectsNonHTTPSOrCredentialBearingBaseURL() throws {
        XCTAssertThrowsError(
            try CoordinatorClient(
                baseURL: URL(string: "http://providence.example")!,
                tokenProvider: ClosureBearerTokenProvider { "token" }
            )
        )
        XCTAssertThrowsError(
            try CoordinatorClient(
                baseURL: URL(string: "https://user:password@providence.example")!,
                tokenProvider: ClosureBearerTokenProvider { "token" }
            )
        )
    }

    private func makeClient(_ transport: MockTransport) throws -> CoordinatorClient {
        try CoordinatorClient(
            baseURL: baseURL,
            transport: transport,
            tokenProvider: ClosureBearerTokenProvider { "test-token" }
        )
    }

    private func decodeTask(status: String) throws -> CoordinatorTask {
        try JSONDecoder().decode(CoordinatorTask.self, from: taskJSON(status: status))
    }

    private func pendingApproval(taskID: String) -> CoordinatorApproval {
        CoordinatorApproval(
            id: "approval-7",
            taskID: taskID,
            deviceID: "mac",
            method: "item/commandExecution/requestApproval",
            details: .object(["command": .string("swift test")]),
            status: "pending"
        )
    }

    private func targetChat(online: Bool = true) -> CoordinatorChat {
        CoordinatorChat(
            id: "review-chat",
            name: "Watch tasks",
            deviceID: "review-mac",
            threadID: "thread-1",
            online: online,
            workspace: "/workspace",
            instructions: nil,
            imported: false,
            providerState: "active"
        )
    }

    private func mirroringTarget() throws -> IPhoneMirroringExecutionTarget {
        try IPhoneMirroringExecutionTarget(
            deviceID: "review-mac", chatID: "review-chat", phoneID: "phone-1",
            phoneName: "Demo's iPhone", leaseID: "lease-1", action: .browser
        )
    }

    private func mirroringTargetJSON() -> String {
        #"{"transport":"apple-iphone-mirroring","deviceId":"review-mac","chatId":"review-chat","phoneId":"phone-1","phoneName":"Demo's iPhone","leaseId":"lease-1","action":"browser"}"#
    }

    private func taskJSON(
        status: String,
        text: String = "",
        chatID: String = "master",
        deviceID: String = "coordinator",
        requestID: String = "aaecb697-430a-4e6b-9938-7c9c874e74c1",
        executionTargetJSON: String? = nil
    ) -> Data {
        Data(
            taskJSONString(
                status: status,
                text: text,
                chatID: chatID,
                deviceID: deviceID,
                requestID: requestID,
                executionTargetJSON: executionTargetJSON
            ).utf8
        )
    }

    private func taskJSONString(
        status: String,
        text: String = "",
        chatID: String = "master",
        deviceID: String = "coordinator",
        requestID: String = "aaecb697-430a-4e6b-9938-7c9c874e74c1",
        executionTargetJSON: String? = nil
    ) -> String {
        let executionTarget = executionTargetJSON.map { ",\n  \"executionTarget\": \($0)" } ?? ""
        return """
        {
          "id": "task-42",
          "requestId": "\(requestID)",
          "chatId": "\(chatID)",
          "deviceId": "\(deviceID)",
          "status": "\(status)",
          "prompt": "Do this once",
          "text": "\(text)",
          "createdAt": "2026-09-19T06:00:00.000Z",
          "updatedAt": "2026-09-19T06:00:01.000Z"\(executionTarget)
        }
        """
    }
}

private struct MockResponse: Sendable {
    let data: Data
    let status: Int

    static func json(status: Int, _ data: Data) -> MockResponse {
        MockResponse(data: data, status: status)
    }
}

private actor MockTransport: HTTPTransport {
    private var responses: [MockResponse]
    private(set) var requests: [URLRequest] = []

    init(_ responses: [MockResponse]) {
        self.responses = responses
    }

    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        requests.append(request)
        guard !responses.isEmpty else {
            throw MockError.noResponse
        }
        let response = responses.removeFirst()
        let http = HTTPURLResponse(
            url: request.url!,
            statusCode: response.status,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        return (response.data, http)
    }
}

private enum MockError: Error {
    case noResponse
}

@MainActor
private func XCTAssertThrowsCoordinatorError<T>(
    _ expression: @autoclosure @MainActor () async throws -> T,
    expected: CoordinatorClientError,
    file: StaticString = #filePath,
    line: UInt = #line
) async {
    do {
        _ = try await expression()
        XCTFail("Expected error \(expected)", file: file, line: line)
    } catch let error as CoordinatorClientError {
        XCTAssertEqual(error, expected, file: file, line: line)
    } catch {
        XCTFail("Unexpected error: \(error)", file: file, line: line)
    }
}
