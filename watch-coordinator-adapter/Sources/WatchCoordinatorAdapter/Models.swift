import Foundation

public enum JSONValue: Codable, Equatable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else {
            self = .object(try container.decode([String: JSONValue].self))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null:
            try container.encodeNil()
        case let .bool(value):
            try container.encode(value)
        case let .number(value):
            try container.encode(value)
        case let .string(value):
            try container.encode(value)
        case let .array(value):
            try container.encode(value)
        case let .object(value):
            try container.encode(value)
        }
    }
}

public enum TaskStatus: String, Codable, CaseIterable, Sendable {
    case queued
    case running
    case needsInput = "needs_input"
    case completed
    case failed
    case cancelled
    case interrupted

    public var isTerminal: Bool {
        switch self {
        case .completed, .failed, .cancelled, .interrupted:
            return true
        case .queued, .running, .needsInput:
            return false
        }
    }
}

public enum IPhoneMirroringAction: String, Codable, CaseIterable, Sendable {
    case general
    case browser
    case messaging
    case email
}

public enum IPhoneMirroringExecutionTargetError: Error, Equatable, Sendable {
    case invalidTransport(String)
    case invalidField(String)
}

/// An exact, coordinator-authorized Apple iPhone Mirroring route. This is
/// binding data only; task text must never select or alter it.
public struct IPhoneMirroringExecutionTarget: Codable, Equatable, Sendable {
    public static let requiredTransport = "apple-iphone-mirroring"

    public let transport: String
    public let deviceID: String
    public let chatID: String
    public let phoneID: String
    public let phoneName: String
    public let leaseID: String
    public let action: IPhoneMirroringAction

    public init(
        deviceID: String,
        chatID: String,
        phoneID: String,
        phoneName: String,
        leaseID: String,
        action: IPhoneMirroringAction
    ) throws {
        try Self.validateID(deviceID, named: "deviceId")
        try Self.validateID(chatID, named: "chatId")
        try Self.validateID(phoneID, named: "phoneId")
        try Self.validatePhoneName(phoneName)
        try Self.validateID(leaseID, named: "leaseId")
        self.transport = Self.requiredTransport
        self.deviceID = deviceID
        self.chatID = chatID
        self.phoneID = phoneID
        self.phoneName = phoneName
        self.leaseID = leaseID
        self.action = action
    }

    enum CodingKeys: String, CodingKey, CaseIterable {
        case transport, phoneName, action
        case deviceID = "deviceId"
        case chatID = "chatId"
        case phoneID = "phoneId"
        case leaseID = "leaseId"
    }

    public init(from decoder: Decoder) throws {
        let raw = try decoder.container(keyedBy: DynamicCodingKey.self)
        let expected = Set(CodingKeys.allCases.map(\.rawValue))
        guard Set(raw.allKeys.map(\.stringValue)) == expected else {
            throw IPhoneMirroringExecutionTargetError.invalidField("executionTarget")
        }
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let transport = try container.decode(String.self, forKey: .transport)
        guard transport == Self.requiredTransport else {
            throw IPhoneMirroringExecutionTargetError.invalidTransport(transport)
        }
        try self.init(
            deviceID: try container.decode(String.self, forKey: .deviceID),
            chatID: try container.decode(String.self, forKey: .chatID),
            phoneID: try container.decode(String.self, forKey: .phoneID),
            phoneName: try container.decode(String.self, forKey: .phoneName),
            leaseID: try container.decode(String.self, forKey: .leaseID),
            action: try container.decode(IPhoneMirroringAction.self, forKey: .action)
        )
    }

    private static func validateID(_ value: String, named field: String) throws {
        guard value.range(of: "^[A-Za-z0-9_-]{1,200}$", options: .regularExpression) != nil else {
            throw IPhoneMirroringExecutionTargetError.invalidField(field)
        }
    }

    private static func validatePhoneName(_ value: String) throws {
        guard (1...80).contains(value.unicodeScalars.count),
              !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !value.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else {
            throw IPhoneMirroringExecutionTargetError.invalidField("phoneName")
        }
    }
}

private struct DynamicCodingKey: CodingKey {
    let stringValue: String
    init?(stringValue: String) { self.stringValue = stringValue }
    let intValue: Int? = nil
    init?(intValue: Int) { return nil }
}

public struct CoordinatorArtifact: Codable, Equatable, Sendable {
    public let id: String
    public let taskID: String
    public let chatID: String
    public let deviceID: String
    public let path: String
    public let name: String
    public let mime: String
    public let size: Int
    public let sha256: String
    public let revision: Int
    public let createdAt: String

    enum CodingKeys: String, CodingKey {
        case id, path, name, mime, size, sha256, revision, createdAt
        case taskID = "taskId"
        case chatID = "chatId"
        case deviceID = "deviceId"
    }
}

public struct CoordinatorTask: Codable, Equatable, Sendable {
    public let id: String
    /// Server task request identity is opaque. Watch-originated submissions use
    /// UUIDs, but delegated and restored server tasks may use another format.
    public let requestID: String
    public let chatID: String
    public let deviceID: String
    public let status: TaskStatus
    public let prompt: String
    public let text: String
    public let error: String?
    public let createdAt: String
    public let updatedAt: String
    public let artifacts: [CoordinatorArtifact]?
    public let parentTaskID: String?
    public let afterTaskID: String?
    public let childTaskIDs: [String]?
    public let workStatus: TaskStatus?
    /// Optional exact iPhone Mirroring binding. Its absence preserves legacy routes.
    public let executionTarget: IPhoneMirroringExecutionTarget?
    /// Exact-task decision states. Missing on older coordinators; absence is
    /// never an acknowledgement of a Watch decision whose POST was uncertain.
    public let approvalStates: [CoordinatorTaskApprovalState]?
    public let workflow: CoordinatorWorkflowManifest?
    public let workflowRole: CoordinatorWorkflowRole?
    public let workflowStatus: CoordinatorWorkflowStatus?

    enum CodingKeys: String, CodingKey {
        case id, status, prompt, text, error, createdAt, updatedAt, artifacts, workStatus, approvalStates, executionTarget, workflow, workflowRole, workflowStatus
        case requestID = "requestId"
        case chatID = "chatId"
        case deviceID = "deviceId"
        case parentTaskID = "parentTaskId"
        case afterTaskID = "afterTaskId"
        case childTaskIDs = "childTaskIds"
    }
}

public struct CoordinatorTaskApprovalState: Codable, Equatable, Sendable {
    public let id: String
    public let method: String
    /// Keep unknown future values decodable and fail closed in consumers.
    public let status: String
}

public struct CoordinatorApproval: Codable, Equatable, Sendable {
    public let id: String
    public let taskID: String
    public let deviceID: String
    public let method: String
    public let details: JSONValue
    public let status: String

    enum CodingKeys: String, CodingKey {
        case id, method, details, status
        case taskID = "taskId"
        case deviceID = "deviceId"
    }
}

public struct CoordinatorBriefing: Decodable, Equatable, Sendable {
    public let devices: [JSONValue]
    public let tasks: [CoordinatorTask]
    public let approvals: [CoordinatorApproval]
    public let phone: JSONValue
}

public struct CoordinatorDevice: Decodable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let local: Bool
    public let online: Bool
    public let connectionState: String
    public let hostname: String?
    public let platform: String?
    public let workspace: String?
    public let capabilities: JSONValue?
}

public struct CoordinatorChat: Decodable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let deviceID: String
    public let threadID: String
    public let online: Bool
    public let workspace: String?
    public let instructions: String?
    public let imported: Bool?
    public let providerState: String?

    enum CodingKeys: String, CodingKey {
        case id, name, online, workspace, instructions, imported, providerState
        case deviceID = "deviceId"
        case threadID = "threadId"
    }
}

public enum ApprovalDecision: String, Encodable, Sendable {
    case accept
    case decline
    case cancel
}

public struct ApprovalAnswer: Encodable, Equatable, Sendable {
    public let answers: [String]

    public init(_ answers: [String]) {
        self.answers = answers
    }
}

public enum ApprovalScope: String, Encodable, Sendable {
    case turn
    case session
}

public enum StructuredApprovalResponse: Encodable, Equatable, Sendable {
    case elicitation(
        action: ApprovalDecision,
        content: JSONValue? = nil,
        metadata: JSONValue? = nil
    )
    case permissions(permissions: JSONValue, scope: ApprovalScope)

    enum CodingKeys: String, CodingKey {
        case kind, action, content, metadata = "_meta", permissions, scope
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .elicitation(action, content, metadata):
            try container.encode("elicitation", forKey: .kind)
            try container.encode(action, forKey: .action)
            try container.encodeIfPresent(content, forKey: .content)
            try container.encodeIfPresent(metadata, forKey: .metadata)
        case let .permissions(permissions, scope):
            guard case .object = permissions else {
                throw EncodingError.invalidValue(
                    permissions,
                    .init(
                        codingPath: encoder.codingPath,
                        debugDescription: "permissions must be a JSON object"
                    )
                )
            }
            try container.encode("permissions", forKey: .kind)
            try container.encode(permissions, forKey: .permissions)
            try container.encode(scope, forKey: .scope)
        }
    }
}

public enum ApprovalResolution: Encodable, Equatable, Sendable {
    case decision(ApprovalDecision)
    case answers([String: ApprovalAnswer])
    case response(StructuredApprovalResponse)

    enum CodingKeys: String, CodingKey {
        case decision, answers, response
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .decision(decision):
            try container.encode(decision, forKey: .decision)
        case let .answers(answers):
            try container.encode(answers, forKey: .answers)
        case let .response(response):
            try container.encode(response, forKey: .response)
        }
    }
}

public struct ApprovalResult: Decodable, Equatable, Sendable {
    public let resolved: Bool
}
