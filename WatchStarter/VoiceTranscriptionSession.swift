import Foundation
import Combine
import CryptoKit
import WatchCoordinatorAdapter

struct VoiceCaptureIdentity: Codable, Equatable, Sendable {
    let actionRequestID: UUID
    let transcriptionRequestID: UUID
    let actionDeviceID: String
    let actionChatID: String
    let transcriptionDeviceID: String
}

/// Owns one durable recording until the caller accepts its transcript. Initialization
/// only reads local state; recovery always requires an explicit `recover` call.
@MainActor
final class VoiceTranscriptionSession: ObservableObject {
    @Published private(set) var hasRecovery = false
    var recoveryPurpose: String? { receipt?.purpose }
    var recoveredCaptureIdentity: VoiceCaptureIdentity? { receipt?.captureIdentity }
    var hasCompletedTranscript: Bool { !invalidRecovery && receipt?.transcript != nil }
    var canStartNewRecording: Bool { !busy && !invalidRecovery && !hasRecovery }

    enum SessionError: LocalizedError {
        case busy, recoveryRequired, noRecovery, invalidReceipt, storageFailure
        case invalidAudio, invalidPurpose, deviceSetupRequired, unsupportedAudio
        case identityMismatch, pollingTimedOut, terminalFailure(String)

        var errorDescription: String? {
            switch self {
            case .busy: return "A transcription operation is already in progress."
            case .recoveryRequired: return "Recover the saved recording before starting another."
            case .noRecovery: return "There is no saved recording to recover."
            case .invalidReceipt: return "Saved transcription data is incomplete or changed. It has been preserved; setup needs attention."
            case .storageFailure: return "Transcription recovery data could not be saved or cleared. Setup needs attention."
            case .invalidAudio: return "Record nonempty audio no larger than 512 KiB."
            case .invalidPurpose: return "The recording purpose must be task or legacy."
            case .deviceSetupRequired: return "Select an online device configured for transcription in setup."
            case .unsupportedAudio: return "The transcription device does not support this recording."
            case .identityMismatch: return "The transcription response belongs to a different request or device. Saved data has been preserved."
            case .pollingTimedOut: return "Transcription is still unconfirmed. Tap the button to recover the saved recording."
            case .terminalFailure(let message): return message
            }
        }
    }

    private struct Receipt: Codable {
        let version: Int
        let requestID: UUID
        let deviceID: String
        var captureIdentity: VoiceCaptureIdentity?
        var jobID: String?
        let purpose: String
        let audioBytes: Int
        let audioSHA256: String
        var transcript: String?
    }

    private let directory: URL
    private let pollingInterval: TimeInterval
    private let pollingTimeout: TimeInterval
    private var receipt: Receipt?
    private var invalidRecovery = false
    private var busy = false
    private var receiptURL: URL { directory.appendingPathComponent("receipt.json") }
    private var audioURL: URL { directory.appendingPathComponent("recording.m4a") }

    init(
        directory: URL? = nil,
        pollingInterval: TimeInterval = 1,
        pollingTimeout: TimeInterval = 75
    ) {
        self.directory = directory ?? FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("ProvidenceTranscriptionRecovery", isDirectory: true)
        self.pollingInterval = pollingInterval.isFinite ? max(0.001, pollingInterval) : 1
        self.pollingTimeout = pollingTimeout.isFinite ? min(75, max(0, pollingTimeout)) : 75
        loadRecovery()
    }

    func transcribe(
        audio: Data,
        client: CoordinatorClient,
        preferredDeviceID: String,
        captureIdentity: VoiceCaptureIdentity? = nil,
        purpose: String = "task"
    ) async throws -> String {
        guard !busy else { throw SessionError.busy }
        busy = true
        defer { busy = false }
        try Task.checkCancellation()
        loadRecovery()
        guard !invalidRecovery else { throw SessionError.invalidReceipt }
        guard !hasRecovery else { throw SessionError.recoveryRequired }
        guard !audio.isEmpty && audio.count <= 524_288 else { throw SessionError.invalidAudio }
        guard ["task", "legacy"].contains(purpose) else { throw SessionError.invalidPurpose }

        let availability = try await client.transcriptionAvailability()
        try Task.checkCancellation()
        let eligible = availability.devices.filter { $0.online && $0.configured }
        // The paired device is the audio destination, even when another device
        // is available. Do not upload private recordings to a fallback host.
        let device = eligible.first { $0.id == preferredDeviceID }
        guard availability.available, let device else { throw SessionError.deviceSetupRequired }
        guard availability.mimeTypes.contains("audio/mp4"), audio.count <= availability.maxAudioBytes else {
            throw SessionError.unsupportedAudio
        }
        if let captureIdentity {
            guard captureIdentity.transcriptionDeviceID == device.id,
                  Self.validID(captureIdentity.actionDeviceID), Self.validID(captureIdentity.actionChatID) else {
                throw SessionError.identityMismatch
            }
        }
        let prepared = Receipt(
            version: 1, requestID: captureIdentity?.transcriptionRequestID ?? UUID(), deviceID: device.id, captureIdentity: captureIdentity,
            purpose: purpose, audioBytes: audio.count, audioSHA256: Self.digest(audio)
        )
        do {
            try FileManager.default.createDirectory(
                at: directory, withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700]
            )
            try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
            try audio.write(to: audioURL, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: audioURL.path)
            try save(prepared)
        } catch {
            loadRecovery()
            throw SessionError.storageFailure
        }
        // The receipt and exact bytes must be durable before any POST begins.
        try Task.checkCancellation()
        let job = try await client.submitTranscription(
            requestID: prepared.requestID, deviceID: prepared.deviceID, audio: audio
        )
        return try await finish(initial: job, client: client)
    }

    func recover(client: CoordinatorClient) async throws -> String {
        guard !busy else { throw SessionError.busy }
        busy = true
        defer { busy = false }
        try Task.checkCancellation()
        loadRecovery()
        guard !invalidRecovery else { throw SessionError.invalidReceipt }
        guard let saved = receipt else { throw SessionError.noRecovery }
        if let transcript = saved.transcript {
            try Task.checkCancellation()
            return transcript
        }
        if saved.jobID != nil {
            return try await finish(initial: nil, client: client)
        }
        // An explicit retry after a lost acknowledgement reuses the entire identity.
        let audio = try checkedAudio(for: saved)
        try Task.checkCancellation()
        let job = try await client.submitTranscription(
            requestID: saved.requestID, deviceID: saved.deviceID, audio: audio
        )
        return try await finish(initial: job, client: client)
    }

    /// Call only after accepting the returned transcript. Pending/corrupt data and
    /// active operations cannot be discarded through this method.
    func consume() {
        guard !busy, receipt?.transcript != nil, !invalidRecovery else { return }
        do { try clear() } catch { invalidRecovery = true; hasRecovery = true }
    }

    /// Discards only a verified task transcript that has never crossed the
    /// action POST boundary. The caller must supply the capture identity it
    /// froze before recording; legacy, pending, and mismatched receipts stay.
    func discardCompletedTask(captureIdentity: VoiceCaptureIdentity) -> Bool {
        guard !busy, !invalidRecovery, let saved = receipt, saved.purpose == "task",
              saved.transcript != nil, saved.captureIdentity == captureIdentity else { return false }
        do {
            try clear()
            return !hasRecovery
        } catch { return false }
    }

    private func finish(initial: CoordinatorTranscription?, client: CoordinatorClient) async throws -> String {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: .seconds(pollingTimeout))
        if let initial {
            // Save a returned acknowledgement even when cancellation raced the POST.
            let text = try accept(initial)
            try Task.checkCancellation()
            if let text { return text }
        }
        while true {
            try Task.checkCancellation()
            guard clock.now < deadline else { throw SessionError.pollingTimedOut }
            guard let jobID = receipt?.jobID else { throw SessionError.invalidReceipt }
            let job = try await getJob(client: client, id: jobID, deadline: deadline)
            let text = try accept(job)
            try Task.checkCancellation()
            if let text { return text }
            try await clock.sleep(until: min(deadline, clock.now.advanced(by: .seconds(pollingInterval))))
        }
    }

    private func getJob(
        client: CoordinatorClient, id: String, deadline: ContinuousClock.Instant
    ) async throws -> CoordinatorTranscription {
        try await withThrowingTaskGroup(of: CoordinatorTranscription.self) { group in
            group.addTask { try await client.transcription(id: id) }
            group.addTask {
                try await ContinuousClock().sleep(until: deadline)
                throw SessionError.pollingTimedOut
            }
            defer { group.cancelAll() }
            guard let job = try await group.next() else { throw CancellationError() }
            return job
        }
    }

    private func accept(_ job: CoordinatorTranscription) throws -> String? {
        guard var saved = receipt,
              UUID(uuidString: job.requestID) == saved.requestID,
              job.deviceID == saved.deviceID,
              saved.jobID == nil || UUID(uuidString: saved.jobID!) == UUID(uuidString: job.id)
        else { throw SessionError.identityMismatch }
        switch job.status {
        case .failed, .interrupted:
            try clear()
            throw SessionError.terminalFailure(job.error ?? "Transcription could not finish. Record a new message when ready.")
        case .pending, .completed:
            let changed = saved.jobID == nil || job.status == .completed
            saved.jobID = job.id
            if job.status == .completed { saved.transcript = job.text }
            if changed { try save(saved) }
            return saved.transcript
        }
    }

    private func save(_ value: Receipt) throws {
        do {
            try JSONEncoder().encode(value).write(to: receiptURL, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: receiptURL.path)
            receipt = value
            invalidRecovery = false
            hasRecovery = true
        } catch {
            invalidRecovery = true
            hasRecovery = true
            throw SessionError.storageFailure
        }
    }

    private func loadRecovery() {
        let manager = FileManager.default
        let hasReceipt = manager.fileExists(atPath: receiptURL.path)
        let hasAudio = manager.fileExists(atPath: audioURL.path)
        receipt = nil
        invalidRecovery = false
        hasRecovery = hasReceipt || hasAudio
        guard hasRecovery else { return }
        do {
            guard hasReceipt && hasAudio else { throw SessionError.invalidReceipt }
            let saved = try JSONDecoder().decode(Receipt.self, from: Data(contentsOf: receiptURL))
            guard saved.version == 1, ["task", "legacy"].contains(saved.purpose),
                  !saved.deviceID.isEmpty, saved.deviceID.utf8.count <= 200,
                  saved.deviceID.utf8.allSatisfy({
                      (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 45 || $0 == 95
                  }),
                  saved.jobID == nil || UUID(uuidString: saved.jobID!) != nil,
                  saved.transcript == nil || (saved.jobID != nil && !saved.transcript!.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && saved.transcript!.utf16.count <= 8000)
            else { throw SessionError.invalidReceipt }
            if let identity = saved.captureIdentity {
                guard identity.transcriptionDeviceID == saved.deviceID,
                      Self.validID(identity.actionDeviceID), Self.validID(identity.actionChatID) else {
                    throw SessionError.invalidReceipt
                }
            }
            _ = try checkedAudio(for: saved)
            receipt = saved
        } catch { invalidRecovery = true }
    }

    private func checkedAudio(for saved: Receipt) throws -> Data {
        guard (1...524_288).contains(saved.audioBytes) else { throw SessionError.invalidReceipt }
        let audio = try Data(contentsOf: audioURL)
        guard audio.count == saved.audioBytes, Self.digest(audio) == saved.audioSHA256 else {
            throw SessionError.invalidReceipt
        }
        return audio
    }

    private func clear() throws {
        do {
            // A partial cleanup leaves an invalid receipt and blocks new submissions.
            try FileManager.default.removeItem(at: audioURL)
            try FileManager.default.removeItem(at: receiptURL)
            receipt = nil
            invalidRecovery = false
            hasRecovery = false
        } catch {
            invalidRecovery = true
            hasRecovery = true
            throw SessionError.storageFailure
        }
    }

    private static func digest(_ audio: Data) -> String {
        SHA256.hash(data: audio).map { String(format: "%02x", $0) }.joined()
    }

    private static func validID(_ value: String) -> Bool {
        value.range(of: "^[A-Za-z0-9_-]{1,200}$", options: .regularExpression) != nil
    }
}
