import Foundation

/// State shared by microphone callbacks, permission prompts and app lifecycle.
/// Only one finish may own a recording; cancellation revokes all late callbacks.
struct VoiceCaptureLifecycle {
    enum Phase { case idle, preparing, recording, transcribing }
    private(set) var phase: Phase = .idle
    private(set) var generation = UUID()

    mutating func begin() -> UUID? {
        guard phase == .idle else { return nil }
        generation = UUID(); phase = .preparing
        return generation
    }
    mutating func microphoneReady(_ token: UUID) -> Bool {
        guard token == generation, phase == .preparing else { return false }
        phase = .recording; return true
    }
    mutating func finish() -> UUID? {
        guard phase == .recording else { return nil }
        phase = .transcribing; return generation
    }
    func accepts(_ token: UUID) -> Bool { token == generation && phase != .idle }
    mutating func cancel() { generation = UUID(); phase = .idle }
}
