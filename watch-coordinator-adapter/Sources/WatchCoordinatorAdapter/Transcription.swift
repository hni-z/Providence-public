import Foundation

public struct TranscriptionAvailability: Decodable, Equatable, Sendable {
    public let available: Bool
    public let devices: [TranscriptionDevice]
    public let mimeTypes: [String]
    public let maxAudioBytes: Int
    public let provider: String
}

public struct TranscriptionDevice: Decodable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let online: Bool
    public let configured: Bool
}

public enum TranscriptionStatus: String, Codable, CaseIterable, Sendable {
    case pending
    case completed
    case failed
    case interrupted

    public var isTerminal: Bool { self != .pending }
}

public struct CoordinatorTranscription: Decodable, Equatable, Sendable {
    public let id: String
    public let requestID: String
    public let deviceID: String
    public let status: TranscriptionStatus
    public let text: String
    public let error: String?
    public let errorCode: String?

    enum CodingKeys: String, CodingKey {
        case id, status, text, error, errorCode
        case requestID = "requestId"
        case deviceID = "deviceId"
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        requestID = try values.decode(String.self, forKey: .requestID)
        deviceID = try values.decode(String.self, forKey: .deviceID)
        status = try values.decode(TranscriptionStatus.self, forKey: .status)
        text = try values.decode(String.self, forKey: .text)
        error = try values.decodeIfPresent(String.self, forKey: .error)
        errorCode = try values.decodeIfPresent(String.self, forKey: .errorCode)

        for (key, value) in [(CodingKeys.id, id), (.requestID, requestID)] {
            guard UUID(uuidString: value) != nil else {
                throw DecodingError.dataCorruptedError(
                    forKey: key, in: values, debugDescription: "Expected a UUID identity"
                )
            }
        }
        guard isValidTranscriptionDeviceID(deviceID) else {
            throw DecodingError.dataCorruptedError(
                forKey: .deviceID, in: values, debugDescription: "Invalid transcription device identity"
            )
        }
        // The coordinator's JavaScript limit counts UTF-16 code units.
        guard text.utf16.count <= 8000 else {
            throw DecodingError.dataCorruptedError(
                forKey: .text, in: values, debugDescription: "Transcript exceeds 8000 characters"
            )
        }
        if status == .completed && text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            throw DecodingError.dataCorruptedError(
                forKey: .text, in: values, debugDescription: "Completed transcript must be nonempty"
            )
        }
    }
}

func isValidTranscriptionDeviceID(_ value: String) -> Bool {
    !value.isEmpty && value.utf8.count <= 200 && value.utf8.allSatisfy {
        (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0)
            || $0 == 45 || $0 == 95
    }
}
