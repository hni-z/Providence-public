import Foundation

enum VoiceRoute: String, Codable {
    case email, mac, unsupportedTarget

    static func recognize(_ text: String) -> VoiceRoute {
        // Only command prefixes determine the route. An address or the word
        // "email" inside an ordinary computer request is not an email intent.
        let command = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let prefix = #"^(?:(?:please|can you|could you|would you)\s+)*"#
        let email = #"(?:e-?mail\b|(?:send|write|draft|compose)\s+(?:(?:an?|the)\s+)?e-?mail\b|send\s+.+?\s+an?\s+e-?mail\b|(?:respond|reply)\s+to\b)"#
        if command.range(of: prefix + email, options: [.regularExpression, .caseInsensitive]) != nil { return .email }
        return VoiceTargetGate.hasUnsupportedTarget(command) ? .unsupportedTarget : .mac
    }
}

enum VoiceTargetGate {
    static let message = "Routing to other devices is not available yet. This Watch currently supports your configured Mac and email. Nothing was sent in this attempt."

    static func hasUnsupportedTarget(_ text: String) -> Bool {
        // This interim gate matches explicit device destinations, not topic
        // keywords. Quoted content and dictated content after "saying" are data.
        var command = text.replacingOccurrences(of: #"\"[^\"]*\"|“[^”]*”|`[^`]*`|(?<!\w)'[^']*'(?!\w)"#,
                                                with: " ", options: .regularExpression)
        if let content = command.range(of: #"\b(?:saying|that says|with (?:the )?text)\b"#, options: [.regularExpression, .caseInsensitive]) {
            command = String(command[..<content.lowerBound])
        }
        let device = #"(?:(?:my|the|this|that|a|an|our)\s+)?(?:iPhone(?:\s+\d+(?:\s+pro)?(?:\s+max)?)?|iPad(?:\s+(?:pro|air|mini))?(?:\s+\d+)?|(?:android\s+)?phone|pc|(?:(?:windows(?:\s+\d+)?|linux)\s+(?:pc|computer|laptop|desktop|machine))|(?:meta\s+|oculus\s+)?quest(?:\s+[23]s?)?(?:\s+headset)?)\b"#
        let destination = #"\b(?:on|onto|using|via)\s+"# + device
        let directedAction = #"\b(?:use|ask|control|unlock|restart|reboot|switch to|connect to|cast to|send (?:this|it) to)\s+"# + device
        let prefix = #"^(?:(?:please|can you|could you|would you)\s+)*"#
        let addressed = prefix + device + #"(?:\s*[:,]|\s+(?:open|show|run|start|launch|take|play)\b)"#
        let openDevice = prefix + #"open\s+"# + device + #"\s*[.!?]*$"#
        return [destination, directedAction, addressed, openDevice].contains {
            command.range(of: $0, options: [.regularExpression, .caseInsensitive]) != nil
        }
    }
}

struct PreparedVoiceRequest: Codable, Equatable {
    let requestID: String
    let text: String

    init(text: String, requestID: UUID = UUID()) throws {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.count <= 8000, !trimmed.contains("\0") else {
            throw AssistantError.message("Say a request of up to 8,000 characters.")
        }
        self.text = trimmed
        self.requestID = requestID.uuidString.lowercased()
    }
}

struct RememberContactResponse: Decodable { let contact: ContactProposal }

struct VoiceClarification: Encodable {
    let version: Int
    let text: String

    init(job: AssistantJob, text: String) throws {
        guard VoiceContracts.canClarify(job) else {
            throw AssistantError.message("Refresh this email before changing it.")
        }
        self.version = job.version
        self.text = try PreparedVoiceRequest(text: text).text
    }
}

struct RememberContactRequest: Encodable {
    let version: Int
    let name: String

    init(job: AssistantJob, confirmed: ContactProposal) throws {
        guard VoiceContracts.isEditable(job), job.clarification == nil,
              job.draft?.recipientEmail == confirmed.email,
              !confirmed.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              confirmed.name.count <= 200,
              !confirmed.name.unicodeScalars.contains(where: { $0.value < 32 }) else {
            throw AssistantError.message("Review the current name and recipient address before remembering them.")
        }
        version = job.version
        name = confirmed.name
    }
}

enum VoiceContracts {
    static func canClarify(_ job: AssistantJob) -> Bool {
        job.status == "ready" && job.send.status == "not_sent"
    }

    static func isEditable(_ job: AssistantJob) -> Bool {
        canClarify(job) && job.draft != nil
    }

    static func matches(_ approval: SendApproval, job: AssistantJob) -> Bool {
        isEditable(job) && job.clarification == nil && job.draft?.recipientEmail != nil &&
        approval.version == job.version && approval.draft == job.draft && approval.sender == job.sender
    }

    static func confirmsRemembering(_ text: String) -> Bool {
        // Deliberately exact: "yes, but use another address" cannot confirm.
        let words = text.lowercased().trimmingCharacters(in: .whitespacesAndNewlines.union(.punctuationCharacters))
        return ["yes", "yes remember", "yes remember it", "remember", "remember it", "confirm", "yes please"].contains(words)
    }

    static func followUp(_ job: AssistantJob) -> String? {
        guard canClarify(job) else { return nil }
        if let question = job.clarification, !question.isEmpty { return question }
        guard job.draft != nil else { return "Say the complete email request, including the recipient and what you want to say." }
        if job.draft?.recipientEmail == nil {
            return "What is \(job.draft?.recipientName ?? "the recipient")'s full email address? Say the address using at and dot."
        }
        return nil
    }
}

extension AssistantAPI {
    func submitVoice(_ prepared: PreparedVoiceRequest) async throws -> AssistantJob {
        let payload = try JSONEncoder().encode(["text": prepared.text])
        let received: AssistantJob = try await request("api/jobs/voice-text", method: "POST", body: payload, requestID: prepared.requestID)
        guard received.id == prepared.requestID else { throw AssistantError.message("The backend returned a different request. Check the saved request status.") }
        return received
    }

    func clarify(_ reviewed: AssistantJob, text: String) async throws -> AssistantJob {
        let body = try JSONEncoder().encode(VoiceClarification(job: reviewed, text: text))
        let received: AssistantJob = try await request("api/jobs/\(reviewed.id)/clarify", method: "POST", body: body)
        guard received.id == reviewed.id, received.version > reviewed.version else {
            throw AssistantError.message("The clarification response changed identity or did not advance the draft. Refresh status.")
        }
        return received
    }

    func remember(_ confirmed: ContactProposal, for reviewed: AssistantJob) async throws -> ContactProposal {
        let body = try JSONEncoder().encode(RememberContactRequest(job: reviewed, confirmed: confirmed))
        let received: RememberContactResponse = try await request("api/jobs/\(reviewed.id)/remember-contact", method: "POST", body: body)
        guard received.contact.email == confirmed.email,
              received.contact.name.caseInsensitiveCompare(confirmed.name) == .orderedSame else {
            throw AssistantError.message("The remembered contact did not match your confirmation. Refresh before continuing.")
        }
        return received.contact
    }
}
