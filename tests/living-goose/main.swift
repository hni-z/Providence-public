import Foundation

@main struct LivingGooseContracts {
    static func main() {
        var state = ProvidenceFlowSnapshot()
        precondition(state.stage == .idle)
        state.capture = .preparing
        precondition(state.stage == .preparing)
        state.capture = .recording
        state.work = .completed
        state.speaking = true
        precondition(state.stage == .listening, "capture must hide a retained old result")
        state.capture = .transcribing
        precondition(state.stage == .transcribing)
        state.capture = .idle
        state.work = .running
        precondition(state.stage == .running, "stale playback cannot mark running work successful")
        state.work = .queued
        precondition(state.stage == .routing)
        state.work = .needsInput
        precondition(state.stage == .recoverableError, "missing approval cannot invite a decision")
        state.decision = .approval
        precondition(state.stage == .approval, "a pending decision cannot animate success")
        state.decision = .clarification
        precondition(state.stage == .clarification)
        state.work = .completed
        precondition(state.stage == .clarification, "completion cannot hide an unresolved decision")
        state.decision = .none
        state.reconcilingDecision = true
        precondition(state.stage == .recoverableError, "posted decision reconciliation is not a fresh approval")
        state.reconcilingDecision = false
        state.preparingReply = true
        precondition(state.stage == .preparingReply)
        state.preparingReply = false
        precondition(state.stage == .speaking)
        state.speaking = false
        state.paused = true
        precondition(state.stage == .paused)
        state.paused = false
        precondition(state.stage == .success)
        state.successResting = true
        precondition(state.stage == .idle)
        precondition(state.work == .completed, "visual rest preserves the result for replay")
        state.hasError = true
        precondition(state.stage == .recoverableError)
        state.recoveryDismissed = true
        state.needsRecovery = true
        precondition(state.stage == .idle)
        precondition(state.hasError && state.work == .completed, "dismissal is presentation only")
        state.recoveryDismissed = false
        state.hasError = false
        state.work = .failed
        precondition(state.stage == .recoverableError)
        state.work = .none
        state.hasPendingTask = true
        precondition(state.stage == .routing, "unknown accepted request cannot celebrate")
        state.recoveringRecording = true
        precondition(state.stage == .transcribing)
        print("Living goose state-safety checks passed.")
    }
}
