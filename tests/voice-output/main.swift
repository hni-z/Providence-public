import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import WatchCoordinatorAdapter

final class VoiceOutputStub: URLProtocol, @unchecked Sendable {
    static let lock = NSLock()
    nonisolated(unsafe) private static var recorded: [URLRequest] = []
    nonisolated(unsafe) private static var responseStatus = 200
    nonisolated(unsafe) private static var audioType = "audio/mpeg; charset=binary"
    nonisolated(unsafe) private static var audio = Data([0x49, 0x44, 0x33])
    nonisolated(unsafe) private static var configured = true
    nonisolated(unsafe) private static var provider = "ElevenLabs"
    nonisolated(unsafe) private static var speechLimit: Int?
    nonisolated(unsafe) private static var holdResponse = false
    nonisolated(unsafe) private static var stoppedLoads = 0

    static func reset(status: Int = 200, type: String = "audio/mpeg; charset=binary", data: Data = Data([0x49, 0x44, 0x33]), ready: Bool = true, provider: String = "ElevenLabs", limit: Int? = nil, hold: Bool = false) {
        lock.lock(); defer { lock.unlock() }
        recorded = []; responseStatus = status; audioType = type; audio = data
        configured = ready; self.provider = provider; speechLimit = limit
        holdResponse = hold; stoppedLoads = 0
    }
    static func requests() -> [URLRequest] { lock.lock(); defer { lock.unlock() }; return recorded }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    static func stoppedCount() -> Int { lock.lock(); defer { lock.unlock() }; return stoppedLoads }
    override func stopLoading() { Self.lock.lock(); Self.stoppedLoads += 1; Self.lock.unlock() }
    override func startLoading() {
        Self.lock.lock()
        Self.recorded.append(request)
        let status = Self.responseStatus, type = Self.audioType, audio = Self.audio, hold = Self.holdResponse
        var capability: [String: Any] = ["provider": Self.provider, "configured": Self.configured,
            "voice": "demo-voice", "deviceId": "mac", "maxSpeechChars": 4000, "maxAudioBytes": 524288,
            "transcriptionConfigured": false]
        if let limit = Self.speechLimit { capability["maxSpeechAudioBytes"] = limit }
        Self.lock.unlock()
        if hold { return }
        let isCapability = request.url!.path == "/v1/voice"
        let data = isCapability ? try! JSONSerialization.data(withJSONObject: capability) : audio
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil,
            headerFields: ["Content-Type": isCapability ? "application/json" : type])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
}

@MainActor @main struct VoiceOutputTests {
    static func main() async throws {
        let settings = URLSessionConfiguration.ephemeral
        settings.protocolClasses = [VoiceOutputStub.self]
        let session = URLSession(configuration: settings)
        defer { session.invalidateAndCancel() }
        let api = try VoiceOutputAPI(baseURL: URL(string: "https://providence.hani.so")!, token: "paired-token", session: session)
        VoiceOutputStub.reset()
        let legacy = try await api.capability()
        precondition(legacy.supportsElevenLabs && legacy.speechAudioLimit == 4_194_304)
        // False transcription readiness must not hide configured output capability.
        VoiceOutputStub.reset(limit: 4_194_304)
        let current = try await api.capability()
        precondition(current.supportsElevenLabs && current.maxSpeechAudioBytes == 4_194_304)

        let id = UUID(uuidString: "11111111-1111-4111-8111-111111111111")!
        let payload = try VoiceSpeechRequest(requestID: id, text: " Finished the checked task. ")
        let audio = try await api.speech(payload, maximumBytes: current.speechAudioLimit)
        precondition(audio == Data([0x49, 0x44, 0x33]))
        let requests = VoiceOutputStub.requests()
        precondition(requests.count == 2)
        precondition(requests[0].url?.path == "/v1/voice" && requests[0].httpMethod == "GET")
        precondition(requests[1].url?.path == "/v1/speech" && requests[1].httpMethod == "POST")
        precondition(requests[1].value(forHTTPHeaderField: "Accept") == "audio/mpeg")
        precondition(requests.allSatisfy { $0.value(forHTTPHeaderField: "Authorization") == "Bearer paired-token" })
        let json = try JSONSerialization.jsonObject(with: body(requests[1])) as! [String: String]
        precondition(json == ["requestId": id.uuidString, "text": "Finished the checked task."])
        let replay = try VoiceSpeechRequest(text: payload.text)
        precondition(replay.requestID != payload.requestID)

        expectThrowsSync { _ = try VoiceSpeechRequest(text: "") }
        expectThrowsSync { _ = try VoiceSpeechRequest(text: "🙂", maxUTF16Units: 1) }
        expectThrowsSync { _ = try VoiceSpeechRequest(text: "reply", maxUTF16Units: 4001) }
        let emoji = try VoiceSpeechRequest(text: String(repeating: "🙂", count: 2001))
        precondition(emoji.text.utf16.count == 4000 && emoji.text.count == 2000)
        let bounded = try VoiceSpeechRequest(text: "abcdef", maxUTF16Units: 3)
        precondition(bounded.text == "abc")

        // Completed task replies have a speech-only presentation. The original
        // result remains the identity and written source of truth.
        let citedReply = "Earth is nearly round because gravity pulls matter inward. [NASA explanation](https://science.nasa.gov/earth/facts/)\nSources: <https://example.com/reference>."
        let spokenReply = try VoiceCompletedReplySpeech.request(requestID: id, completedReply: citedReply)
        precondition(spokenReply.text == "Earth is nearly round because gravity pulls matter inward. NASA explanation")
        precondition(!spokenReply.text.localizedCaseInsensitiveContains("https"))
        precondition(VoiceCompletedReplySpeech.presentationText(for: "https://one.example/path,\n<https://two.example>.") == VoiceCompletedReplySpeech.linksOnlyFallback)
        precondition(VoiceCompletedReplySpeech.presentationText(for: "See https://example.com/test, then continue — voilà.") == "See, then continue — voilà.")
        precondition(VoiceCompletedReplySpeech.presentationText(for: "Read HTTPS://example.com/path(one), then continue.") == "Read, then continue.")
        precondition(VoiceCompletedReplySpeech.presentationText(for: "It worked (https://example.com/result).") == "It worked.")
        precondition(VoiceCompletedReplySpeech.presentationText(for: "Sources: (https://example.com/reference)") == VoiceCompletedReplySpeech.linksOnlyFallback)
        precondition(VoiceCompletedReplySpeech.presentationText(for: "[1]: <https://example.com/reference>\n[Unicode source][1] says: café ☕") == "Unicode source says: café ☕")
        precondition(VoiceReplyContext(taskID: "reply", text: citedReply).textDigest != VoiceReplyContext(taskID: "reply", text: spokenReply.text).textDigest)
        precondition(VoiceCompletedReplySpeech.presentationText(for: "   ").isEmpty)
        precondition(VoiceCompletedReplySpeech.presentationText(for: "...") == "...")

        for type in ["text/html", "audio/mpegjunk", "application/json"] {
            VoiceOutputStub.reset(type: type)
            await expectThrows { _ = try await api.speech(payload) }
            precondition(VoiceOutputStub.requests().count == 1)
        }
        for data in [Data(), Data(repeating: 0, count: 4_194_305)] {
            VoiceOutputStub.reset(data: data)
            await expectThrows { _ = try await api.speech(payload) }
        }
        VoiceOutputStub.reset(data: Data(repeating: 0, count: 4_194_304))
        let maximum = try await api.speech(payload)
        precondition(maximum.count == 4_194_304)
        VoiceOutputStub.reset(data: Data(repeating: 0, count: 6))
        await expectThrows { _ = try await api.speech(payload, maximumBytes: 5) }
        for status in [401, 409, 429, 503] {
            VoiceOutputStub.reset(status: status)
            await expectThrows { _ = try await api.speech(payload) }
            precondition(VoiceOutputStub.requests().count == 1, "speech must never retry automatically")
        }
        for configuration in [(false, "ElevenLabs"), (true, "OpenAI")] {
            VoiceOutputStub.reset(ready: configuration.0, provider: configuration.1)
            await expectThrows { _ = try await api.capability() }
            precondition(VoiceOutputStub.requests().allSatisfy { $0.httpMethod == "GET" })
        }
        for limit in [0, 4_194_305] {
            VoiceOutputStub.reset(limit: limit)
            await expectThrows { _ = try await api.capability() }
        }

        VoiceOutputStub.reset(hold: true)
        let pending = Task { try await api.speech(payload) }
        for _ in 0..<100 where VoiceOutputStub.requests().isEmpty { try await Task.sleep(for: .milliseconds(5)) }
        precondition(VoiceOutputStub.requests().count == 1)
        pending.cancel()
        do { _ = try await pending.value; preconditionFailure("Cancelled speech returned audio") }
        catch is CancellationError { }
        catch let error as URLError { precondition(error.code == .cancelled) }
        precondition(VoiceOutputStub.stoppedCount() == 1)
        precondition(VoiceOutputStub.requests().count == 1, "cancellation must not replay the request")

        let originalContext = VoiceReplyContext(taskID: "same-task", text: "original result")
        precondition(originalContext == VoiceReplyContext(taskID: "same-task", text: "original result"))
        precondition(originalContext != VoiceReplyContext(taskID: "same-task", text: "changed result"))
        precondition(originalContext != VoiceReplyContext(taskID: "new-task", text: "original result"))

        let ledgerDirectory = FileManager.default.temporaryDirectory.appendingPathComponent("voice-ledger-test-\(UUID())")
        defer { try? FileManager.default.removeItem(at: ledgerDirectory) }
        let ledger = VoiceAutomaticSpeechLedger(directory: ledgerDirectory)
        let reservation = try ledger.reserve(originalContext, requestID: id)!
        let ledgerFile = ledgerDirectory.appendingPathComponent("automatic-speech.json")
        precondition(FileManager.default.fileExists(atPath: ledgerFile.path), "reservation must exist before any generating POST")
        let stored = try Data(contentsOf: ledgerFile)
        precondition(String(data: stored, encoding: .utf8)!.contains(id.uuidString))
        precondition(!String(data: stored, encoding: .utf8)!.contains("original result"), "receipt stores a digest, not private result text")
        let attributes = try FileManager.default.attributesOfItem(atPath: ledgerFile.path)
        precondition((attributes[.posixPermissions] as! NSNumber).intValue == 0o600)
        VoiceOutputStub.reset(status: 503)
        await expectThrows { _ = try await api.speech(VoiceSpeechRequest(requestID: reservation.requestID, text: "original result")) }
        let reopened = VoiceAutomaticSpeechLedger(directory: ledgerDirectory)
        let afterFailure = try reopened.reserve(originalContext)
        precondition(afterFailure == nil, "failed or uncertain output cannot reset automatic reservation")
        let changedText = try reopened.reserve(VoiceReplyContext(taskID: originalContext.taskID, text: "corrected result"))
        precondition(changedText == nil)
        // Cancellation/fallback have no clearing API; restarting still sees the
        // same consumed automatic attempt. Manual replay intentionally uses a new ID.
        let afterCancellation = try VoiceAutomaticSpeechLedger(directory: ledgerDirectory).reserve(originalContext)
        precondition(afterCancellation == nil)
        let explicitReplay = try VoiceSpeechRequest(text: "original result")
        precondition(explicitReplay.requestID != reservation.requestID)
        VoiceOutputStub.reset()
        _ = try await api.speech(explicitReplay)
        let afterReplay = try reopened.reserve(originalContext)
        precondition(afterReplay == nil)
        let nextTask = try reopened.reserve(VoiceReplyContext(taskID: "next-task", text: "another result"))
        precondition(nextTask?.taskID == "next-task")
        let olderTaskAgain = try reopened.reserve(originalContext)
        precondition(olderTaskAgain == nil, "a later task must not evict an earlier consumed identity")
        let cancelledContext = VoiceReplyContext(taskID: "cancelled-task", text: "cancelled reply")
        let cancelledReservation = try reopened.reserve(cancelledContext)!
        VoiceOutputStub.reset(hold: true)
        let reservedCancellation = Task { try await api.speech(VoiceSpeechRequest(requestID: cancelledReservation.requestID, text: "cancelled reply")) }
        for _ in 0..<100 where VoiceOutputStub.requests().isEmpty { try await Task.sleep(for: .milliseconds(5)) }
        precondition(VoiceOutputStub.requests().count == 1)
        reservedCancellation.cancel()
        do { _ = try await reservedCancellation.value; preconditionFailure("Cancelled reserved request returned audio") }
        catch is CancellationError { }
        catch let error as URLError { precondition(error.code == .cancelled) }
        let afterRealCancellation = try VoiceAutomaticSpeechLedger(directory: ledgerDirectory).reserve(cancelledContext)
        precondition(afterRealCancellation == nil && VoiceOutputStub.requests().count == 1)
        try Data("corrupt".utf8).write(to: ledgerFile, options: .atomic)
        expectThrowsSync { _ = try reopened.reserve(originalContext) }

        var gate = VoiceOutputGeneration()
        let pendingSpeech = gate.value
        let microphone = gate.advance()
        precondition(!gate.accepts(pendingSpeech) && gate.accepts(microphone))
        let stopped = gate.advance()
        precondition(!gate.accepts(microphone) && gate.accepts(stopped))
        let background = gate.advance()
        precondition(!gate.accepts(stopped) && gate.accepts(background))

        // End-to-end offline seam: verified child text, never parent's plan, is
        // the source of the TTS request. No transcription endpoint is called.
        let parent = try task(id: "parent", text: "I plan to delegate", children: ["child"])
        let childText = "Actual completed browser result. [Readable source](HTTPS://example.com/path)."
        let child = try task(id: "child", text: childText, parent: "parent")
        let result = try await TaskResultResolver.resolve(root: parent) { _ in child }
        precondition(result.status == .completed)
        precondition(result.spokenText == childText && result.tasks.last?.text == childText)
        VoiceOutputStub.reset()
        _ = try await api.speech(VoiceCompletedReplySpeech.request(completedReply: result.spokenText))
        let rendered = try JSONSerialization.jsonObject(with: body(VoiceOutputStub.requests()[0])) as! [String: String]
        precondition(rendered["text"] == "Actual completed browser result. Readable source." && rendered["text"] != parent.text)
        precondition(!rendered["text"]!.localizedCaseInsensitiveContains("https"))
        precondition(VoiceOutputStub.requests().allSatisfy { $0.url?.path == "/v1/speech" })
        print("Voice output contracts passed: paired auth, independent readiness/limits, MPEG validation, no retry, fresh IDs, cancellation generations, and verified leaf-to-TTS text (synthetic only).")
    }

    static func task(id: String, text: String, parent: String? = nil, children: [String] = []) throws -> CoordinatorTask {
        var json: [String: Any] = ["id": id, "requestId": UUID().uuidString, "chatId": "chat", "deviceId": "mac", "status": "completed", "workStatus": "completed", "prompt": "test", "text": text, "createdAt": "now", "updatedAt": "now", "childTaskIds": children]
        if let parent { json["parentTaskId"] = parent }
        return try JSONDecoder().decode(CoordinatorTask.self, from: JSONSerialization.data(withJSONObject: json))
    }
    static func expectThrows(_ action: () async throws -> Void) async { do { try await action(); preconditionFailure("Expected rejection") } catch { } }
    static func expectThrowsSync(_ action: () throws -> Void) { do { try action(); preconditionFailure("Expected rejection") } catch { } }
    static func body(_ request: URLRequest) -> Data {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open(); defer { stream.close() }
        var data = Data(); var buffer = [UInt8](repeating: 0, count: 1024)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count <= 0 { break }
            data.append(contentsOf: buffer.prefix(count))
        }
        return data
    }
}
