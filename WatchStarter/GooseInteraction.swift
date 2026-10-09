import Foundation

/// Pure tap policy for the single Watch control. A release only resets touch
/// state; recording changes happen on the next tap.
struct GooseInteraction {
    enum PressResult: Equatable { case activate, ignore }
    enum RecordingAction: Equatable { case start, stop, cancelPreparation, ignore }

    private(set) var isPressed = false

    @discardableResult
    mutating func pressBegan() -> PressResult {
        guard !isPressed else { return .ignore }
        isPressed = true
        return .activate
    }

    @discardableResult
    mutating func pressEnded() -> PressResult {
        isPressed = false
        return .ignore
    }

    mutating func cancel() { isPressed = false }

    static func recordingAction(for phase: VoiceCaptureLifecycle.Phase) -> RecordingAction {
        switch phase {
        case .idle: return .start
        case .recording: return .stop
        case .preparing: return .cancelPreparation
        case .transcribing: return .ignore
        }
    }
}
