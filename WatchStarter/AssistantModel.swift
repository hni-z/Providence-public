import SwiftUI
import AVFoundation
import WatchKit

@MainActor
final class AssistantModel: NSObject, ObservableObject, AVAudioRecorderDelegate {
    enum Phase { case idle, preparing, recording, recorded, uploading, processing, ready, error }
    @Published var phase: Phase = .idle
    @Published var duration: TimeInterval = 0
    @Published var level: Double = 0
    @Published var job: AssistantJob?
    @Published var errorMessage: String?
    @Published var connection = "Connection not checked"
    @Published var approval: SendApproval?
    @Published var busy = false
    @Published private(set) var preparedVoice: PreparedVoiceRequest?
    @Published private(set) var rememberedContact: ContactProposal?
    @Published private(set) var sendNeedsRefresh = false
    private var recorder: AVAudioRecorder?
    private var meterTask: Task<Void, Never>?
    private var networkTask: Task<Void, Never>?
    private var networkGeneration = UUID()
    private var interruptionObserver: NSObjectProtocol?
    private var active = true
    private var recordGeneration = UUID()
    private var recordingID: String?
    private var pendingID: String?
    private let defaults = UserDefaults.standard
    private var api: AssistantAPI?
    private let directory: URL
    private var lastHapticJob: String?

    var hasPendingRequest: Bool { pendingID != nil }
    var canStartNewRequest: Bool {
        !busy && preparedVoice == nil && !sendNeedsRefresh && job?.send.status != "submitting"
    }

    var hasRecording: Bool {
        guard let recordingID else { return false }
        return FileManager.default.fileExists(atPath: recordingURL(recordingID).path)
    }
    var statusText: String {
        switch phase {
        case .idle: return "Ready when you are"
        case .preparing: return "Opening microphone"
        case .recording: return "Recording on Watch"
        case .recorded: return "Recording stays here"
        case .uploading: return preparedVoice == nil ? "Uploading recording" : "Preparing your email"
        case .processing: return "Preparing your email"
        case .ready: return "Your email"
        case .error: return "Needs attention"
        }
    }
    override init() {
        directory = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("ProvidenceAudio", isDirectory: true)
        super.init()
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            api = AssistantAPI(configuration: try DemoConfiguration.load())
            recordingID = defaults.string(forKey: "recordingID")
            pendingID = defaults.string(forKey: "pendingID")
            if let data = defaults.data(forKey: "voice.preparedRequest") {
                preparedVoice = try JSONDecoder().decode(PreparedVoiceRequest.self, from: data)
            }
            sendNeedsRefresh = defaults.bool(forKey: "voice.sendNeedsRefresh")
            duration = defaults.double(forKey: "recordingDuration")
            for url in (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? [] {
                if url.lastPathComponent != recordingID.map({ "\($0).m4a" }) { try? FileManager.default.removeItem(at: url) }
            }
            if hasRecording { phase = .recorded }
            interruptionObserver = NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor [weak self] in self?.stopRecording() }
            }
        } catch { fail(error) }
    }
    private func recordingURL(_ id: String) -> URL { directory.appendingPathComponent("\(id).m4a") }

    @discardableResult
    func submitVoice(_ text: String) -> Bool {
        guard !busy, active, api != nil, pendingID == nil else { return false }
        do {
            let prepared = try PreparedVoiceRequest(text: text)
            defaults.set(try JSONEncoder().encode(prepared), forKey: "voice.preparedRequest")
            preparedVoice = prepared
            pendingID = prepared.requestID
            defaults.set(prepared.requestID, forKey: "pendingID")
            retryVoice()
            return true
        } catch { fail(error); return false }
    }

    func retryVoice() {
        guard !busy, active, let api, let prepared = preparedVoice else { return }
        let operation = beginOperation()
        errorMessage = nil
        phase = .uploading
        networkTask = Task {
            defer { finishOperation(operation) }
            do {
                let received = try await api.submitVoice(prepared)
                guard operation == networkGeneration, active else { return }
                accept(received)
                if !["ready", "error", "expired"].contains(received.status) {
                    await poll(id: prepared.requestID, operation: operation)
                }
            } catch {
                if active, operation == networkGeneration {
                    fail(AssistantError.message("Draft request outcome is unknown. Check status, or retry the same saved request. \(error.localizedDescription)"))
                }
            }
        }
    }

    func clarify(_ text: String, for reviewed: AssistantJob) {
        guard !busy, active, let api, job?.id == reviewed.id, job?.version == reviewed.version else { return }
        let operation = beginOperation()
        approval = nil
        rememberedContact = nil
        errorMessage = nil
        networkTask = Task {
            defer { finishOperation(operation) }
            do {
                let received = try await api.clarify(reviewed, text: text)
                guard operation == networkGeneration, active else { return }
                accept(received)
            } catch {
                if active, operation == networkGeneration {
                    errorMessage = "Clarification not confirmed. Refresh status before trying again. \(error.localizedDescription)"
                }
            }
        }
    }

    func remember(_ confirmed: ContactProposal, for reviewed: AssistantJob) {
        guard !busy, active, let api, job?.id == reviewed.id, job?.version == reviewed.version else { return }
        let operation = beginOperation()
        errorMessage = nil
        networkTask = Task {
            defer { finishOperation(operation) }
            do {
                let contact = try await api.remember(confirmed, for: reviewed)
                guard operation == networkGeneration, active else { return }
                rememberedContact = contact
            } catch {
                if active, operation == networkGeneration { errorMessage = error.localizedDescription }
            }
        }
    }
    func sceneChanged(_ scene: ScenePhase) {
        active = scene == .active
        if active {
            if pendingID != nil { resume() }
        } else {
            // Interruptions and wrist lowering never grant upload consent.
            recordGeneration = UUID()
            stopRecording()
            if phase == .preparing { phase = .idle }
            networkGeneration = UUID()
            networkTask?.cancel()
            busy = false
            approval = nil
        }
    }
    func startRecording() {
        guard !busy, phase == .idle || phase == .error, api != nil else { return }
        discardRecording()
        errorMessage = nil
        phase = .preparing
        let generation = UUID()
        recordGeneration = generation
        Task {
            do {
                let allowed = await AVAudioApplication.requestRecordPermission()
                guard active, generation == recordGeneration else { return }
                guard allowed else { throw AssistantError.message("Microphone access is off. Allow Providence in Watch microphone settings.") }
                let session = AVAudioSession.sharedInstance()
                try session.setCategory(.record, mode: .default, options: [])
                guard try await session.activate(options: []) else { throw AssistantError.message("The Watch microphone could not start.") }
                guard active, generation == recordGeneration else { return }
                let id = UUID().uuidString.lowercased()
                recordingID = id
                defaults.set(id, forKey: "recordingID")
                let audio = try AVAudioRecorder(url: recordingURL(id), settings: [
                    AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 16_000,
                    AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 32_000,
                    AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue
                ])
                audio.delegate = self
                audio.isMeteringEnabled = true
                guard audio.prepareToRecord(), audio.record(forDuration: 30) else { throw AssistantError.message("Could not record audio. Try again while the app is open.") }
                recorder = audio
                duration = 0
                phase = .recording
                meterTask = Task { [weak self] in
                    while !Task.isCancelled {
                        guard let self, let recorder = self.recorder, self.phase == .recording else { return }
                        recorder.updateMeters()
                        self.duration = min(30, recorder.currentTime)
                        self.level = max(0, min(1, Double(recorder.averagePower(forChannel: 0) + 55) / 55))
                        try? await Task.sleep(for: .milliseconds(150))
                    }
                }
            } catch {
                guard generation == recordGeneration else { return }
                discardRecording(); fail(error)
            }
        }
    }
    func stopRecording() {
        guard phase == .recording, let audio = recorder else { return }
        duration = max(duration, audio.currentTime)
        recorder = nil
        audio.stop()
        meterTask?.cancel()
        try? AVAudioSession.sharedInstance().setActive(false)
        defaults.set(duration, forKey: "recordingDuration")
        phase = .recorded
        level = 0
    }
    nonisolated func audioRecorderDidFinishRecording(_ recorder: AVAudioRecorder, successfully flag: Bool) {
        let identity = ObjectIdentifier(recorder)
        Task { @MainActor [weak self] in
            guard let self, let current = self.recorder, ObjectIdentifier(current) == identity, self.phase == .recording else { return }
            if flag { self.stopRecording() }
            else { self.discardRecording(); self.fail(AssistantError.message("Recording was interrupted or failed. Please try again.")) }
        }
    }
    nonisolated func audioRecorderEncodeErrorDidOccur(_ recorder: AVAudioRecorder, error: Error?) {
        let identity = ObjectIdentifier(recorder)
        Task { @MainActor [weak self] in
            guard let self, let current = self.recorder, ObjectIdentifier(current) == identity else { return }
            self.discardRecording()
            self.fail(AssistantError.message("The Watch could not save this recording. Please try again."))
        }
    }
    func discardRecording() {
        recordGeneration = UUID()
        meterTask?.cancel()
        let audio = recorder
        recorder = nil
        if phase == .recording || phase == .preparing { phase = .idle }
        audio?.stop()
        try? AVAudioSession.sharedInstance().setActive(false)
        if let recordingID { try? FileManager.default.removeItem(at: recordingURL(recordingID)) }
        recordingID = nil
        defaults.removeObject(forKey: "recordingID")
        defaults.removeObject(forKey: "recordingDuration")
        duration = 0
        level = 0
        if phase == .recorded { phase = .idle }
    }
    func upload() {
        guard !busy, let api, let recordingID, hasRecording else { return }
        let operation = beginOperation()
        errorMessage = nil
        pendingID = recordingID
        defaults.set(recordingID, forKey: "pendingID")
        phase = .uploading
        networkTask = Task {
            defer { finishOperation(operation) }
            do {
                let data = try Data(contentsOf: recordingURL(recordingID))
                guard data.count > 16, data.count <= 5 * 1024 * 1024 else { throw AssistantError.message("Recording is empty or too large. Discard it and record again.") }
                let received: AssistantJob = try await api.request("api/jobs/audio", method: "POST", body: data, requestID: recordingID, audio: true)
                guard operation == networkGeneration, active else { return }
                discardRecording()
                accept(received)
                await poll(id: recordingID, operation: operation)
            } catch is CancellationError { }
            catch { if active, operation == networkGeneration { fail(error) } }
        }
    }
    func resume() {
        guard !busy, let id = pendingID else { return }
        let operation = beginOperation()
        errorMessage = nil
        networkTask = Task { defer { finishOperation(operation) }; await poll(id: id, operation: operation) }
    }
    private func poll(id: String, operation: UUID) async {
        guard let api else { return }
        do {
            while active && !Task.isCancelled {
                let received: AssistantJob = try await api.request("api/jobs/\(id)")
                guard operation == networkGeneration, active else { return }
                guard received.id == id else { throw AssistantError.message("The returned email does not match this request.") }
                if recordingID == id { discardRecording() }
                accept(received)
                if ["ready", "error", "expired"].contains(received.status), received.send.status != "submitting" { return }
                try await Task.sleep(for: .seconds(2))
            }
        } catch is CancellationError { }
        catch { if active, operation == networkGeneration { fail(error) } }
    }
    private func accept(_ received: AssistantJob) {
        if job?.id != received.id || job?.version != received.version { approval = nil; rememberedContact = nil }
        if preparedVoice?.requestID == received.id {
            preparedVoice = nil
            defaults.removeObject(forKey: "voice.preparedRequest")
        }
        sendNeedsRefresh = false
        defaults.removeObject(forKey: "voice.sendNeedsRefresh")
        job = received
        if received.status == "error" { phase = .error; errorMessage = received.error }
        else if received.status == "ready" || received.status == "expired" {
            phase = .ready
            if active, lastHapticJob != received.id, received.status == "ready" {
                WKInterfaceDevice.current().play(.success)
                lastHapticJob = received.id
            }
        } else { phase = .processing }
    }
    func checkConnection() {
        guard !busy, let api else { return }
        let operation = beginOperation()
        networkTask = Task {
            defer { finishOperation(operation) }
            do {
                let result: ServerConfiguration = try await api.request("api/config")
                guard operation == networkGeneration, active else { return }
                connection = result.sendingEnabled ? "Connected · Mail enabled" : "Connected · drafts only"
            } catch { if operation == networkGeneration, active { connection = "Cannot reach backend"; errorMessage = error.localizedDescription } }
        }
    }
    func prepareSend() {
        guard !busy, active, !sendNeedsRefresh, let api, let job,
              VoiceContracts.isEditable(job), VoiceContracts.followUp(job) == nil else { return }
        let operation = beginOperation()
        errorMessage = nil
        networkTask = Task {
            defer { finishOperation(operation) }
            do {
                let payload = try JSONSerialization.data(withJSONObject: ["version": job.version])
                let received: SendApproval = try await api.request("api/jobs/\(job.id)/approval", method: "POST", body: payload)
                guard operation == networkGeneration, active else { return }
                guard VoiceContracts.matches(received, job: job) else {
                    throw AssistantError.message("The email changed. Refresh and review its current contents.")
                }
                approval = received
            } catch { if operation == networkGeneration, active { errorMessage = error.localizedDescription } }
        }
    }
    func saveRecipient(_ address: String, for reviewedJob: AssistantJob) async -> Bool {
        guard !busy, active, let api else { return false }
        guard job?.id == reviewedJob.id, job?.version == reviewedJob.version else {
            errorMessage = "This draft changed. Refresh status and review the latest version."
            return false
        }
        let operation = beginOperation()
        approval = nil
        errorMessage = nil
        defer { finishOperation(operation) }
        do {
            let payload = try JSONEncoder().encode(RecipientUpdate(job: reviewedJob, address: address))
            let received: AssistantJob = try await api.request("api/jobs/\(reviewedJob.id)", method: "PATCH", body: payload)
            guard operation == networkGeneration, active else { return false }
            accept(received)
            return true
        } catch {
            if operation == networkGeneration, active { errorMessage = error.localizedDescription }
            return false
        }
    }
    func confirmSend(_ reviewed: SendApproval) {
        guard !busy, active, !sendNeedsRefresh, let api, let job,
              approval?.token == reviewed.token, VoiceContracts.matches(reviewed, job: job) else { return }
        approval = nil
        sendNeedsRefresh = true
        defaults.set(true, forKey: "voice.sendNeedsRefresh")
        let operation = beginOperation()
        errorMessage = nil
        networkTask = Task {
            defer { finishOperation(operation) }
            do {
                let payload = try JSONSerialization.data(withJSONObject: ["version": reviewed.version, "approvalToken": reviewed.token])
                let received: AssistantJob = try await api.request("api/jobs/\(job.id)/send", method: "POST", body: payload)
                guard operation == networkGeneration, active else { return }
                accept(received)
                if active { WKInterfaceDevice.current().play(received.send.status == "submitted" ? .success : .failure) }
            } catch { if operation == networkGeneration, active { errorMessage = "Send result unavailable. Refresh status before starting another email. \(error.localizedDescription)" } }
        }
    }
    func newRequest() {
        guard canStartNewRequest else { return }
        networkGeneration = UUID()
        networkTask?.cancel()
        discardRecording()
        pendingID = nil
        defaults.removeObject(forKey: "pendingID")
        job = nil
        approval = nil
        rememberedContact = nil
        errorMessage = nil
        busy = false
        phase = api == nil ? .error : .idle
    }
    private func beginOperation() -> UUID {
        networkTask?.cancel()
        let value = UUID()
        networkGeneration = value
        busy = true
        return value
    }
    private func finishOperation(_ operation: UUID) {
        if operation == networkGeneration { busy = false }
    }
    private func fail(_ error: Error) { errorMessage = error.localizedDescription; phase = .error }
}
