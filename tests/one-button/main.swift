import Foundation
import WatchCoordinatorAdapter

@main struct OneButtonContracts {
    static func main() throws {
        var capture = VoiceCaptureLifecycle()
        let permission = capture.begin()!
        precondition(capture.begin() == nil)
        capture.cancel()
        precondition(!capture.microphoneReady(permission), "late permission must not start recording")
        let first = capture.begin()!
        precondition(capture.microphoneReady(first))
        let submission = capture.finish()!
        precondition(capture.finish() == nil, "manual stop and time-limit delegate cannot upload twice")
        capture.cancel()
        precondition(!capture.accepts(submission), "background/cancel must reject a late transcript")
        let second = capture.begin()!
        precondition(!capture.accepts(first))
        precondition(capture.microphoneReady(second))
        capture.cancel()
        precondition(capture.finish() == nil, "interrupted audio cannot upload")

        var gesture = GooseInteraction()
        precondition(gesture.pressBegan() == .activate, "first physical tap activates once")
        precondition(gesture.pressBegan() == .ignore, "duplicate began cannot resubmit")
        precondition(gesture.pressEnded() == .ignore, "release must leave recording unchanged")
        precondition(gesture.pressBegan() == .activate, "second tap activates once")
        precondition(gesture.pressEnded() == .ignore)
        gesture.pressBegan(); gesture.cancel()
        precondition(gesture.pressBegan() == .activate, "cancelled gesture cannot suppress the next tap")
        precondition(gesture.pressEnded() == .ignore)

        var tapLifecycle = VoiceCaptureLifecycle()
        precondition(GooseInteraction.recordingAction(for: tapLifecycle.phase) == .start)
        let preparing = tapLifecycle.begin()!
        precondition(GooseInteraction.recordingAction(for: tapLifecycle.phase) == .cancelPreparation)
        tapLifecycle.cancel()
        precondition(!tapLifecycle.microphoneReady(preparing), "second tap during preparing must block late permission")
        let recording = tapLifecycle.begin()!
        precondition(tapLifecycle.microphoneReady(recording))
        precondition(GooseInteraction.recordingAction(for: tapLifecycle.phase) == .stop)
        let tapSubmission = tapLifecycle.finish()!
        precondition(GooseInteraction.recordingAction(for: tapLifecycle.phase) == .ignore)
        precondition(tapLifecycle.finish() == nil, "second stop callback cannot submit twice")
        tapLifecycle.cancel()
        precondition(!tapLifecycle.accepts(tapSubmission), "interruption must cancel a pending transcript")

        func task(status: String, work: String? = nil, children: [String] = []) throws -> CoordinatorTask {
            var data: [String: Any] = ["id":"parent", "requestId":"00000000-0000-0000-0000-000000000001", "chatId":"chat", "deviceId":"mac", "status":status, "prompt":"request", "text":"planner finished", "createdAt":"now", "updatedAt":"now", "childTaskIds":children]
            if let work { data["workStatus"] = work }
            return try JSONDecoder().decode(CoordinatorTask.self, from: JSONSerialization.data(withJSONObject:data))
        }
        let running = try task(status:"completed", work:"running", children:["child"])
        let needsInput = try task(status:"completed", work:"needs_input", children:["child"])
        let unknown = try task(status:"completed", children:["child"])
        let done = try task(status:"completed", work:"completed", children:["child"])
        let leaf = try task(status:"completed")
        precondition(MacControlContracts.workStatus(running) == .running)
        precondition(MacControlContracts.workStatus(needsInput) == .needsInput)
        precondition(!MacControlContracts.workStatus(unknown).isTerminal)
        precondition(MacControlContracts.workStatus(done) == .completed)
        precondition(MacControlContracts.workStatus(leaf) == .completed)
        let decisionJSON = #"{"id":"approval-1","taskId":"child","deviceId":"mac","method":"item/tool/requestUserInput","details":{"questions":[{"id":"choice","question":"Send to person@example.com: Hello?","options":[{"label":"Send","description":""},{"label":"Cancel","description":""}]}]},"status":"pending"}"#
        let decision = try JSONDecoder().decode(CoordinatorApproval.self, from: Data(decisionJSON.utf8))
        precondition(MacControlContracts.isSupportedApproval(decision))
        precondition(!MacControlContracts.isBasicApproval(decision))
        precondition(MacControlContracts.decisionQuestion(decision)?.options == ["Send", "Cancel"])
        let duplicate = try JSONDecoder().decode(CoordinatorApproval.self, from: Data(decisionJSON.replacingOccurrences(of: "Cancel", with: "Send").utf8))
        precondition(MacControlContracts.decisionQuestion(duplicate) == nil)
        let freeText = try JSONDecoder().decode(CoordinatorApproval.self, from: Data(decisionJSON.replacingOccurrences(of: #"[{"label":"Send","description":""},{"label":"Cancel","description":""}]"#, with: "[]").utf8))
        precondition(!MacControlContracts.isSupportedApproval(freeText))
        let spoken = "Email the demo contact saying hello"
        let envelope = try VoiceTaskEnvelope.make(spoken)
        precondition(envelope.hasSuffix(spoken))
        precondition(!envelope.contains("providence_request_decision"))
        precondition(envelope.contains("Applicable tool and platform permissions still apply"))
        let prepared = MacPreparedRequest(requestID: UUID(), text: envelope, chatID: "chat", deviceID: "mac", spokenText: spoken)
        let roundTrip = try JSONDecoder().decode(MacPreparedRequest.self, from: JSONEncoder().encode(prepared))
        precondition(roundTrip == prepared)
        let old = try JSONDecoder().decode(MacPreparedRequest.self, from: Data(#"{"requestID":"00000000-0000-0000-0000-000000000001","text":"old request","chatID":"chat","deviceID":"mac"}"#.utf8))
        precondition(old.spokenText == nil && old.text == "old request")

        // Reasoning about a possibly misheard handle must not silently rewrite
        // the actual transcript or the durable request used after a lost ACK.
        let misheard = "Find the Discord profile mirafenn. Do not message anyone."
        let recoveryEnvelope = try VoiceTaskEnvelope.make(misheard)
        precondition(recoveryEnvelope.hasSuffix("User request follows:\n" + misheard))
        let pendingRecovery = MacPreparedRequest(requestID: UUID(), text: recoveryEnvelope,
            chatID: "existing-chat", deviceID: "paired-mac", spokenText: misheard)
        let recoveredRequest = try JSONDecoder().decode(MacPreparedRequest.self,
            from: JSONEncoder().encode(pendingRecovery))
        precondition(recoveredRequest == pendingRecovery)
        precondition(recoveredRequest.spokenText == misheard)

        // The larger recovery policy shares the server's UTF-16 request limit
        // with the transcript. Test the exact boundary, including non-BMP text.
        let prefixUnits = try VoiceTaskEnvelope.make("").utf16.count
        let availableUnits = 8_000 - prefixUnits
        precondition(availableUnits > 0)
        let boundary = String(repeating: "🪿", count: availableUnits / 2)
            + String(repeating: "x", count: availableUnits % 2)
        let boundaryEnvelope = try VoiceTaskEnvelope.make(boundary)
        precondition(boundaryEnvelope.utf16.count == 8_000)
        do {
            _ = try VoiceTaskEnvelope.make(boundary + "x")
            preconditionFailure("Oversized recovery envelope was accepted")
        } catch MacControlError.message { }
        print("One-button lifecycle and delegated completion contracts passed.")
    }
}
