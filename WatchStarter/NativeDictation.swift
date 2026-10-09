import SwiftUI
import AVFoundation

/// Direct microphone entry and speech output. No Watch text-input controller.
@MainActor
final class NativeDictation: NSObject, ObservableObject, AVAudioPlayerDelegate, AVSpeechSynthesizerDelegate {
    @Published private(set) var isPresenting = false
    @Published private(set) var isSpeaking = false
    @Published private(set) var isPreparingReply = false
    @Published private(set) var isOutputPaused = false
    @Published private(set) var voiceStatus: String?
    @Published var error: String?
    var directInput: ((@escaping (String) -> Void) -> Void)?
    private var inputGeneration = UUID()
    private var outputGeneration = VoiceOutputGeneration()
    private var outputTask: Task<Void, Never>?
    private let speaker = AVSpeechSynthesizer()
    private var remotePlayer: AVAudioPlayer?
    private var remotePlaybackGeneration: UUID?
    private var nativeUtterance: AVSpeechUtterance?
    private var nativePlaybackGeneration: UUID?
    private var outputContext: VoiceReplyContext?
    private var fallbackText: String?
    private var cachedRemoteAudio: Data?
    private var remoteSessionActive = false
    private var microphoneActive = false
    private var foreground = true
    private var interruptionObserver: NSObjectProtocol?

    override init() {
        super.init()
        speaker.usesApplicationAudioSession = false
        speaker.delegate = self
        interruptionObserver = NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor [weak self] in self?.stopSpeaking() }
        }
    }

    #if DEBUG
    /// Noninteractive rendering fixture; no provider call or audio playback.
    func previewAppleFallback() {
        stopSpeaking()
        isPreparingReply = false
        isSpeaking = true
        voiceStatus = "Apple voice · fallback"
    }
    #endif

    func collect(_ completion: @escaping (String) -> Void) {
        guard !isPresenting else { return }
        guard let directInput else { error = "Microphone is not ready. Reopen Providence."; return }
        stopSpeaking()
        error = nil
        isPresenting = true
        inputGeneration = UUID()
        let current = inputGeneration
        directInput { [weak self] text in
            guard let self, inputGeneration == current else { return }
            isPresenting = false
            completion(text)
        }
    }

    /// Local prompts/errors never become remote provider requests.
    @discardableResult
    func speak(_ message: String) -> Bool {
        guard canSpeak, let request = try? VoiceSpeechRequest(text: message) else { return false }
        stopSpeaking()
        speakNatively(request.text, status: "Apple voice")
        return true
    }

    /// The caller supplies the verified completed leaf result and its root task ID.
    @discardableResult
    func speakReply(_ text: String, taskID: String, requestID: UUID = UUID()) -> Bool {
        guard canSpeak, !taskID.isEmpty,
              let request = try? VoiceCompletedReplySpeech.request(requestID: requestID, completedReply: text) else { return false }
        clearPlayback(keepingReply: false)
        outputContext = VoiceReplyContext(taskID: taskID, text: text)
        fallbackText = request.text
        cachedRemoteAudio = nil
        let current = outputGeneration.advance()
        isPreparingReply = true
        isSpeaking = false
        voiceStatus = "Preparing ElevenLabs voice"
        outputTask = Task { [weak self] in
            guard let self else { return }
            do {
                let configuration = try ProvidenceCoordinatorConfiguration.load()
                guard let token = try MacControlKeychain.readToken() else { throw VoiceOutputError.unavailable }
                let api = try VoiceOutputAPI(baseURL: configuration.baseURL, token: token)
                defer { api.finish() }
                let capability = try await api.capability()
                guard isCurrent(current) else { return }
                let payload = try VoiceSpeechRequest(requestID: request.requestID, text: request.text, maxUTF16Units: capability.maxSpeechChars)
                let audio = try await api.speech(payload, maximumBytes: capability.speechAudioLimit)
                guard isCurrent(current) else { return }
                try playRemote(audio, generation: current)
            } catch {
                guard isCurrent(current) else { return }
                speakNatively(request.text, status: "Apple voice · fallback")
            }
        }
        return true
    }

    func setMicrophoneActive(_ active: Bool) {
        microphoneActive = active
        if active { stopReplyAndRetain() }
    }

    func taskChanged(_ id: String?) {
        // A new request clears the model before its new task arrives. Keep the
        // last verified reply through that gap; the replacement task is what
        // actually supersedes it.
        if let context = outputContext, let id, context.taskID != id { clearPlayback(keepingReply: false) }
    }

    func replyChanged(_ context: VoiceReplyContext?) {
        if let current = outputContext, let context, current != context { clearPlayback(keepingReply: false) }
    }

    func stopReply() {
        if outputContext != nil { clearPlayback(keepingReply: false) }
    }

    func stopSpeaking() {
        clearPlayback(keepingReply: false)
    }

    func stopReplyAndRetain() {
        clearPlayback(keepingReply: true)
    }

    @discardableResult
    func toggleReplyPlayback(_ text: String, taskID: String) -> Bool {
        let context = VoiceReplyContext(taskID: taskID, text: text)
        guard canSpeak else { return false }
        if outputContext != context { return speakReply(text, taskID: taskID) }
        if isPreparingReply {
            _ = outputGeneration.advance()
            outputTask?.cancel(); outputTask = nil
            isPreparingReply = false; isOutputPaused = true; voiceStatus = "Paused"
            return true
        }
        if isSpeaking {
            if let player = remotePlayer { player.pause() }
            else if speaker.isSpeaking { speaker.pauseSpeaking(at: .immediate) }
            else {
                // The provider request was still preparing. Revoke that
                // generation so its late audio cannot start after a pause.
                _ = outputGeneration.advance()
                outputTask?.cancel(); outputTask = nil
            }
            isSpeaking = false; isOutputPaused = true; voiceStatus = "Paused"
            return true
        }
        if isOutputPaused {
            if let player = remotePlayer, player.play() {
                isSpeaking = true; isOutputPaused = false; voiceStatus = "ElevenLabs voice"
                return true
            }
            if speaker.isPaused, speaker.continueSpeaking() {
                isSpeaking = true; isOutputPaused = false; voiceStatus = "Apple voice · fallback"
                return true
            }
            return replayRetainedReply()
        }
        return replayRetainedReply()
    }

    private func replayRetainedReply() -> Bool {
        if let audio = cachedRemoteAudio {
            remotePlayer?.stop(); remotePlayer = nil; remotePlaybackGeneration = nil
            do { try replayRemote(audio); return true }
            catch { deactivateRemoteSession() }
        }
        if let fallbackText, canSpeak {
            speakNatively(fallbackText, status: "Apple voice · fallback")
            return true
        }
        return false
    }

    private func clearPlayback(keepingReply: Bool) {
        _ = outputGeneration.advance()
        outputTask?.cancel(); outputTask = nil
        remotePlayer?.stop(); remotePlayer = nil; remotePlaybackGeneration = nil
        deactivateRemoteSession()
        nativeUtterance = nil; nativePlaybackGeneration = nil
        speaker.stopSpeaking(at: .immediate)
        if !keepingReply { outputContext = nil; fallbackText = nil; cachedRemoteAudio = nil }
        isSpeaking = false; isPreparingReply = false; isOutputPaused = false; voiceStatus = nil
    }

    func cancelInput() { inputGeneration = UUID(); isPresenting = false }

    func sceneChanged(_ scene: ScenePhase) {
        foreground = scene == .active
        if scene != .active { stopReplyAndRetain() }
        if scene == .background { cancelInput() }
    }

    var canBeginSpeech: Bool { canSpeak }
    private var canSpeak: Bool { foreground && !isPresenting && !microphoneActive }
    private func isCurrent(_ id: UUID) -> Bool { canSpeak && outputGeneration.accepts(id) && !Task.isCancelled }

    private func playRemote(_ data: Data, generation current: UUID) throws {
        guard isCurrent(current) else { return }
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playback, mode: .default)
        try session.setActive(true)
        remoteSessionActive = true
        let player = try AVAudioPlayer(data: data)
        player.delegate = self
        guard player.prepareToPlay(), player.play() else { throw VoiceOutputError.invalidResponse }
        remotePlayer = player
        cachedRemoteAudio = data
        remotePlaybackGeneration = current
        isSpeaking = true; isPreparingReply = false; isOutputPaused = false
        voiceStatus = "ElevenLabs voice"
    }

    private func speakNatively(_ text: String, status: String) {
        guard canSpeak else { return }
        remotePlayer?.stop(); remotePlayer = nil; remotePlaybackGeneration = nil
        deactivateRemoteSession()
        nativeUtterance = nil; nativePlaybackGeneration = nil
        speaker.stopSpeaking(at: .immediate)
        let utterance = AVSpeechUtterance(string: text)
        nativeUtterance = utterance
        nativePlaybackGeneration = outputGeneration.value
        isSpeaking = true; isPreparingReply = false; isOutputPaused = false; voiceStatus = status
        speaker.speak(utterance)
    }

    private func replayRemote(_ data: Data) throws {
        let current = outputGeneration.advance()
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playback, mode: .default)
        try session.setActive(true)
        remoteSessionActive = true
        let player = try AVAudioPlayer(data: data)
        player.delegate = self
        guard player.prepareToPlay(), player.play() else { throw VoiceOutputError.invalidResponse }
        remotePlayer = player; remotePlaybackGeneration = current
        isSpeaking = true; isPreparingReply = false; isOutputPaused = false; voiceStatus = "ElevenLabs voice"
    }

    private func deactivateRemoteSession() {
        guard remoteSessionActive else { return }
        try? AVAudioSession.sharedInstance().setActive(false)
        remoteSessionActive = false
    }

    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        let id = ObjectIdentifier(player)
        Task { @MainActor [weak self] in self?.finishRemote(id, failed: !flag) }
    }

    nonisolated func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        let id = ObjectIdentifier(player)
        Task { @MainActor [weak self] in self?.finishRemote(id, failed: true) }
    }

    private func finishRemote(_ id: ObjectIdentifier, failed: Bool) {
        guard let player = remotePlayer, ObjectIdentifier(player) == id,
              let current = remotePlaybackGeneration, isCurrent(current) else { return }
        remotePlayer = nil; remotePlaybackGeneration = nil; outputTask = nil
        deactivateRemoteSession()
        if failed, let fallbackText {
            speakNatively(fallbackText, status: "Apple voice · fallback")
        } else {
            isSpeaking = false; isPreparingReply = false; isOutputPaused = false; voiceStatus = nil
        }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        let speakerID = ObjectIdentifier(synthesizer), utteranceID = ObjectIdentifier(utterance)
        Task { @MainActor [weak self] in self?.finishNative(speakerID: speakerID, utteranceID: utteranceID) }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        speechSynthesizer(synthesizer, didFinish: utterance)
    }

    private func finishNative(speakerID: ObjectIdentifier, utteranceID: ObjectIdentifier) {
        guard speakerID == ObjectIdentifier(speaker), let utterance = nativeUtterance,
              utteranceID == ObjectIdentifier(utterance), let current = nativePlaybackGeneration,
              isCurrent(current) else { return }
        nativeUtterance = nil; nativePlaybackGeneration = nil; outputTask = nil
        isSpeaking = false; isPreparingReply = false; isOutputPaused = false; voiceStatus = nil
    }
}
