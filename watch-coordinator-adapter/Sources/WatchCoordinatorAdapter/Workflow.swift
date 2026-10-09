import Foundation

public enum CoordinatorWorkflowRole: String, Codable, CaseIterable, Sendable {
    case research, analysis, presentation
}

public enum CoordinatorWorkflowError: Error, Equatable, Sendable { case invalidManifest, invalidID }

public struct CoordinatorWorkflowBinding: Codable, Equatable, Sendable {
    public let role: CoordinatorWorkflowRole
    public let deviceID: String
    public let chatID: String
    public init(role: CoordinatorWorkflowRole, deviceID: String, chatID: String) throws {
        guard Self.validID(deviceID), Self.validID(chatID) else { throw CoordinatorWorkflowError.invalidID }
        self.role = role; self.deviceID = deviceID; self.chatID = chatID
    }
    enum CodingKeys: String, CodingKey { case role; case deviceID = "deviceId"; case chatID = "chatId" }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        try self.init(role: c.decode(CoordinatorWorkflowRole.self, forKey: .role),
                      deviceID: c.decode(String.self, forKey: .deviceID), chatID: c.decode(String.self, forKey: .chatID))
    }
    static func validID(_ value: String) -> Bool { value.range(of: "^[A-Za-z0-9_-]{1,200}$", options: .regularExpression) != nil }
}

public struct CoordinatorWorkflowManifest: Codable, Equatable, Sendable {
    public let version: Int
    public let bindings: [CoordinatorWorkflowBinding]
    public init(version: Int = 1, bindings: [CoordinatorWorkflowBinding]) throws {
        guard version == 1, bindings.map(\.role) == CoordinatorWorkflowRole.allCases,
              Set(bindings.map(\.deviceID)).count == 3, Set(bindings.map(\.chatID)).count == 3 else {
            throw CoordinatorWorkflowError.invalidManifest
        }
        self.version = version; self.bindings = bindings
    }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        try self.init(version: c.decode(Int.self, forKey: .version), bindings: c.decode([CoordinatorWorkflowBinding].self, forKey: .bindings))
    }
    enum CodingKeys: String, CodingKey { case version, bindings }
}

public enum CoordinatorWorkflowState: String, Codable, Sendable {
    case waitingResearch = "waiting_research", running, needsInput = "needs_input", partialFailure = "partial_failure", completed
}
public enum CoordinatorWorkflowRoleState: String, Codable, Sendable {
    case notStarted = "not_started", queued, running, needsInput = "needs_input", completed, failed, cancelled, interrupted
    public var taskStatus: TaskStatus? { TaskStatus(rawValue: rawValue) }
}
public struct CoordinatorWorkflowRoleStatus: Codable, Equatable, Sendable {
    public let role: CoordinatorWorkflowRole; public let deviceID: String; public let chatID: String; public let taskID: String?; public let status: CoordinatorWorkflowRoleState
    enum CodingKeys: String, CodingKey { case role, status; case deviceID = "deviceId"; case chatID = "chatId"; case taskID = "taskId" }
}
public struct CoordinatorWorkflowArtifact: Codable, Equatable, Sendable {
    public let id: String; public let taskID: String; public let chatID: String; public let deviceID: String; public let name: String; public let mime: String; public let size: Int; public let sha256: String; public let revision: Int
    enum CodingKeys: String, CodingKey { case id, name, mime, size, sha256, revision; case taskID = "taskId"; case chatID = "chatId"; case deviceID = "deviceId" }
}
public struct CoordinatorWorkflowStatus: Codable, Equatable, Sendable {
    public let state: CoordinatorWorkflowState; public let requiredRolesCompleted: Int; public let artifactsPublished: Int; public let outputsReady: Bool; public let effectVerification: String; public let roles: [CoordinatorWorkflowRoleStatus]; public let publishedArtifacts: [CoordinatorWorkflowArtifact]
}
