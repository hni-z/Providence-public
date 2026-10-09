import SwiftUI
import AVFoundation
import WatchKit

/// Direct microphone capture. Nothing is dispatched by Apple's text input UI.
@MainActor
final class VoiceCapture: NSObject, ObservableObject, AVAudioRecorderDelegate {
    typealias Phase = VoiceCaptureLifecycle.Phase
    @Published private(set) var phase: Phase = .idle
    @Published private(set) var level = 0.0
    @Published private(set) var errorMessage: String?
    private var recorder: AVAudioRecorder?
    private var file: URL?
    private var work: Task<Void, Never>?
    private var meter: Task<Void, Never>?
    private var lifecycle = VoiceCaptureLifecycle()
    private var active = true
    private var startedAt: Date?
    private var interruptionObserver: NSObjectProtocol?
    private var transcribe: ((Data) async throws -> String)?
    private var completion: ((String) -> Void)?

    override init() {
        super.init()
        interruptionObserver = NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self, phase == .recording || phase == .preparing else { return }
                fail("Recording interrupted. Tap to try again.")
            }
        }
    }

    func start(transcribe: @escaping (Data) async throws -> String, completion: @escaping (String) -> Void) {
        guard phase == .idle, active else { return }
        cancel()
        errorMessage = nil
        self.transcribe = transcribe
        self.completion = completion
        guard let current = lifecycle.begin() else { return }
        phase = lifecycle.phase
        work = Task { [weak self] in
            guard let self else { return }
            do {
                let allowed = await AVAudioApplication.requestRecordPermission()
                guard isCurrent(current) else { return }
                guard allowed else { throw MacControlError.message("Allow microphone access in Watch settings.") }
                let session = AVAudioSession.sharedInstance()
                try session.setCategory(.record, mode: .default)
                guard try await session.activate(options: []) else { throw MacControlError.message("Microphone unavailable. Try again.") }
                guard isCurrent(current) else { try? session.setActive(false); return }
                let url = FileManager.default.temporaryDirectory.appendingPathComponent("providence-voice-\(UUID()).m4a")
                file = url
                let audio = try AVAudioRecorder(url: url, settings: [
                    AVFormatIDKey: kAudioFormatMPEG4AAC,
                    AVSampleRateKey: 16_000, AVNumberOfChannelsKey: 1,
                    AVEncoderBitRateKey: 32_000,
                    AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue
                ])
                audio.delegate = self
                audio.isMeteringEnabled = true
                guard audio.prepareToRecord(), audio.record(forDuration: 30) else {
                    throw MacControlError.message("Microphone unavailable. Try again.")
                }
                guard lifecycle.microphoneReady(current) else { audio.stop(); return }
                recorder = audio
                startedAt = Date()
                phase = lifecycle.phase
                WKInterfaceDevice.current().play(.start)
                meter = Task { [weak self] in
                    while !Task.isCancelled {
                        guard let self, isCurrent(current), let recorder, phase == .recording else { return }
                        recorder.updateMeters()
                        level = max(0, min(1, Double(recorder.averagePower(forChannel: 0) + 55) / 55))
                        try? await Task.sleep(for: .milliseconds(100))
                    }
                }
            } catch { if isCurrent(current) { fail(error.localizedDescription) } }
        }
    }

    /// Intentional release (or the 30 second recording limit) submits once.
    func finish() {
        if phase == .preparing {
            // A release during permission/session setup is an incomplete hold.
            // Revoke its generation before a late permission can open audio.
            cancel()
            return
        }
        guard active, phase == .recording, let audio = recorder, let file,
              let transcribe, let completion else { return }
        let duration = max(audio.currentTime, min(30, startedAt.map { Date().timeIntervalSince($0) } ?? 0))
        recorder = nil
        audio.stop()
        meter?.cancel()
        level = 0
        try? AVAudioSession.sharedInstance().setActive(false)
        WKInterfaceDevice.current().play(.stop)
        guard duration >= 0.25 else { fail("I didn't catch that. Tap and speak again."); return }
        guard let current = lifecycle.finish() else { return }
        phase = lifecycle.phase
        work = Task { [weak self] in
            guard let self else { return }
            do {
                let data = try Data(contentsOf: file)
                guard !data.isEmpty, data.count <= 524_288 else { throw MacControlError.message("Recording is too large. Try a shorter request.") }
                let text = try await transcribe(data).trimmingCharacters(in: .whitespacesAndNewlines)
                guard isCurrent(current) else { return }
                guard !text.isEmpty, text.count <= 8000 else { throw MacControlError.message("I didn't catch that. Tap and speak again.") }
                cleanup()
                lifecycle.cancel()
                phase = lifecycle.phase
                self.completion = nil
                self.transcribe = nil
                completion(text)
            } catch {
                guard isCurrent(current) else { return }
                fail(error.localizedDescription)
            }
        }
    }

    func cancel() {
        lifecycle.cancel()
        work?.cancel(); work = nil
        cleanup()
        phase = .idle
        transcribe = nil; completion = nil
    }

    func sceneChanged(_ scene: ScenePhase) {
        // A permission alert temporarily makes the app inactive. Backgrounding
        // cancels every phase; wrist lowering cancels an active recording.
        active = scene != .background
        if scene == .background || (scene == .inactive && phase == .recording) { cancel() }
    }

    nonisolated func audioRecorderDidFinishRecording(_ recorder: AVAudioRecorder, successfully flag: Bool) {
        let id = ObjectIdentifier(recorder)
        Task { @MainActor [weak self] in
            guard let self, let current = self.recorder, ObjectIdentifier(current) == id else { return }
            if flag { finish() } else { fail("Recording interrupted. Tap to try again.") }
        }
    }

    nonisolated func audioRecorderEncodeErrorDidOccur(_ recorder: AVAudioRecorder, error: Error?) {
        let id = ObjectIdentifier(recorder)
        Task { @MainActor [weak self] in
            guard let self, let current = self.recorder, ObjectIdentifier(current) == id else { return }
            fail("Recording failed. Tap to try again.")
        }
    }

    private func isCurrent(_ id: UUID) -> Bool { active && lifecycle.accepts(id) && !Task.isCancelled }
    private func fail(_ message: String) { cancel(); errorMessage = message; WKInterfaceDevice.current().play(.failure) }
    private func cleanup() {
        let audio = recorder; recorder = nil; audio?.stop()
        meter?.cancel(); meter = nil
        level = 0
        startedAt = nil
        try? AVAudioSession.sharedInstance().setActive(false)
        if let file { try? FileManager.default.removeItem(at: file) }
        file = nil
    }
}
