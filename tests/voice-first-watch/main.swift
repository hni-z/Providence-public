import Foundation

// An in-process synthetic backend. No socket, provider, Mail, or contact store.
final class VoiceBackendStub: URLProtocol, @unchecked Sendable {
    static let lock = NSLock()
    nonisolated(unsafe) static var requests: [URLRequest] = []
    nonisolated(unsafe) static var version = 1
    nonisolated(unsafe) static var dropFirstResponse = true
    nonisolated(unsafe) static var wrongIdentity = false
    nonisolated(unsafe) static var needsCompleteRequest = false
    static let id = "11111111-1111-4111-8111-111111111111"

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        Self.lock.lock()
        defer { Self.lock.unlock() }
        Self.requests.append(request)
        let path = request.url!.path
        var status = 200
        var body: [String: Any]
        if path == "/api/jobs/voice-text" {
            if Self.dropFirstResponse {
                Self.dropFirstResponse = false
                client?.urlProtocol(self, didFailWithError: URLError(.networkConnectionLost))
                return
            }
            body = Self.job()
        } else if path.hasSuffix("/clarify") {
            let supplied = Self.payload(request)
            if supplied["version"] as? Int != Self.version {
                status = 409; body = ["error": "Draft version changed."]
            } else {
                Self.version += 1
                body = Self.job()
            }
        } else if path.hasSuffix("/remember-contact") {
            let supplied = Self.payload(request)
            if supplied["version"] as? Int != Self.version {
                status = 409; body = ["error": "Draft version changed."]
            } else {
                body = ["contact": ["name": supplied["name"]!, "email": "alex@example.com"]]
            }
        } else if path == "/api/jobs/\(Self.id)", request.httpMethod == "GET" {
            body = Self.job()
        } else {
            status = 404; body = ["error": "Unexpected endpoint"]
        }
        let data = try! JSONSerialization.data(withJSONObject: body)
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    static func payload(_ request: URLRequest) -> [String: Any] {
        var data = request.httpBody ?? Data()
        if data.isEmpty, let stream = request.httpBodyStream {
            stream.open(); defer { stream.close() }
            var buffer = [UInt8](repeating: 0, count: 1024)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                data.append(contentsOf: buffer.prefix(count))
            }
        }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
    }

    static func job() -> [String: Any] {
        var result: [String: Any] = ["id": wrongIdentity ? "22222222-2222-4222-8222-222222222222" : id,
         "status": "ready", "source": "text", "version": version,
         "transcript": "Email Alex saying hello", "sender": "sender@example.com",
         "draft": ["recipientName": "Alex", "recipientEmail": version == 1 ? NSNull() as Any : "alex@example.com", "subject": "Hello", "body": "Hello"],
         "clarification": version == 1 ? "What is Alex's full email address?" as Any : NSNull(),
         "contactProposal": version == 1 ? NSNull() as Any : ["name": "Alex", "email": "alex@example.com"],
         "send": ["status": "not_sent", "message": "Draft only."], "savedToMailbox": false]
        if needsCompleteRequest, version == 1 {
            result.removeValue(forKey: "draft")
            result["clarification"] = "Please say the complete new email request with the recipient and message."
        }
        return result
    }

    static func snapshot() -> [URLRequest] { lock.lock(); defer { lock.unlock() }; return requests }
}

@main
struct VoiceFirstTests {
    static func main() async throws {
        for text in ["Email Alex saying hi", "Please email Alex at alex at example dot com saying hello",
                     "Could you send an email to Alex saying hi", "Send Alex an email saying hi",
                     "Respond to Alex saying I am late", "Reply to Alex saying thanks", "Draft an e-mail to Alex"] {
            precondition(VoiceRoute.recognize(text) == .email, text)
        }
        for text in ["Open my project", "Find the email validation tests", "Open the email app", "Show example@example.com in a file", "Summarize the latest run"] {
            precondition(VoiceRoute.recognize(text) == .mac, text)
        }
        for text in ["Open a tab on my phone", "Please open Maps on my iPhone", "On my iPhone 16 Pro, open Safari",
                     "Open a browser on my Windows PC", "Use my Windows laptop to run the tests",
                     "Show this on my Quest", "Cast to my Meta Quest 3 headset", "Quest: open the browser",
                     "Can you ask my phone to open settings", "Open my iPhone", "Quest open the browser", "Open a browser on my PC",
                     "On my Linux laptop, open the browser.", "Use my Linux computer to run the tests", "Open the browser on my iPad.",
                     "iPad Pro: open Notes", "Show this using an iPad"] {
            precondition(VoiceRoute.recognize(text) == .unsupportedTarget, text)
        }
        for text in ["Open a tab on my Mac", "Open a tab on my laptop", "Search for Windows documentation",
                     "Find phone examples in the project", "Search for iPhone reviews on my Mac",
                     "Write a note saying open this on my phone", "Show the text \"on my Windows PC\" in a file",
                     "Find 'on my phone' in the project", "Write a tutorial about Quest games", "Open my phone notes on my Mac",
                     "Search for Linux laptop reviews on my Mac", "Find iPad screenshots in this project"] {
            precondition(VoiceRoute.recognize(text) == .mac, text)
        }
        for text in ["Email Alex saying open this on my phone", "Respond to Alex saying try it on my Windows PC"] {
            precondition(VoiceRoute.recognize(text) == .email, text)
        }
        for text in ["", "  ", "hi\0there", String(repeating: "a", count: 8001)] {
            expectThrows { _ = try PreparedVoiceRequest(text: text) }
        }
        for answer in ["yes", "Yes.", "remember it", "Yes please"] { precondition(VoiceContracts.confirmsRemembering(answer)) }
        for answer in ["no", "yes but change the address", "send it", "Alex", "don't remember it", "yes remember it and send"] {
            precondition(!VoiceContracts.confirmsRemembering(answer))
        }

        let settings = URLSessionConfiguration.ephemeral
        settings.protocolClasses = [VoiceBackendStub.self]
        let api = AssistantAPI(configuration: DemoConfiguration(baseURL: URL(string: "https://synthetic.example")!, token: String(repeating: "a", count: 64)), session: URLSession(configuration: settings))
        let prepared = try PreparedVoiceRequest(text: "Email Alex saying hello", requestID: UUID(uuidString: VoiceBackendStub.id)!)
        // Persist before POST, then simulate app restart and an acknowledgement lost.
        let persisted = try JSONEncoder().encode(prepared)
        do { _ = try await api.submitVoice(prepared); preconditionFailure("Expected a dropped response") } catch { }
        let restored = try JSONDecoder().decode(PreparedVoiceRequest.self, from: persisted)
        precondition(restored == prepared)
        let unknown = try await api.submitVoice(restored)
        precondition(unknown.draft?.recipientEmail == nil)
        precondition(VoiceContracts.followUp(unknown) == "What is Alex's full email address?")
        let firstRequests = VoiceBackendStub.snapshot()
        precondition(firstRequests.count == 2)
        for request in firstRequests {
            precondition(request.url?.path == "/api/jobs/voice-text")
            precondition(request.httpMethod == "POST")
            precondition(request.value(forHTTPHeaderField: "X-Request-ID") == prepared.requestID)
            precondition(request.value(forHTTPHeaderField: "Authorization") == "Bearer " + String(repeating: "a", count: 64))
            precondition(VoiceBackendStub.payload(request) as NSDictionary == ["text": prepared.text] as NSDictionary)
        }

        let clarified = try await api.clarify(unknown, text: "Alex at example dot com")
        precondition(clarified.version == 2 && clarified.draft?.recipientEmail == "alex@example.com")
        precondition(VoiceContracts.followUp(clarified) == nil)
        let clarifyRequest = VoiceBackendStub.snapshot().last!
        precondition(clarifyRequest.url?.path == "/api/jobs/\(prepared.requestID)/clarify")
        precondition(VoiceBackendStub.payload(clarifyRequest) as NSDictionary == ["version": 1, "text": "Alex at example dot com"] as NSDictionary)
        do { _ = try await api.clarify(unknown, text: "other at example dot com"); preconditionFailure("Accepted stale clarification") } catch { }

        let contact = clarified.contactProposal!
        let beforeRemembering = VoiceBackendStub.snapshot().count
        expectThrows { _ = try RememberContactRequest(job: unknown, confirmed: contact) }
        expectThrows { _ = try RememberContactRequest(job: clarified, confirmed: ContactProposal(name: "Alex", email: "other@example.com")) }
        for name in ["", "  ", "Alex\nBcc", String(repeating: "a", count: 201)] {
            expectThrows { _ = try RememberContactRequest(job: clarified, confirmed: ContactProposal(name: name, email: contact.email)) }
        }
        precondition(VoiceBackendStub.snapshot().count == beforeRemembering)
        let remembered = try await api.remember(contact, for: clarified)
        precondition(remembered == contact)
        let rememberRequest = VoiceBackendStub.snapshot().last!
        precondition(rememberRequest.url?.path == "/api/jobs/\(prepared.requestID)/remember-contact")
        // The reviewed job owns the address. Never send a client-supplied email.
        precondition(VoiceBackendStub.payload(rememberRequest) as NSDictionary == ["version": 2, "name": "Alex"] as NSDictionary)

        let approval = SendApproval(token: "synthetic-token", version: clarified.version, draft: clarified.draft!, sender: "sender@example.com")
        precondition(VoiceContracts.matches(approval, job: clarified))
        precondition(!VoiceContracts.matches(approval, job: unknown))
        precondition(!VoiceContracts.matches(SendApproval(token: "synthetic-token", version: 1, draft: clarified.draft!, sender: "sender@example.com"), job: clarified))
        var changedDraft = clarified.draft!; changedDraft.body = "Different words"
        precondition(!VoiceContracts.matches(SendApproval(token: "synthetic-token", version: 2, draft: changedDraft, sender: "sender@example.com"), job: clarified))
        precondition(!VoiceContracts.matches(SendApproval(token: "synthetic-token", version: 2, draft: clarified.draft!, sender: "different@example.com"), job: clarified))
        for status in ["submitting", "submitted", "uncertain"] {
            var object = VoiceBackendStub.job(); object["send"] = ["status": status, "message": "Synthetic"]
            let locked = try JSONDecoder().decode(AssistantJob.self, from: JSONSerialization.data(withJSONObject: object))
            expectThrows { _ = try VoiceClarification(job: locked, text: "change it") }
            expectThrows { _ = try RememberContactRequest(job: locked, confirmed: contact) }
            precondition(!VoiceContracts.matches(approval, job: locked))
        }
        let refreshed: AssistantJob = try await api.request("api/jobs/\(prepared.requestID)")
        precondition(refreshed.id == prepared.requestID && VoiceBackendStub.snapshot().last?.httpMethod == "GET")

        // A valid backend clarification can precede draft creation entirely.
        VoiceBackendStub.version = 1
        VoiceBackendStub.needsCompleteRequest = true
        let noDraft: AssistantJob = try await api.request("api/jobs/\(prepared.requestID)")
        precondition(noDraft.status == "ready" && noDraft.draft == nil)
        precondition(VoiceContracts.canClarify(noDraft) && !VoiceContracts.isEditable(noDraft))
        precondition(VoiceContracts.followUp(noDraft) == "Please say the complete new email request with the recipient and message.")
        let inventedApproval = SendApproval(token: "synthetic-token", version: noDraft.version, draft: clarified.draft!, sender: "sender@example.com")
        precondition(!VoiceContracts.matches(inventedApproval, job: noDraft))
        let beforeRejectedRemember = VoiceBackendStub.snapshot().count
        do { _ = try await api.remember(contact, for: noDraft); preconditionFailure("Remembered without a draft") } catch { }
        precondition(VoiceBackendStub.snapshot().count == beforeRejectedRemember)
        var withoutQuestion = VoiceBackendStub.job(); withoutQuestion.removeValue(forKey: "clarification")
        let noDraftOrQuestion = try JSONDecoder().decode(AssistantJob.self, from: JSONSerialization.data(withJSONObject: withoutQuestion))
        precondition(VoiceContracts.followUp(noDraftOrQuestion) != nil)
        precondition(!VoiceContracts.matches(inventedApproval, job: noDraftOrQuestion))
        expectThrows { _ = try RememberContactRequest(job: noDraftOrQuestion, confirmed: contact) }
        for state in ["submitting", "submitted", "uncertain"] {
            var lockedObject = VoiceBackendStub.job(); lockedObject["send"] = ["status": state, "message": "Synthetic"]
            let locked = try JSONDecoder().decode(AssistantJob.self, from: JSONSerialization.data(withJSONObject: lockedObject))
            precondition(!VoiceContracts.canClarify(locked) && VoiceContracts.followUp(locked) == nil)
            expectThrows { _ = try VoiceClarification(job: locked, text: "Email Alex saying hello") }
        }
        for state in ["queued", "drafting", "error", "expired"] {
            var unreadyObject = VoiceBackendStub.job(); unreadyObject["status"] = state
            let unready = try JSONDecoder().decode(AssistantJob.self, from: JSONSerialization.data(withJSONObject: unreadyObject))
            precondition(!VoiceContracts.canClarify(unready) && VoiceContracts.followUp(unready) == nil)
            expectThrows { _ = try VoiceClarification(job: unready, text: "Email Alex saying hello") }
        }
        let completeRequest = "Send a new email to Alex at alex at example dot com saying hello"
        let completedDraft = try await api.clarify(noDraft, text: completeRequest)
        precondition(completedDraft.version == 2 && completedDraft.draft?.recipientEmail == "alex@example.com")
        precondition(VoiceContracts.followUp(completedDraft) == nil && VoiceContracts.isEditable(completedDraft))
        let completeRequestPost = VoiceBackendStub.snapshot().last!
        precondition(completeRequestPost.httpMethod == "POST" && completeRequestPost.url?.path == "/api/jobs/\(prepared.requestID)/clarify")
        precondition(VoiceBackendStub.payload(completeRequestPost) as NSDictionary == ["version": 1, "text": completeRequest] as NSDictionary)
        do { _ = try await api.clarify(noDraft, text: completeRequest); preconditionFailure("Accepted stale no-draft clarification") } catch { }
        VoiceBackendStub.needsCompleteRequest = false
        VoiceBackendStub.wrongIdentity = true
        do { _ = try await api.submitVoice(prepared); preconditionFailure("Accepted another job ID") } catch { }
        do { _ = try await api.clarify(clarified, text: "another at example dot com"); preconditionFailure("Accepted another clarification ID") } catch { }
        precondition(VoiceBackendStub.snapshot().allSatisfy { !($0.url?.path.hasSuffix("/send") ?? false) && !($0.url?.path.hasSuffix("/approval") ?? false) })
        print("Voice routing/unsupported-target gate, no-draft clarification, persisted retry identity, native-text wire, clarification/version, contact confirmation, and exact approval contracts passed (synthetic transport only).")
    }

    static func expectThrows(_ action: () throws -> Void) {
        do { try action(); preconditionFailure("Expected rejection") } catch { }
    }
}
