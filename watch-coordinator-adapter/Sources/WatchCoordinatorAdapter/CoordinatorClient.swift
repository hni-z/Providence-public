import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public struct MessageSubmission: Equatable, Sendable {
    public let requestID: UUID
    public let text: String
    public let workflow: CoordinatorWorkflowManifest?
    let body: Data

    public init(requestID: UUID, text: String, workflow: CoordinatorWorkflowManifest? = nil) throws {
        self.requestID = requestID
        self.text = text
        self.workflow = workflow
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        self.body = try encoder.encode(
            Body(requestID: requestID.uuidString.lowercased(), text: text, workflow: workflow)
        )
    }

    private struct Body: Encodable {
        let requestID: String
        let text: String
        let workflow: CoordinatorWorkflowManifest?

        enum CodingKeys: String, CodingKey {
            case requestID = "requestId"
            case text, workflow
        }
    }
}

/// A prepared submission to one already-registered Providence conversation.
/// Persist the whole value until a task ID is known so an explicit retry keeps
/// the chat, device, request ID, source chats, text, and encoded body unchanged.
public struct DirectMessageSubmission: Equatable, Sendable {
    public let requestID: UUID
    public let text: String
    public let chatID: String
    public let expectedDeviceID: String
    public let sourceChatIDs: [String]
    public let executionTarget: IPhoneMirroringExecutionTarget?
    let body: Data

    public init(
        requestID: UUID,
        text: String,
        chat: CoordinatorChat,
        expectedDeviceID: String,
        sourceChatIDs: [String] = [],
        executionTarget: IPhoneMirroringExecutionTarget? = nil
    ) throws {
        guard chat.deviceID == expectedDeviceID else {
            throw CoordinatorClientError.targetDeviceMismatch(
                chatID: chat.id,
                expectedDeviceID: expectedDeviceID,
                actualDeviceID: chat.deviceID
            )
        }
        guard chat.online else {
            throw CoordinatorClientError.targetChatOffline(
                chatID: chat.id,
                deviceID: chat.deviceID
            )
        }
        guard sourceChatIDs.count <= 5 else {
            throw CoordinatorClientError.tooManySourceChats(sourceChatIDs.count)
        }
        if let executionTarget {
            guard executionTarget.deviceID == expectedDeviceID else {
                throw CoordinatorClientError.targetDeviceMismatch(
                    chatID: chat.id,
                    expectedDeviceID: expectedDeviceID,
                    actualDeviceID: executionTarget.deviceID
                )
            }
            guard executionTarget.chatID == chat.id else {
                throw CoordinatorClientError.responseTargetMismatch(
                    taskID: "",
                    expectedChatID: chat.id,
                    expectedDeviceID: expectedDeviceID
                )
            }
        }
        self.requestID = requestID
        self.text = text
        self.chatID = chat.id
        self.expectedDeviceID = expectedDeviceID
        self.sourceChatIDs = sourceChatIDs
        self.executionTarget = executionTarget
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        self.body = try encoder.encode(
            Body(
                requestID: requestID.uuidString.lowercased(),
                text: text,
                sourceChatIDs: sourceChatIDs,
                executionTarget: executionTarget
            )
        )
    }

    private struct Body: Encodable {
        let requestID: String
        let text: String
        let sourceChatIDs: [String]
        let executionTarget: IPhoneMirroringExecutionTarget?

        enum CodingKeys: String, CodingKey {
            case requestID = "requestId"
            case text
            case sourceChatIDs = "sourceChatIds"
            case executionTarget
        }
    }
}

public enum CoordinatorClientError: Error, Equatable, Sendable {
    case invalidBaseURL
    case missingBearerToken
    case nonHTTPResponse
    case unexpectedStatus(code: Int, message: String?)
    case malformedResponse(endpoint: String, description: String)
    case approvalTaskMismatch(approvalID: String, expectedTaskID: String, actualTaskID: String)
    case approvalNotPending(approvalID: String, status: String)
    case taskDoesNotNeedInput(taskID: String, status: TaskStatus)
    case targetDeviceMismatch(chatID: String, expectedDeviceID: String, actualDeviceID: String)
    case targetChatOffline(chatID: String, deviceID: String)
    case tooManySourceChats(Int)
    case responseTargetMismatch(taskID: String, expectedChatID: String, expectedDeviceID: String)
    case invalidTranscriptionAudioSize(Int)
    case invalidTranscriptionDeviceID
    case invalidTranscriptionID
    case transcriptionResponseMismatch(id: String, expectedRequestID: UUID, expectedDeviceID: String)
    case transcriptionIDMismatch(expectedID: String, actualID: String)
    case requestNotAccepted(requestID: UUID, reason: String?, message: String)
}

/// Isolates the shared JSON encoder and decoder while requests suspend for I/O.
public actor CoordinatorClient {
    private let baseURL: URL
    private let transport: HTTPTransport
    private let tokenProvider: ClosureBearerTokenProvider
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder

    public init(
        baseURL: URL,
        transport: HTTPTransport = URLSessionTransport(),
        tokenProvider: ClosureBearerTokenProvider
    ) throws {
        guard
            baseURL.scheme?.lowercased() == "https",
            baseURL.host != nil,
            baseURL.user == nil,
            baseURL.password == nil,
            baseURL.query == nil,
            baseURL.fragment == nil
        else {
            throw CoordinatorClientError.invalidBaseURL
        }
        self.baseURL = baseURL
        self.transport = transport
        self.tokenProvider = tokenProvider
        self.encoder = JSONEncoder()
        self.encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        self.decoder = JSONDecoder()
    }

    /// Sends exactly one request. The client never retries automatically. If a failure is
    /// ambiguous, the caller may explicitly pass the same `MessageSubmission` again.
    public func submit(_ submission: MessageSubmission) async throws -> CoordinatorTask {
        let request = try await makeRequest(
            pathComponents: ["v1", "messages"],
            method: "POST",
            body: submission.body
        )
        return try await perform(request, expecting: 202, as: CoordinatorTask.self,
                                 unacceptedRequestID: submission.requestID)
    }

    /// Sends directly to one registered chat, which fixes the execution device.
    /// Unlike `/v1/messages`, this route does not ask the master coordinator to
    /// choose a chat or device.
    public func submit(_ submission: DirectMessageSubmission) async throws -> CoordinatorTask {
        let request = try await makeRequest(
            pathComponents: ["v1", "chats", submission.chatID, "messages"],
            method: "POST",
            body: submission.body
        )
        let task = try await perform(request, expecting: 202, as: CoordinatorTask.self,
                                     unacceptedRequestID: submission.requestID)
        guard
            task.chatID == submission.chatID,
            task.deviceID == submission.expectedDeviceID,
            task.executionTarget == submission.executionTarget
        else {
            throw CoordinatorClientError.responseTargetMismatch(
                taskID: task.id,
                expectedChatID: submission.chatID,
                expectedDeviceID: submission.expectedDeviceID
            )
        }
        return task
    }

    public func devices() async throws -> [CoordinatorDevice] {
        let request = try await makeRequest(
            pathComponents: ["v1", "devices"],
            method: "GET"
        )
        return try await perform(request, expecting: 200, as: DevicesEnvelope.self).devices
    }

    public func chats() async throws -> [CoordinatorChat] {
        let request = try await makeRequest(
            pathComponents: ["v1", "chats"],
            method: "GET"
        )
        return try await perform(request, expecting: 200, as: ChatsEnvelope.self).chats
    }

    public func transcriptionAvailability() async throws -> TranscriptionAvailability {
        let request = try await makeRequest(
            pathComponents: ["v1", "transcriptions"],
            method: "GET"
        )
        return try await perform(request, expecting: 200, as: TranscriptionEnvelope.self).transcription
    }

    /// Uploads one recording once. The caller owns the request identity and any
    /// explicit retry; a completed transcription never dispatches a message.
    public func submitTranscription(
        requestID: UUID,
        deviceID: String,
        audio: Data
    ) async throws -> CoordinatorTranscription {
        guard !audio.isEmpty && audio.count <= 524_288 else {
            throw CoordinatorClientError.invalidTranscriptionAudioSize(audio.count)
        }
        guard isValidTranscriptionDeviceID(deviceID) else {
            throw CoordinatorClientError.invalidTranscriptionDeviceID
        }
        let body = try encoder.encode(TranscriptionBody(
            requestId: requestID.uuidString.lowercased(),
            deviceId: deviceID,
            base64: audio.base64EncodedString(),
            mimeType: "audio/mp4"
        ))
        let request = try await makeRequest(
            pathComponents: ["v1", "transcriptions"],
            method: "POST",
            body: body
        )
        let job = try await perform(request, expecting: 202, as: CoordinatorTranscription.self)
        guard UUID(uuidString: job.requestID) == requestID && job.deviceID == deviceID else {
            throw CoordinatorClientError.transcriptionResponseMismatch(
                id: job.id, expectedRequestID: requestID, expectedDeviceID: deviceID
            )
        }
        return job
    }

    /// Performs one GET only, including for failed or interrupted jobs.
    public func transcription(id: String) async throws -> CoordinatorTranscription {
        guard let expectedID = UUID(uuidString: id) else {
            throw CoordinatorClientError.invalidTranscriptionID
        }
        let request = try await makeRequest(
            pathComponents: ["v1", "transcriptions", id],
            method: "GET"
        )
        let job = try await perform(request, expecting: 200, as: CoordinatorTranscription.self)
        guard UUID(uuidString: job.id) == expectedID else {
            throw CoordinatorClientError.transcriptionIDMismatch(expectedID: id, actualID: job.id)
        }
        return job
    }

    /// Performs one GET only. Polling never invokes `submit` and never creates a request ID.
    public func task(id: String) async throws -> CoordinatorTask {
        let request = try await makeRequest(
            pathComponents: ["v1", "tasks", id],
            method: "GET"
        )
        return try await perform(request, expecting: 200, as: CoordinatorTask.self)
    }

    public func briefing() async throws -> CoordinatorBriefing {
        let request = try await makeRequest(
            pathComponents: ["v1", "briefing"],
            method: "GET"
        )
        return try await perform(request, expecting: 200, as: CoordinatorBriefing.self)
    }

    /// Resolves the exact approval only when it is pending and belongs to the supplied
    /// `needs_input` task. There is no "approve first pending" operation.
    public func resolveApproval(
        _ approval: CoordinatorApproval,
        for task: CoordinatorTask,
        with resolution: ApprovalResolution
    ) async throws -> ApprovalResult {
        guard approval.taskID == task.id else {
            throw CoordinatorClientError.approvalTaskMismatch(
                approvalID: approval.id,
                expectedTaskID: task.id,
                actualTaskID: approval.taskID
            )
        }
        guard approval.status == "pending" else {
            throw CoordinatorClientError.approvalNotPending(
                approvalID: approval.id,
                status: approval.status
            )
        }
        guard task.status == .needsInput else {
            throw CoordinatorClientError.taskDoesNotNeedInput(
                taskID: task.id,
                status: task.status
            )
        }
        let body = try encoder.encode(resolution)
        let request = try await makeRequest(
            pathComponents: ["v1", "approvals", approval.id],
            method: "POST",
            body: body
        )
        return try await perform(request, expecting: 200, as: ApprovalResult.self)
    }

    private func makeRequest(
        pathComponents: [String],
        method: String,
        body: Data? = nil
    ) async throws -> URLRequest {
        let token = try await tokenProvider.token()
        guard !token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw CoordinatorClientError.missingBearerToken
        }
        let url = pathComponents.reduce(baseURL) { url, component in
            url.appendingPathComponent(component)
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return request
    }

    private func perform<Response: Decodable & Sendable>(
        _ request: URLRequest,
        expecting expectedStatus: Int,
        as type: Response.Type,
        unacceptedRequestID: UUID? = nil
    ) async throws -> Response {
        let (data, response) = try await transport.data(for: request)
        guard response.statusCode == expectedStatus else {
            let error = try? decoder.decode(ErrorEnvelope.self, from: data)
            if response.statusCode == 409, let unacceptedRequestID,
               error?.requestStatus == "not_accepted", error?.requestId == unacceptedRequestID,
               let message = error?.error {
                throw CoordinatorClientError.requestNotAccepted(requestID: unacceptedRequestID,
                                                                 reason: error?.errorCode, message: message)
            }
            throw CoordinatorClientError.unexpectedStatus(
                code: response.statusCode,
                message: error?.error
            )
        }
        do {
            return try decoder.decode(type, from: data)
        } catch {
            throw CoordinatorClientError.malformedResponse(
                endpoint: request.url?.path ?? "",
                description: String(describing: error)
            )
        }
    }

    private struct ErrorEnvelope: Decodable, Sendable {
        let error: String
        let requestId: UUID?
        let requestStatus: String?
        let errorCode: String?
    }

    private struct DevicesEnvelope: Decodable, Sendable {
        let devices: [CoordinatorDevice]
    }

    private struct ChatsEnvelope: Decodable, Sendable {
        let chats: [CoordinatorChat]
    }

    private struct TranscriptionEnvelope: Decodable, Sendable {
        let transcription: TranscriptionAvailability
    }

    private struct TranscriptionBody: Encodable {
        let requestId: String
        let deviceId: String
        let base64: String
        let mimeType: String
    }
}
