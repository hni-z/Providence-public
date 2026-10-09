import Foundation
import WatchCoordinatorAdapter

/// Presentation never exposes a server body, decoding path, or Swift error domain.
/// The model retains the original error separately in private diagnostics.
enum WatchRecoveryPresentation {
    static func message(for error: Error) -> String {
        if let error = error as? CoordinatorClientError {
            switch error {
            case .invalidBaseURL: return "The connection setup needs attention on your Mac."
            case .missingBearerToken: return "Pair this Watch to reconnect."
            case let .requestNotAccepted(_, reason, _):
                switch reason {
                case "deviceBusy": return "The Mac has unfinished work. Check it before starting this request."
                case "chatBusy": return "This conversation has unfinished work. Wait for it, then try a new request."
                case "macUnavailable", "chatUnavailable": return "The selected Mac is offline. Reconnect it, then try a new request."
                case "staleEvidence", "sessionChanged": return "Recheck iPhone Mirroring on the Mac, then start a new request."
                case "notConfigured", "authenticationRequired", "phoneUnavailable": return "Finish iPhone Mirroring setup on the Mac, then try again."
                case "wrongTarget": return "The selected phone changed. Review its setup on the Mac."
                default: return "The Mac did not accept this request. You can start a new one."
                }
            case .nonHTTPResponse, .malformedResponse:
                return "Providence returned an unreadable update. Check status again."
            case let .unexpectedStatus(code, _):
                switch code {
                case 401: return "Pair this Watch again to reconnect. Your request is saved."
                case 403: return "This Watch cannot access that request. Check access on your Mac."
                case 404: return "That request is unavailable. Check it in Providence on your Mac."
                case 409: return "That request changed. Check its latest status."
                case 429: return "Providence is busy. Wait a moment, then check again."
                case 500...599: return "Providence is temporarily unavailable. Check again shortly."
                default: return "Providence could not accept that update. Check status again."
                }
            case .targetChatOffline: return "The selected conversation is offline. Reconnect it on your Mac."
            case .approvalNotPending, .taskDoesNotNeedInput:
                return "That decision changed. Check its latest status."
            case .approvalTaskMismatch, .targetDeviceMismatch, .responseTargetMismatch,
                 .transcriptionResponseMismatch, .transcriptionIDMismatch:
                return "The reply did not match your request. Check status before continuing."
            case .invalidTranscriptionAudioSize: return "Try a shorter recording."
            case .invalidTranscriptionDeviceID, .invalidTranscriptionID, .tooManySourceChats:
                return "This request needs attention in Providence on your Mac."
            }
        }
        if let error = error as? URLError {
            switch error.code {
            case .notConnectedToInternet, .networkConnectionLost, .cannotConnectToHost, .cannotFindHost, .dnsLookupFailed:
                return "Connection lost. Reconnect, then check your saved request."
            case .timedOut: return "Providence took too long to reply. Check status again."
            case .cancelled: return "Request saved. Check status when ready."
            default: return "The connection could not finish. Check again when connected."
            }
        }
        if error is DecodingError { return "Providence returned an unreadable update. Check status again." }
        // App-defined LocalizedErrors already contain actionable route/mic guidance.
        if let localized = error as? LocalizedError, let message = localized.errorDescription, !message.isEmpty {
            if let recovery = localized.recoverySuggestion, !recovery.isEmpty { return "\(message) \(recovery)" }
            return message
        }
        return "Something interrupted this request. Check status or return to Providence."
    }
}

struct WatchApprovalAttempt: Codable, Equatable {
    let rootTaskID: String
    let taskID: String
    let approvalID: String
    let method: String
    let rootRequestID: String
    let rootDeviceID: String
    let rootChatID: String
    let ownerRequestID: String
    let ownerDeviceID: String
    let ownerChatID: String
    let rootExecutionTarget: IPhoneMirroringExecutionTarget?
    let ownerExecutionTarget: IPhoneMirroringExecutionTarget?

    init(root: CoordinatorTask, owner: CoordinatorTask, approval: CoordinatorApproval) {
        rootTaskID = root.id; taskID = owner.id; approvalID = approval.id; method = approval.method
        rootRequestID = root.requestID; rootDeviceID = root.deviceID; rootChatID = root.chatID
        ownerRequestID = owner.requestID; ownerDeviceID = owner.deviceID; ownerChatID = owner.chatID
        rootExecutionTarget = root.executionTarget; ownerExecutionTarget = owner.executionTarget
    }

    func matches(root: CoordinatorTask, owner: CoordinatorTask) -> Bool {
        rootTaskID == root.id && rootRequestID == root.requestID && rootDeviceID == root.deviceID && rootChatID == root.chatID &&
        taskID == owner.id && ownerRequestID == owner.requestID && ownerDeviceID == owner.deviceID && ownerChatID == owner.chatID &&
        rootExecutionTarget == root.executionTarget && ownerExecutionTarget == owner.executionTarget
    }
}
