import Foundation

struct VoiceAutomaticSpeechReservation: Codable, Equatable {
    let taskID: String
    let textDigest: String
    let requestID: UUID
}

enum VoiceAutomaticSpeechError: LocalizedError {
    case invalidReceipt
    var errorDescription: String? { "Automatic speech could not safely resume. Choose Hear result to play it." }
}

/// A task gets one automatic provider attempt. Failure, fallback and cancellation
/// never erase its reservation. Manual replay is a separate, explicit operation.
@MainActor
final class VoiceAutomaticSpeechLedger {
    private struct Receipt: Codable {
        let version: Int
        let reservations: [VoiceAutomaticSpeechReservation]
    }
    private let directory: URL
    private var file: URL { directory.appendingPathComponent("automatic-speech.json") }

    init(directory: URL? = nil) {
        self.directory = directory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("ProvidenceVoiceOutput", isDirectory: true)
    }

    /// Atomic reservation completes synchronously before the caller may POST.
    func reserve(_ context: VoiceReplyContext, requestID: UUID = UUID()) throws -> VoiceAutomaticSpeechReservation? {
        guard !context.taskID.isEmpty else { throw VoiceAutomaticSpeechError.invalidReceipt }
        let manager = FileManager.default
        var reservations: [VoiceAutomaticSpeechReservation] = []
        if manager.fileExists(atPath: file.path) {
            let saved: Receipt
            do {
                let data = try Data(contentsOf: file)
                guard data.count <= 512 * 1024 else { throw VoiceAutomaticSpeechError.invalidReceipt }
                saved = try JSONDecoder().decode(Receipt.self, from: data)
                guard saved.version == 1, saved.reservations.count <= 1024,
                      Set(saved.reservations.map(\.taskID)).count == saved.reservations.count,
                      saved.reservations.allSatisfy({
                          !$0.taskID.isEmpty && $0.textDigest.count == 64 && $0.textDigest.allSatisfy(\.isHexDigit)
                      }) else {
                    throw VoiceAutomaticSpeechError.invalidReceipt
                }
            } catch { throw VoiceAutomaticSpeechError.invalidReceipt }
            // A corrected result invalidates old playback, but is not permission
            // for a second automatic billable request for this task.
            reservations = saved.reservations
            if reservations.contains(where: { $0.taskID == context.taskID }) { return nil }
        }
        // Never evict a consumed identity and accidentally allow another automatic
        // provider call. Explicit replay still works if the ledger reaches capacity.
        guard reservations.count < 1024 else { throw VoiceAutomaticSpeechError.invalidReceipt }
        let reservation = VoiceAutomaticSpeechReservation(taskID: context.taskID, textDigest: context.textDigest, requestID: requestID)
        try manager.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try manager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
        reservations.append(reservation)
        let data = try JSONEncoder().encode(Receipt(version: 1, reservations: reservations))
        try data.write(to: file, options: .atomic)
        try manager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        return reservation
    }
}
