import Foundation
import WatchCoordinatorAdapter

actor FixtureReader {
    let records: [String: CoordinatorTask]
    private(set) var reads: [String] = []
    init(_ records: [String: CoordinatorTask]) { self.records = records }
    func read(_ id: String) throws -> CoordinatorTask {
        reads.append(id)
        guard let task = records[id] else { throw URLError(.networkConnectionLost) }
        return task
    }
}

@main struct TaskResultTests {
    static func fixture(_ id: String, status: String = "completed", work: String? = nil,
                        text: String = "result", parent: String? = nil, children: [String] = [],
                        error: String? = nil) throws -> CoordinatorTask {
        var json: [String: Any] = ["id": id, "requestId": "00000000-0000-0000-0000-000000000001",
            "chatId": "chat-\(id)", "deviceId": "mac-\(id)", "status": status,
            "text": text, "prompt": "test", "createdAt": "now", "updatedAt": "now", "childTaskIds": children]
        if let work { json["workStatus"] = work }
        if let parent { json["parentTaskId"] = parent }
        if let error { json["error"] = error }
        return try JSONDecoder().decode(CoordinatorTask.self, from: JSONSerialization.data(withJSONObject: json))
    }

    static func main() async throws {
        let expiredSessionError = "Your access token could not be refreshed because you have since logged out or signed in to another account. Please sign in again."
        let expiredSessionGuidance = "Check the Codex sign-in on the computer handling this request. Review the saved request before trying again."
        let workflow = try CoordinatorWorkflowManifest(bindings: [
            CoordinatorWorkflowBinding(role: .research, deviceID: "research-device", chatID: "research-chat"),
            CoordinatorWorkflowBinding(role: .analysis, deviceID: "analysis-device", chatID: "analysis-chat"),
            CoordinatorWorkflowBinding(role: .presentation, deviceID: "presentation-device", chatID: "presentation-chat")
        ])
        func workflowTask(_ id: String, status: String, parent: String? = nil, role: String? = nil,
                          children: [String] = [], workflowStatus: [String: Any]? = nil, error: String? = nil) throws -> CoordinatorTask {
            var value: [String: Any] = ["id": id, "requestId": "00000000-0000-0000-0000-000000000001", "chatId": role.map { "\($0)-chat" } ?? "root-chat", "deviceId": role.map { "\($0)-device" } ?? "root-device", "status": status, "prompt": "workflow", "text": "The model says everything is done", "createdAt": "now", "updatedAt": "now", "childTaskIds": children]
            if let parent { value["parentTaskId"] = parent }
            if let role { value["workflowRole"] = role }
            if let workflowStatus {
                value["workflow"] = ["version": 1, "bindings": [["role": "research", "deviceId": "research-device", "chatId": "research-chat"], ["role": "analysis", "deviceId": "analysis-device", "chatId": "analysis-chat"], ["role": "presentation", "deviceId": "presentation-device", "chatId": "presentation-chat"]]]
                value["workflowStatus"] = workflowStatus
            }
            if let error { value["error"] = error }
            return try JSONDecoder().decode(CoordinatorTask.self, from: JSONSerialization.data(withJSONObject: value))
        }
        func workflowStatus(_ state: String, roles: [[String: Any]], artifacts: [[String: Any]] = []) -> [String: Any] {
            ["state": state, "requiredRolesCompleted": roles.filter { $0["status"] as? String == "completed" }.count,
             "artifactsPublished": artifacts.count, "outputsReady": state == "completed", "effectVerification": "not_verified", "roles": roles, "publishedArtifacts": artifacts]
        }
        let waitingRoles: [[String: Any]] = ["research", "analysis", "presentation"].map { ["role": $0, "deviceId": "\($0)-device", "chatId": "\($0)-chat", "status": "not_started"] }
        let admitted = try workflowTask("workflow-root", status: "queued", workflowStatus: workflowStatus("waiting_research", roles: waitingRoles))
        let admittedSnapshot = try await TaskResultResolver.resolve(root: admitted, expectedWorkflow: workflow, fetch: { _ in fatalError("Initial workflow has no children") })
        precondition(admittedSnapshot.workflow?.state == .waiting && admittedSnapshot.spokenText.contains("still running"))

        let roleNames = ["research", "analysis", "presentation"]
        let completeRoles: [[String: Any]] = roleNames.map { ["role": $0, "deviceId": "\($0)-device", "chatId": "\($0)-chat", "taskId": "\($0)-task", "status": "completed"] }
        let artifacts: [[String: Any]] = roleNames.map { ["id": "\($0)-artifact", "taskId": "\($0)-task", "chatId": "\($0)-chat", "deviceId": "\($0)-device", "name": "\($0).txt", "mime": "text/plain", "size": 1, "sha256": String(repeating: "a", count: 64), "revision": 1] }
        let workflowRoot = try workflowTask("workflow-root", status: "completed", children: roleNames.map { "\($0)-task" }, workflowStatus: workflowStatus("completed", roles: completeRoles, artifacts: artifacts))
        let workflowChildren = Dictionary(uniqueKeysWithValues: try roleNames.map { role in
            ("\(role)-task", try workflowTask("\(role)-task", status: "completed", parent: "workflow-root", role: role))
        })
        let ready = try await TaskResultResolver.resolve(root: workflowRoot, expectedWorkflow: workflow, fetch: { id in workflowChildren[id]! })
        precondition(ready.workflow?.outputsReady == true && ready.spokenText == "The brief, comparison, and webpage files are ready.")

        var mutableRunningChildren = workflowChildren
        mutableRunningChildren["analysis-task"] = try workflowTask("analysis-task", status: "running", parent: "workflow-root", role: "analysis")
        let runningChildren = mutableRunningChildren
        let activeReader = FixtureReader(runningChildren)
        let active = try await TaskResultResolver.resolve(root: workflowRoot, expectedWorkflow: workflow, fetch: { id in try await activeReader.read(id) })
        precondition(active.workflow?.outputsReady == false && !active.spokenText.contains("files are ready"))
        var grandchildRecords = workflowChildren
        grandchildRecords["analysis-task"] = try workflowTask("analysis-task", status: "completed", parent: "workflow-root", role: "analysis", children: ["analysis-grandchild"])
        grandchildRecords["analysis-grandchild"] = try workflowTask("analysis-grandchild", status: "running", parent: "analysis-task")
        let grandchildReader = FixtureReader(grandchildRecords)
        let activeGrandchild = try await TaskResultResolver.resolve(root: workflowRoot, expectedWorkflow: workflow, fetch: { id in try await grandchildReader.read(id) })
        precondition(activeGrandchild.workflow?.outputsReady == false && !activeGrandchild.spokenText.contains("files are ready"))

        let failedRoles: [[String: Any]] = [["role": "research", "deviceId": "research-device", "chatId": "research-chat", "taskId": "research-task", "status": "failed"], waitingRoles[1], waitingRoles[2]]
        let failedRoot = try workflowTask("failed-root", status: "completed", children: ["research-task"], workflowStatus: workflowStatus("partial_failure", roles: failedRoles))
        let failedChild = try workflowTask("research-task", status: "failed", parent: "failed-root", role: "research")
        let failedReader = FixtureReader(["research-task": failedChild])
        let failed = try await TaskResultResolver.resolve(root: failedRoot, expectedWorkflow: workflow, fetch: { id in try await failedReader.read(id) })
        precondition(failed.workflow?.state == .failed && failed.workflow?.rows.dropFirst().allSatisfy { $0.state == .blocked } == true)

        let invalidArtifacts = artifacts.enumerated().map { index, artifact -> [String: Any] in var value = artifact; if index == 0 { value["sha256"] = "bad" }; return value }
        let invalidRoot = try workflowTask("invalid-root", status: "completed", children: roleNames.map { "\($0)-task" }, workflowStatus: workflowStatus("completed", roles: completeRoles, artifacts: invalidArtifacts))
        let invalidChildren = Dictionary(uniqueKeysWithValues: try roleNames.map { role in ("\(role)-task", try workflowTask("\(role)-task", status: "completed", parent: "invalid-root", role: role)) })
        let invalidReader = FixtureReader(invalidChildren)
        do { _ = try await TaskResultResolver.resolve(root: invalidRoot, expectedWorkflow: workflow, fetch: { id in try await invalidReader.read(id) }); preconditionFailure("Invalid artifact produced ready workflow") }
        catch TaskResultError.workflowMismatch { }

        let duplicateArtifactRoot = try workflowTask("duplicate-root", status: "completed", children: roleNames.map { "\($0)-task" }, workflowStatus: workflowStatus("completed", roles: completeRoles, artifacts: artifacts + [artifacts[0]]))
        let duplicateChildren = Dictionary(uniqueKeysWithValues: try roleNames.map { role in ("\(role)-task", try workflowTask("\(role)-task", status: "completed", parent: "duplicate-root", role: role)) })
        let duplicateReader = FixtureReader(duplicateChildren)
        do { _ = try await TaskResultResolver.resolve(root: duplicateArtifactRoot, expectedWorkflow: workflow, fetch: { id in try await duplicateReader.read(id) }); preconditionFailure("Duplicate artifact accepted") } catch TaskResultError.workflowMismatch { }
        let emptyArtifacts = artifacts.enumerated().map { index, artifact -> [String: Any] in var value = artifact; if index == 1 { value["name"] = "" }; return value }
        let emptyRoot = try workflowTask("empty-root", status: "completed", children: roleNames.map { "\($0)-task" }, workflowStatus: workflowStatus("completed", roles: completeRoles, artifacts: emptyArtifacts))
        let emptyChildren = Dictionary(uniqueKeysWithValues: try roleNames.map { role in ("\(role)-task", try workflowTask("\(role)-task", status: "completed", parent: "empty-root", role: role)) })
        let emptyReader = FixtureReader(emptyChildren)
        do { _ = try await TaskResultResolver.resolve(root: emptyRoot, expectedWorkflow: workflow, fetch: { id in try await emptyReader.read(id) }); preconditionFailure("Empty artifact accepted") } catch TaskResultError.workflowMismatch { }

        let extraRoot = try workflowTask("extra-root", status: "completed", children: roleNames.map { "\($0)-task" } + ["extra-task"], workflowStatus: workflowStatus("completed", roles: completeRoles, artifacts: artifacts))
        var extraRecords = Dictionary(uniqueKeysWithValues: try roleNames.map { role in ("\(role)-task", try workflowTask("\(role)-task", status: "completed", parent: "extra-root", role: role)) })
        extraRecords["extra-task"] = try workflowTask("extra-task", status: "completed", parent: "extra-root")
        let extraReader = FixtureReader(extraRecords)
        do { _ = try await TaskResultResolver.resolve(root: extraRoot, expectedWorkflow: workflow, fetch: { id in try await extraReader.read(id) }); preconditionFailure("Unexpected direct child accepted") } catch TaskResultError.workflowMismatch { }
        let missingRoleRoot = try workflowTask("missing-root", status: "completed", workflowStatus: workflowStatus("completed", roles: Array(completeRoles.dropLast()), artifacts: []))
        do { _ = try await TaskResultResolver.resolve(root: missingRoleRoot, expectedWorkflow: workflow, fetch: { _ in fatalError() }); preconditionFailure("Missing terminal role accepted") } catch TaskResultError.workflowMismatch { }
        let otherManifest = try CoordinatorWorkflowManifest(bindings: [
            CoordinatorWorkflowBinding(role: .research, deviceID: "other", chatID: "other-chat"),
            CoordinatorWorkflowBinding(role: .analysis, deviceID: "analysis-device", chatID: "analysis-chat"),
            CoordinatorWorkflowBinding(role: .presentation, deviceID: "presentation-device", chatID: "presentation-chat")])
        do { _ = try await TaskResultResolver.resolve(root: workflowRoot, expectedWorkflow: otherManifest, fetch: { id in workflowChildren[id]! }); preconditionFailure("Changed manifest accepted") } catch TaskResultError.workflowMismatch { }

        let parallelRoles: [[String: Any]] = [["role": "research", "deviceId": "research-device", "chatId": "research-chat", "taskId": "research-task", "status": "completed"], ["role": "analysis", "deviceId": "analysis-device", "chatId": "analysis-chat", "taskId": "analysis-task", "status": "failed"], ["role": "presentation", "deviceId": "presentation-device", "chatId": "presentation-chat", "taskId": "presentation-task", "status": "completed"]]
        let parallelRoot = try workflowTask("parallel-root", status: "completed", children: roleNames.map { "\($0)-task" }, workflowStatus: workflowStatus("partial_failure", roles: parallelRoles, artifacts: [artifacts[0], artifacts[2]]))
        let parallelChildren = Dictionary(uniqueKeysWithValues: try roleNames.map { role in ("\(role)-task", try workflowTask("\(role)-task", status: role == "analysis" ? "failed" : "completed", parent: "parallel-root", role: role, error: role == "analysis" ? expiredSessionError : nil)) })
        let parallelReader = FixtureReader(parallelChildren)
        let parallel = try await TaskResultResolver.resolve(root: parallelRoot, expectedWorkflow: workflow, fetch: { id in try await parallelReader.read(id) })
        precondition(parallel.workflow?.state == .failed && parallel.workflow?.rows.first?.state == .created && parallel.spokenText == expiredSessionGuidance)
        let root = try fixture("root", work: "completed", text: "I will ask a worker", children: ["child"])
        let child = try fixture("child", text: "The browser opened Example Domain.", parent: "root")
        let reader = FixtureReader(["child": child])
        let complete = try await TaskResultResolver.resolve(root: root, fetch: { id in try await reader.read(id) })
        precondition(complete.status == .completed && complete.spokenText == child.text)
        precondition(!complete.spokenText.contains(root.text))
        let reads = await reader.reads
        precondition(reads == ["child"])

        for status in ["queued", "running", "needs_input"] {
            let current = try fixture("child", status: status, text: "unfinished text", parent: "root")
            let r = FixtureReader(["child": current])
            let snapshot = try await TaskResultResolver.resolve(root: root, fetch: { id in try await r.read(id) })
            precondition(!snapshot.status.isTerminal)
            precondition(!snapshot.spokenText.contains("unfinished text"))
        }
        for status in ["failed", "cancelled", "interrupted"] {
            let current = try fixture("child", status: status, parent: "root", error: "Actual \(status) outcome")
            let r = FixtureReader(["child": current])
            let snapshot = try await TaskResultResolver.resolve(root: root, fetch: { id in try await r.read(id) })
            precondition(snapshot.status.rawValue == status)
            precondition(snapshot.spokenText == "Actual \(status) outcome")
        }

        let directExpiredSession = try fixture("root", status: "failed", error: expiredSessionError)
        let directExpiredSnapshot = try await TaskResultResolver.resolve(root: directExpiredSession, fetch: { _ in
            preconditionFailure("A direct failure should not fetch a child")
        })
        precondition(directExpiredSnapshot.status == .failed)
        precondition(directExpiredSnapshot.spokenText == expiredSessionGuidance)
        precondition(directExpiredSnapshot.tasks.first?.error == expiredSessionError)
        precondition(directExpiredSnapshot.tasks.first?.id == "root")
        precondition(directExpiredSnapshot.tasks.first?.requestID == "00000000-0000-0000-0000-000000000001")
        precondition(directExpiredSnapshot.tasks.first?.deviceID == "mac-root")
        precondition(directExpiredSnapshot.tasks.first?.chatID == "chat-root")

        let authChild = try fixture("child", status: "failed", parent: "root",
                                    error: expiredSessionError.uppercased())
        let delegatedExpired = FixtureReader(["child": authChild])
        let delegatedExpiredSnapshot = try await TaskResultResolver.resolve(root: root, fetch: { id in
            try await delegatedExpired.read(id)
        })
        precondition(delegatedExpiredSnapshot.status == .failed)
        precondition(delegatedExpiredSnapshot.spokenText == expiredSessionGuidance)
        precondition(delegatedExpiredSnapshot.tasks.last?.error == expiredSessionError.uppercased())
        precondition(delegatedExpiredSnapshot.tasks.last?.id == "child")
        precondition(delegatedExpiredSnapshot.tasks.last?.requestID == "00000000-0000-0000-0000-000000000001")
        precondition(delegatedExpiredSnapshot.tasks.last?.deviceID == "mac-child")
        precondition(delegatedExpiredSnapshot.tasks.last?.chatID == "chat-child")

        for (status, expectedSpeech) in [("queued", "Queued."), ("running", "Working."),
                                         ("completed", "Completed despite stale error.")] {
            let staleError = try fixture("root", status: status, text: "Completed despite stale error.",
                                         error: expiredSessionError)
            let snapshot = try await TaskResultResolver.resolve(root: staleError, fetch: { _ in
                preconditionFailure("A direct task should not fetch a child")
            })
            precondition(snapshot.status.rawValue == status)
            precondition(snapshot.spokenText == expectedSpeech)
        }

        let failedWithoutError = try fixture("root", status: "failed")
        let failedWithoutErrorSnapshot = try await TaskResultResolver.resolve(root: failedWithoutError, fetch: { _ in
            preconditionFailure("A direct task should not fetch a child")
        })
        precondition(failedWithoutErrorSnapshot.spokenText == "Task failed.")

        let authLikeButDifferent = try fixture("root", status: "failed",
                                                error: "Your access token could not be refreshed. Please sign in again.")
        let authLikeSnapshot = try await TaskResultResolver.resolve(root: authLikeButDifferent, fetch: { _ in
            preconditionFailure("An unrelated direct failure should not fetch a child")
        })
        precondition(authLikeSnapshot.spokenText == authLikeButDifferent.error)

        let intermediate = try fixture("child", text: "Another plan", parent: "root", children: ["grandchild"])
        let grandchild = try fixture("grandchild", text: "Actual nested result", parent: "child")
        let nested = FixtureReader(["child": intermediate, "grandchild": grandchild])
        let nestedResult = try await TaskResultResolver.resolve(root: root, fetch: { id in try await nested.read(id) })
        precondition(nestedResult.spokenText == "Actual nested result")
        let pendingNested = FixtureReader(["child": intermediate,
            "grandchild": try fixture("grandchild", status: "needs_input", parent: "child")])
        let pendingResult = try await TaskResultResolver.resolve(root: root, fetch: { id in try await pendingNested.read(id) })
        precondition(pendingResult.status == .needsInput)

        let staleAggregate = try fixture("root", work: "running", children: ["child"])
        let waiting = try await TaskResultResolver.resolve(root: staleAggregate, fetch: { id in try await reader.read(id) })
        precondition(waiting.status == .running)
        let multiRoot = try fixture("root", children: ["child", "other"])
        let multi = FixtureReader(["child": child, "other": try fixture("other", text: "Second result", parent: "root")])
        let multiple = try await TaskResultResolver.resolve(root: multiRoot, fetch: { id in try await multi.read(id) })
        precondition(multiple.spokenText.contains(child.text) && multiple.spokenText.contains("Second result"))
        precondition(multiple.spokenText.contains("mac-child") && multiple.spokenText.contains("mac-other"))

        let badRecords = [
            ["child": try fixture("wrong-id", parent: "root")],
            ["child": try fixture("child", parent: "other")],
            ["child": try fixture("child", parent: "root", children: ["root"])],
        ]
        for records in badRecords {
            let r = FixtureReader(records)
            do { _ = try await TaskResultResolver.resolve(root: root, fetch: { id in try await r.read(id) }); preconditionFailure("Accepted wrong relationship") }
            catch TaskResultError.changedRelationship { }
        }
        let duplicateRoot = try fixture("root", children: ["child", "child"])
        do { _ = try await TaskResultResolver.resolve(root: duplicateRoot, fetch: { id in try await reader.read(id) }); preconditionFailure("Accepted duplicate child") }
        catch TaskResultError.changedRelationship { }
        do { _ = try await TaskResultResolver.resolve(root: root, maximumTasks: 1, fetch: { id in try await reader.read(id) }); preconditionFailure("Ignored bound") }
        catch TaskResultError.tooManyTasks { }
        let offline = FixtureReader([:])
        do { _ = try await TaskResultResolver.resolve(root: root, fetch: { id in try await offline.read(id) }); preconditionFailure("Invented a missing result") }
        catch is URLError { }

        let cancelled = Task {
            try await TaskResultResolver.resolve(root: root) { id in
                try await Task.sleep(for: .seconds(10))
                return child
            }
        }
        cancelled.cancel()
        do { _ = try await cancelled.value; preconditionFailure("Returned a cancelled result") }
        catch is CancellationError { }
        print("Task result resolution passed: actual leaf results, nested work, state priority, identity, bounds, cancellation and missing results.")
    }
}
