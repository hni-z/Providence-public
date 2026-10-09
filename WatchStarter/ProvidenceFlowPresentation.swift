import Foundation

/// A read-only projection of product state. Visual timing must never create,
/// approve, retry, or finish a request.
enum ProvidenceFlowStage: String, CaseIterable, Equatable {
    case idle, preparing, listening, transcribing, routing, running
    case approval, clarification, preparingReply, speaking, success, paused, recoverableError

    var title: String {
        switch self {
        case .idle: return "Tap to talk"
        case .preparing: return "Opening microphone"
        case .listening: return "Listening"
        case .transcribing: return "Transcribing"
        case .routing: return "Sending request"
        case .running: return "Working"
        case .approval: return "Your approval needed"
        case .clarification: return "A quick question"
        case .preparingReply: return "Preparing reply"
        case .speaking: return "Speaking"
        case .success: return "Done"
        case .paused: return "Reply paused"
        case .recoverableError: return "Needs attention"
        }
    }
}

struct ProvidenceFlowSnapshot {
    enum Capture { case idle, preparing, recording, transcribing }
    enum Work { case none, queued, running, needsInput, completed, failed }
    enum Decision { case none, approval, clarification }

    var capture: Capture = .idle
    var work: Work = .none
    var decision: Decision = .none
    var reconcilingDecision = false
    var hasError = false
    var recoveryDismissed = false
    var needsRecovery = false
    var preparingReply = false
    var speaking = false
    var paused = false
    var busy = false
    var recoveringRecording = false
    var hasPendingTask = false
    var successResting = false

    var stage: ProvidenceFlowStage {
        switch capture {
        case .preparing: return .preparing
        case .recording: return .listening
        case .transcribing: return .transcribing
        case .idle: break
        }
        // A dismissed problem remains recoverable; a visual reset must not
        // discard its request identity or synthesize success.
        if recoveryDismissed && needsRecovery { return .idle }
        if hasError || work == .failed || reconcilingDecision { return .recoverableError }
        if decision == .clarification { return .clarification }
        if decision == .approval { return .approval }
        if work == .needsInput { return .recoverableError }
        // Speech is only a result presentation after reconciled completion.
        // A late audio callback cannot hide fresh work or a pending decision.
        if work == .completed {
            if preparingReply { return .preparingReply }
            if speaking { return .speaking }
            if paused { return .paused }
            return successResting ? .idle : .success
        }
        if recoveringRecording { return .transcribing }
        if work == .running { return .running }
        if work == .queued || busy || hasPendingTask { return .routing }
        return .idle
    }
}
