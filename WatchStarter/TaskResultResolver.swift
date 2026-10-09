import Foundation
import WatchCoordinatorAdapter

struct TaskResultSnapshot: Sendable {
    let tasks: [CoordinatorTask]
    let status: TaskStatus
    let spokenText: String
    let workflow: WorkflowProgressSnapshot?
}

struct WorkflowProgressSnapshot: Sendable {
    enum State: Sendable { case waiting, running, needsInput, created, failed, blocked, uncertain }
    struct Row: Sendable {
        let role: CoordinatorWorkflowRole
        let deviceID: String
        let chatID: String
        let taskID: String?
        let state: State
        let artifactNames: [String]
    }
    let rows: [Row]
    let state: State
    let outputsReady: Bool
    let effectVerification: String
}

enum TaskResultError: LocalizedError, Equatable {
    case changedRelationship
    case tooManyTasks
    case workflowMismatch

    var errorDescription: String? {
        switch self {
        case .changedRelationship: return "The task result changed identity. Tap to check it again."
        case .tooManyTasks: return "This request has too many subtasks to read on the Watch. Its result is still available in Providence."
        case .workflowMismatch: return "This workflow changed or is incomplete. Review it in Providence before continuing."
        }
    }
}

/// Reads the full task records, never truncated childUpdates or a parent's plan.
/// This resolver can only fetch status; it has no submission or approval API.
enum TaskResultResolver {
    private static let expiredCodexSessionError = "Your access token could not be refreshed because you have since logged out or signed in to another account. Please sign in again."
    private static let expiredCodexSessionGuidance = "Check the Codex sign-in on the computer handling this request. Review the saved request before trying again."

    private static func spokenError(for task: CoordinatorTask) -> String {
        guard let error = task.error else { return "Task \(task.status.rawValue)." }
        guard error.trimmingCharacters(in: .whitespacesAndNewlines)
            .compare(expiredCodexSessionError, options: .caseInsensitive) == .orderedSame else {
            return error
        }
        return expiredCodexSessionGuidance
    }

    static func resolve(
        root: CoordinatorTask,
        maximumTasks: Int = 64,
        expectedWorkflow: CoordinatorWorkflowManifest? = nil,
        fetch: @Sendable (String) async throws -> CoordinatorTask
    ) async throws -> TaskResultSnapshot {
        guard maximumTasks > 0 else { throw TaskResultError.tooManyTasks }
        var tasks = [root]
        var seen: Set<String> = [root.id]
        var index = 0
        while index < tasks.count {
            try Task.checkCancellation()
            let parent = tasks[index]
            for id in parent.childTaskIDs ?? [] {
                // A cycle, duplicate, or shared child cannot prove a task tree.
                guard !id.isEmpty, seen.insert(id).inserted else { throw TaskResultError.changedRelationship }
                guard tasks.count < maximumTasks else { throw TaskResultError.tooManyTasks }
                let child = try await fetch(id)
                try Task.checkCancellation()
                guard child.id == id, child.parentTaskID == parent.id,
                      !child.chatID.isEmpty, !child.deviceID.isEmpty else {
                    throw TaskResultError.changedRelationship
                }
                tasks.append(child)
            }
            index += 1
        }

        let workflow = try workflowProgress(root: root, tasks: tasks, expected: expectedWorkflow)
        // Include every task's own status AND the server's direct-child aggregate.
        // A stale completed parent cannot hide an active grandchild. A stale
        // running aggregate conservatively waits for the next status read.
        let states = tasks.flatMap { task in [task.status] + (task.workStatus.map { [$0] } ?? []) }
        let priority: [TaskStatus] = [.needsInput, .running, .queued, .interrupted, .failed, .cancelled, .completed]
        let status = priority.first(where: { states.contains($0) }) ?? .running
        let speech: String
        switch status {
        case .queued: speech = "Queued."
        case .running: speech = "Working."
        case .needsInput: speech = "Your request needs a response. Tap to review."
        case .completed:
            let leaves = tasks.filter { ($0.childTaskIDs ?? []).isEmpty }
            let results = leaves.map { task in
                let text = task.text.trimmingCharacters(in: .whitespacesAndNewlines)
                let result = text.isEmpty ? "Finished without a text response." : text
                return leaves.count == 1 ? result : "On \(task.deviceID): \(result)"
            }
            speech = results.joined(separator: "\n\n")
        case .interrupted, .failed, .cancelled:
            speech = tasks.first(where: { $0.status == status }).map(spokenError(for:)) ?? "Task \(status.rawValue)."
        }
        let finalSpeech: String
        if let workflow {
            if let authTask = tasks.first(where: { $0.error?.trimmingCharacters(in: .whitespacesAndNewlines)
                .compare(expiredCodexSessionError, options: .caseInsensitive) == .orderedSame }) {
                finalSpeech = spokenError(for: authTask)
            } else {
                finalSpeech = workflow.outputsReady ? "The brief, comparison, and webpage files are ready." : workflowSpeech(workflow)
            }
        } else { finalSpeech = speech }
        try Task.checkCancellation()
        return TaskResultSnapshot(tasks: tasks, status: status, spokenText: finalSpeech, workflow: workflow)
    }

    private static func workflowSpeech(_ workflow: WorkflowProgressSnapshot) -> String {
        switch workflow.state {
        case .failed: return "The workflow is incomplete because a required computer failed. Review it in Providence."
        case .needsInput: return "The workflow needs a response before its files are ready."
        case .blocked: return "The workflow is incomplete because a required file is missing."
        case .waiting, .running: return "The workflow is still running."
        case .created: return "Some workflow files were created, but the required files are not all ready."
        case .uncertain: return "The workflow status is uncertain. Review it in Providence."
        }
    }

    private static func workflowProgress(root: CoordinatorTask, tasks: [CoordinatorTask], expected: CoordinatorWorkflowManifest?) throws -> WorkflowProgressSnapshot? {
        guard root.workflow != nil || expected != nil || root.workflowStatus != nil else { return nil }
        guard let manifest = root.workflow, manifest == expected, let status = root.workflowStatus,
              status.effectVerification == "not_verified", status.roles.count == 3,
              status.roles.map(\.role) == CoordinatorWorkflowRole.allCases else { throw TaskResultError.workflowMismatch }
        let roleTaskIDs = Set(status.roles.compactMap(\.taskID))
        guard Set(root.childTaskIDs ?? []) == roleTaskIDs,
              Set(status.publishedArtifacts.map(\.id)).count == status.publishedArtifacts.count,
              status.artifactsPublished == status.publishedArtifacts.count else { throw TaskResultError.workflowMismatch }
        var rows: [WorkflowProgressSnapshot.Row] = []
        var allComplete = true
        var allArtifacts = true
        var anyCreated = false
        var failed = false
        var needsInput = false
        let researchFailed = status.roles.first(where: { $0.role == .research })?.status == .failed
        for binding in manifest.bindings {
            guard let role = status.roles.first(where: { $0.role == binding.role }), role.deviceID == binding.deviceID, role.chatID == binding.chatID else { throw TaskResultError.workflowMismatch }
            let child = role.taskID.flatMap { id in tasks.first(where: { $0.id == id }) }
            if role.taskID != nil {
                guard let child, child.deviceID == binding.deviceID, child.chatID == binding.chatID,
                      child.workflowRole == binding.role else { throw TaskResultError.workflowMismatch }
            }
            let artifacts = status.publishedArtifacts.filter { artifact in
                artifact.taskID == role.taskID && artifact.deviceID == binding.deviceID && artifact.chatID == binding.chatID &&
                artifact.size > 0 && !artifact.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
                !artifact.mime.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !artifact.id.isEmpty && artifact.revision > 0 &&
                artifact.sha256.range(of: "^[A-Fa-f0-9]{64}$", options: .regularExpression) != nil
            }
            guard artifacts.count == status.publishedArtifacts.filter({ $0.taskID == role.taskID }).count else { throw TaskResultError.workflowMismatch }
            anyCreated = anyCreated || !artifacts.isEmpty
            allArtifacts = allArtifacts && !artifacts.isEmpty
            let rowState: WorkflowProgressSnapshot.State
            switch role.status {
            case .completed where child?.status == .completed: rowState = artifacts.isEmpty ? .blocked : .created
            case .failed, .cancelled, .interrupted: rowState = .failed; failed = true; allComplete = false
            case .needsInput: rowState = .needsInput; needsInput = true; allComplete = false
            case .notStarted where researchFailed && binding.role != .research: rowState = .blocked; allComplete = false
            case .notStarted: rowState = .waiting; allComplete = false
            case .queued, .running: rowState = .running; allComplete = false
            default: rowState = .uncertain; allComplete = false
            }
            rows.append(.init(role: binding.role, deviceID: binding.deviceID, chatID: binding.chatID, taskID: role.taskID, state: rowState, artifactNames: artifacts.map(\.name)))
        }
        let descendantsCompleted = tasks.dropFirst().allSatisfy { $0.status == .completed && ($0.workStatus == nil || $0.workStatus == .completed) }
        let ready = root.status == .completed && status.state == .completed && status.outputsReady && status.requiredRolesCompleted == 3 && status.artifactsPublished >= 3 && allComplete && allArtifacts && descendantsCompleted
        let parentTerminal = root.status.isTerminal
        let state: WorkflowProgressSnapshot.State = ready ? .created : failed ? .failed : needsInput ? .needsInput : anyCreated ? .created : parentTerminal ? .blocked : status.state == .waitingResearch ? .waiting : .running
        return .init(rows: rows, state: state, outputsReady: ready, effectVerification: status.effectVerification)
    }
}
