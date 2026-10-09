import Foundation

struct DemoConfiguration: Decodable {
    let baseURL: URL
    let token: String
    static func load() throws -> DemoConfiguration {
        guard let file = Bundle.main.url(forResource: "ProvidenceConfig", withExtension: "json") else {
            throw AssistantError.message("Run npm run configure-watch on the Mac, then rebuild this app.")
        }
        let config = try JSONDecoder().decode(Self.self, from: Data(contentsOf: file))
        guard config.baseURL.scheme == "https", config.baseURL.host != nil,
              config.baseURL.user == nil, config.baseURL.password == nil,
              config.baseURL.query == nil, config.baseURL.fragment == nil,
              config.token.range(of: "^[a-fA-F0-9]{64}$", options: .regularExpression) != nil else {
            throw AssistantError.message("Watch configuration needs an HTTPS URL and a valid demo token.")
        }
        return config
    }
}
struct EmailDraft: Codable, Equatable {
    var recipientName: String?
    var recipientEmail: String?
    var subject: String
    var body: String
}
struct RecipientUpdate: Encodable {
    let version: Int
    let draft: EmailDraft

    init(job: AssistantJob, address: String) throws {
        guard job.status == "ready", job.send.status == "not_sent", var draft = job.draft else {
            throw AssistantError.message("This email can no longer be edited. Refresh its status.")
        }
        guard !address.unicodeScalars.contains(where: { $0.value < 32 }) else {
            throw AssistantError.message("Enter one complete email address.")
        }
        // Only explicit separators are converted. Never turn a person's name
        // or arbitrary spaced words into an address.
        var normalized = address.trimmingCharacters(in: .whitespaces)
        for (word, symbol) in [("at", "@"), ("dot", "."), ("plus", "+"), ("underscore", "_"), ("dash", "-")] {
            normalized = normalized.replacingOccurrences(of: "(?i)\\s+" + word + "\\s+", with: symbol, options: .regularExpression)
        }
        normalized = normalized.replacingOccurrences(of: "\\s*([@.])\\s*", with: "$1", options: .regularExpression)
        guard normalized.count <= 254,
              normalized.range(of: #"^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$"#, options: .regularExpression) != nil else {
            throw AssistantError.message("Enter a full address, such as name@example.com, or dictate name at example dot com.")
        }
        draft.recipientEmail = normalized
        self.version = job.version
        self.draft = draft
    }
}
struct SendStatus: Decodable {
    let status: String
    let message: String
    let receipt: String?
}
struct AssistantJob: Decodable, Identifiable {
    let id: String
    let status: String
    let source: String
    let version: Int
    let transcript: String?
    let draft: EmailDraft?
    let error: String?
    let recipientSource: String?
    let sender: String?
    let send: SendStatus
    let savedToMailbox: Bool
}
struct SendApproval: Decodable, Identifiable {
    let token: String
    let version: Int
    let draft: EmailDraft
    let sender: String
    var id: String { token }
}
struct ServerConfiguration: Decodable {
    let sendingEnabled: Bool
    let sender: String?
}
enum AssistantError: LocalizedError {
    case message(String)
    var errorDescription: String? {
        switch self { case .message(let value): return value }
    }
}
struct AssistantAPI {
    let configuration: DemoConfiguration
    private let session: URLSession
    init(configuration: DemoConfiguration) {
        self.configuration = configuration
        let settings = URLSessionConfiguration.ephemeral
        settings.timeoutIntervalForRequest = 40
        settings.timeoutIntervalForResource = 60
        settings.urlCache = nil
        session = URLSession(configuration: settings)
    }
    func request<T: Decodable>(_ path: String, method: String = "GET", body: Data? = nil,
                               requestID: String? = nil, audio: Bool = false) async throws -> T {
        let url = configuration.baseURL.appendingPathComponent(path)
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("Bearer \(configuration.token)", forHTTPHeaderField: "Authorization")
        request.setValue(audio ? "audio/mp4" : "application/json", forHTTPHeaderField: "Content-Type")
        if let requestID { request.setValue(requestID, forHTTPHeaderField: "X-Request-ID") }
        request.httpBody = body
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw AssistantError.message("No response from the Mac.") }
        guard (200..<300).contains(http.statusCode) else {
            let payload = try? JSONDecoder().decode(APIError.self, from: data)
            throw AssistantError.message(payload?.error ?? "The backend returned HTTP \(http.statusCode).")
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
    private struct APIError: Decodable { let error: String }
}
