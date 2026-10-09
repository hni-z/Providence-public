import Foundation

// Supplies only the post-clarification wire response. Product code owns all
// state eligibility, payload construction, validation and response decoding.
final class NoDraftTransport: URLProtocol, @unchecked Sendable {
    static let lock = NSLock()
    nonisolated(unsafe) private static var seen: [URLRequest] = []
    static let id = "11111111-1111-4111-8111-111111111111"
    static let complete = "Email Alex at alex@example.com saying I can help tomorrow."
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}
    override func startLoading() {
        Self.lock.lock(); Self.seen.append(request); Self.lock.unlock()
        let body = Data(#"{"id":"11111111-1111-4111-8111-111111111111","status":"ready","source":"text","version":2,"transcript":"Email Alex at alex@example.com saying I can help tomorrow.","draft":{"recipientName":"Alex","recipientEmail":"alex@example.com","subject":"Prototype","body":"I can help tomorrow."},"sender":"sender@example.com","send":{"status":"not_sent","message":"Draft only."},"savedToMailbox":false}"#.utf8)
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }
    static func requests() -> [URLRequest] { lock.lock(); defer { lock.unlock() }; return seen }
}

enum NoDraftFailure: Error { case failed(String) }

@main
struct NoDraftClarificationAcceptance {
    static func require(_ value: Bool, _ message: String) throws {
        if !value { throw NoDraftFailure.failed(message) }
    }
    static func rejects(_ action: () throws -> Void) -> Bool {
        do { try action(); return false } catch { return true }
    }
    static func run() async throws {
        let raw = #"{"id":"11111111-1111-4111-8111-111111111111","status":"ready","source":"text","version":1,"clarification":"Say a complete new email request, or supply real message context.","draft":null,"sender":"sender@example.com","send":{"status":"not_sent","message":"Draft only."},"savedToMailbox":false}"#
        let job = try JSONDecoder().decode(AssistantJob.self, from: Data(raw.utf8))
        try require(job.draft == nil, "W05 fixture must contain no draft")
        try require(VoiceContracts.followUp(job) == job.clarification, "W05 ready clarification with no draft must remain speakable")
        let answer = try VoiceClarification(job: job, text: NoDraftTransport.complete)
        let payload = try JSONSerialization.jsonObject(with: JSONEncoder().encode(answer)) as! [String: Any]
        try require(payload["version"] as? Int == 1 && payload["text"] as? String == NoDraftTransport.complete, "W05 clarification must retain named version and complete spoken text")
        let proposal = ContactProposal(name: "Alex", email: "alex@example.com")
        try require(rejects { _ = try RememberContactRequest(job: job, confirmed: proposal) }, "W05 cannot remember without a reviewed draft")
        let draft = EmailDraft(recipientName: "Alex", recipientEmail: "alex@example.com", subject: "Prototype", body: "I can help tomorrow.")
        let approval = SendApproval(token: "synthetic", version: 1, draft: draft, sender: "sender@example.com")
        try require(!VoiceContracts.matches(approval, job: job), "W05 cannot approve without a reviewed draft")
        for state in ["submitting", "submitted", "uncertain"] {
            let locked = try JSONDecoder().decode(AssistantJob.self, from: Data(raw.replacingOccurrences(of: "not_sent", with: state).utf8))
            try require(VoiceContracts.followUp(locked) == nil, "W05 must not re-edit a send attempt")
            try require(rejects { _ = try VoiceClarification(job: locked, text: NoDraftTransport.complete) }, "W05 send-attempt lock must survive no-draft support")
        }
        let settings = URLSessionConfiguration.ephemeral
        settings.protocolClasses = [NoDraftTransport.self]
        let api = AssistantAPI(configuration: DemoConfiguration(baseURL: URL(string: "https://synthetic.example")!, token: String(repeating: "a", count: 64)), session: URLSession(configuration: settings))
        let ready = try await api.clarify(job, text: NoDraftTransport.complete)
        try require(ready.id == job.id && ready.version == 2 && ready.draft == draft && ready.send.status == "not_sent", "W05 complete answer must produce reviewable draft on same job")
        let requests = NoDraftTransport.requests()
        try require(requests.count == 1 && requests[0].httpMethod == "POST" && requests[0].url?.path == "/api/jobs/\(job.id)/clarify", "W05 exactly one clarification, no approval/remember/send network call")
        print("W05 no-draft question -> complete spoken clarification -> same-job draft passed; approval/remember blocked before draft; synthetic transport only.")
    }
    static func main() async {
        do { try await run() }
        catch { print("FAIL: \(error)"); exit(1) }
    }
}
