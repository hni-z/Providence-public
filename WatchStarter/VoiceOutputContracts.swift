import Foundation
import CryptoKit
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

enum VoiceOutputError: LocalizedError {
    case unavailable
    case invalidResponse
    case message(String)

    var errorDescription: String? {
        switch self {
        case .unavailable: return "Providence speech is unavailable."
        case .invalidResponse: return "Providence returned invalid speech audio."
        case let .message(value): return value
        }
    }
}

struct VoiceServiceCapability: Decodable, Equatable {
    let provider: String
    let configured: Bool
    let voice: String
    let deviceID: String
    let maxSpeechChars: Int
    let maxAudioBytes: Int
    let maxSpeechAudioBytes: Int?

    enum CodingKeys: String, CodingKey {
        case provider, configured, voice
        case deviceID = "deviceId"
        case maxSpeechChars, maxAudioBytes, maxSpeechAudioBytes
    }

    var speechAudioLimit: Int { maxSpeechAudioBytes ?? VoiceOutputAPI.maximumSpeechAudioBytes }

    var supportsElevenLabs: Bool {
        configured && provider == "ElevenLabs" && !voice.isEmpty && !deviceID.isEmpty &&
        maxSpeechChars > 0 && maxSpeechChars <= 4_000 && maxAudioBytes > 0 && maxAudioBytes <= VoiceOutputAPI.maximumSpeechAudioBytes &&
        speechAudioLimit > 0 && speechAudioLimit <= VoiceOutputAPI.maximumSpeechAudioBytes
    }
}

struct VoiceSpeechRequest: Encodable, Equatable {
    let requestID: UUID
    let text: String

    enum CodingKeys: String, CodingKey { case requestID = "requestId", text }

    init(requestID: UUID = UUID(), text: String, maxUTF16Units: Int = VoiceSpeechText.maxUTF16Units) throws {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            throw VoiceOutputError.message("Speech replies cannot be empty.")
        }
        guard maxUTF16Units > 0, maxUTF16Units <= VoiceSpeechText.maxUTF16Units else { throw VoiceOutputError.unavailable }
        self.requestID = requestID
        self.text = VoiceSpeechText.truncated(trimmed, limit: maxUTF16Units)
        guard !self.text.isEmpty else { throw VoiceOutputError.message("Speech replies cannot be empty.") }
    }
}

enum VoiceSpeechText {
    static let maxUTF16Units = 4_000

    /// Zod/JavaScript measures String.length in UTF-16 code units. Iterate by
    /// Character so a truncation never splits an emoji or combining sequence.
    static func truncated(_ value: String, limit: Int = maxUTF16Units) -> String {
        guard limit > 0 else { return "" }
        guard value.utf16.count > limit else { return value }
        var result = ""
        var used = 0
        for character in value {
            let count = String(character).utf16.count
            guard used + count <= limit else { break }
            result.append(character)
            used += count
        }
        return result
    }
}

/// Shapes a verified task result for speech without changing the result that is
/// displayed, retained, or used to identify its task. Links remain available in
/// Providence's written reply, but their URL syntax is not useful speech.
enum VoiceCompletedReplySpeech {
    static let linksOnlyFallback = "The response includes links. View them in Providence."

    static func request(requestID: UUID = UUID(), completedReply: String, maxUTF16Units: Int = VoiceSpeechText.maxUTF16Units) throws -> VoiceSpeechRequest {
        try VoiceSpeechRequest(
            requestID: requestID,
            text: presentationText(for: completedReply),
            maxUTF16Units: maxUTF16Units
        )
    }

    static func presentationText(for completedReply: String) -> String {
        guard containsLinkSyntax(in: completedReply) else {
            return completedReply.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        var value = removeMarkdownSourceDefinitions(from: completedReply)
        value = replaceMarkdownLinks(in: value)
        value = replaceMatches(in: value, pattern: #"\[([^\]\n]+)\]\[[^\]\n]*\]"#) { match in
            guard let opening = match.firstIndex(of: "["), let closing = match.firstIndex(of: "]") else { return match }
            return String(match[match.index(after: opening)..<closing])
        }
        value = replaceMatches(in: value, pattern: #"(?i)<(?:https?://|www\.)[^>\s]+>"#) { _ in "" }
        value = replaceMatches(in: value, pattern: #"(?i)\(?(?:https?://|www\.)[^\s<>]+"#) { speechSuffix(afterURL: $0) }
        value = normalizeWhitespace(value)
        return containsMeaningfulText(value) ? value : linksOnlyFallback
    }

    private static func removeMarkdownSourceDefinitions(from value: String) -> String {
        replaceMatches(in: value, pattern: #"(?im)^\s*\[[^\]\n]+\]:\s*<?(?:https?://|www\.)\S+.*(?:\n|$)"#) { _ in "" }
    }

    private static func replaceMarkdownLinks(in value: String) -> String {
        replaceMatches(in: value, pattern: #"(?i)\[([^\]\n]+)\]\(\s*<?(?:https?://|www\.)[^\s)>]+>?[^)]*\)"#) { match in
            guard let expression = try? NSRegularExpression(pattern: #"^\[([^\]\n]+)\]"#),
                  let result = expression.firstMatch(in: match, range: NSRange(match.startIndex..., in: match)),
                  let range = Range(result.range(at: 1), in: match) else { return "" }
            return String(match[range])
        }
    }

    private static func normalizeWhitespace(_ value: String) -> String {
        value
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map { line in
                line
                    .replacingOccurrences(of: #"\s{2,}"#, with: " ", options: .regularExpression)
                    .replacingOccurrences(of: #"\s+([,.;:!?])"#, with: "$1", options: .regularExpression)
                    .replacingOccurrences(of: #"\(\s*([,.;:!?])"#, with: "$1", options: .regularExpression)
                    .trimmingCharacters(in: .whitespaces)
            }
            .map { line in
                line.range(of: #"(?i)^(sources?|links?|references?)\s*:\s*[.,;:!?]*$"#, options: .regularExpression) == nil ? line : ""
            }
            .filter { !$0.isEmpty }
            .joined(separator: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func containsLinkSyntax(in value: String) -> Bool {
        value.range(of: #"(?i)(?:https?://|www\.)"#, options: .regularExpression) != nil
    }

    private static func speechSuffix(afterURL match: String) -> String {
        let terminalPunctuation = CharacterSet(charactersIn: ".,;:!?")
        var end = match.endIndex
        var suffix = ""
        while end > match.startIndex {
            let previous = match.index(before: end)
            guard String(match[previous]).rangeOfCharacter(from: terminalPunctuation) != nil else { break }
            suffix.insert(match[previous], at: suffix.startIndex)
            end = previous
        }
        return suffix
    }

    private static func containsMeaningfulText(_ value: String) -> Bool {
        let scaffolding = ["source", "sources", "link", "links", "reference", "references"]
        return value
            .split(separator: "\n")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: ":")) }
            .contains { line in
                let lowercased = line.lowercased()
                if scaffolding.contains(lowercased) { return false }
                if scaffolding.contains(where: { lowercased.hasPrefix("\($0):") }) {
                    let remainder = lowercased.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)[1]
                    return remainder.contains { !$0.isWhitespace && !$0.isPunctuation }
                }
                return line.contains { !$0.isWhitespace && !$0.isPunctuation }
            }
    }

    private static func replaceMatches(in value: String, pattern: String, replacement: (String) -> String) -> String {
        guard let expression = try? NSRegularExpression(pattern: pattern) else { return value }
        let matches = expression.matches(in: value, range: NSRange(value.startIndex..., in: value))
        return matches.reversed().reduce(value) { result, match in
            guard let range = Range(match.range, in: result) else { return result }
            var updated = result
            updated.replaceSubrange(range, with: replacement(String(result[range])))
            return updated
        }
    }
}

struct VoiceReplyContext: Equatable, Sendable {
    let taskID: String
    let textDigest: String

    init(taskID: String, text: String) {
        self.taskID = taskID
        self.textDigest = SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}

/// A single-use generation gate. New speech, native dictation, and backgrounding
/// advance it so a suspended request cannot play stale audio after it resumes.
struct VoiceOutputGeneration: Equatable {
    private(set) var value = UUID()

    mutating func advance() -> UUID { value = UUID(); return value }
    func accepts(_ candidate: UUID) -> Bool { value == candidate }
}

private final class VoiceNoRedirectDelegate: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

struct VoiceOutputAPI {
    // The legacy /v1/voice maxAudioBytes describes input audio (512 KiB).
    // Speech output has its own server-enforced 4 MiB bound.
    static let maximumSpeechAudioBytes = 4 * 1_024 * 1_024
    private let baseURL: URL
    private let token: String
    private let session: URLSession
    private let ownsSession: Bool

    init(baseURL: URL, token: String, session: URLSession? = nil) throws {
        guard baseURL.scheme?.lowercased() == "https", baseURL.host != nil,
              baseURL.user == nil, baseURL.password == nil,
              baseURL.query == nil, baseURL.fragment == nil,
              !token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw VoiceOutputError.unavailable
        }
        self.baseURL = baseURL
        self.token = token
        if let session {
            self.session = session; self.ownsSession = false
        } else {
            let settings = URLSessionConfiguration.ephemeral
            settings.urlCache = nil
            settings.timeoutIntervalForRequest = 45
            settings.timeoutIntervalForResource = 60
            self.session = URLSession(configuration: settings, delegate: VoiceNoRedirectDelegate(), delegateQueue: nil)
            self.ownsSession = true
        }
    }

    func finish() {
        guard ownsSession else { return }
        session.finishTasksAndInvalidate()
    }

    func capability() async throws -> VoiceServiceCapability {
        let (data, response) = try await session.data(for: try request("v1/voice", method: "GET", accept: "application/json"))
        try requireStatus(response, data: data, expected: 200)
        let capability: VoiceServiceCapability
        do { capability = try JSONDecoder().decode(VoiceServiceCapability.self, from: data) }
        catch { throw VoiceOutputError.invalidResponse }
        guard capability.supportsElevenLabs else { throw VoiceOutputError.unavailable }
        return capability
    }

    func speech(_ payload: VoiceSpeechRequest, maximumBytes: Int = Self.maximumSpeechAudioBytes) async throws -> Data {
        guard maximumBytes > 0, maximumBytes <= Self.maximumSpeechAudioBytes else { throw VoiceOutputError.invalidResponse }
        let body = try JSONEncoder().encode(payload)
        let (data, response) = try await session.data(for: try request("v1/speech", method: "POST", body: body, accept: "audio/mpeg"))
        try requireStatus(response, data: data, expected: 200)
        guard let http = response as? HTTPURLResponse,
              mediaType(http.value(forHTTPHeaderField: "Content-Type")) == "audio/mpeg",
              !data.isEmpty, data.count <= maximumBytes else {
            throw VoiceOutputError.invalidResponse
        }
        return data
    }

    private func request(_ path: String, method: String, body: Data? = nil, accept: String) throws -> URLRequest {
        var request = URLRequest(url: baseURL.appendingPathComponent(path))
        request.httpMethod = method
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue(accept, forHTTPHeaderField: "Accept")
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return request
    }

    private func requireStatus(_ response: URLResponse, data: Data, expected: Int) throws {
        guard let http = response as? HTTPURLResponse else { throw VoiceOutputError.invalidResponse }
        guard http.statusCode == expected else {
            let error = try? JSONDecoder().decode(ErrorEnvelope.self, from: data)
            throw VoiceOutputError.message(error?.error ?? "Providence speech is unavailable.")
        }
    }

    private func mediaType(_ value: String?) -> String? {
        value?.split(separator: ";", maxSplits: 1).first?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    private struct ErrorEnvelope: Decodable { let error: String }
}
