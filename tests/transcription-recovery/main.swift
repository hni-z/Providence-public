import Foundation
import WatchCoordinatorAdapter

// In-memory HTTP only. No sockets, providers, microphones, or task dispatch.
actor RecoveryTransport: HTTPTransport {
    struct Device: Sendable {
        let id: String
        var online = true
        var configured = true
    }
    enum PostMode { case completed, pending, loseAcknowledgement, wrongRequest, fail, interrupt, pauseCompleted }
    enum GetMode { case completed, wrongRequest, wrongDevice, fail, interrupt, pending, pauseCancelled, waitUntilCancelled }
    private(set) var requests: [URLRequest] = []
    private(set) var paused = false
    private var continuation: CheckedContinuation<Void, Never>?
    private var requestID = ""
    private var deviceID = ""
    private var postMode: PostMode
    private var getMode: GetMode
    private let directory: URL
    private let devices: [Device]
    private let jobID = "11111111-1111-4111-8111-111111111111"

    init(directory: URL, post: PostMode = .completed, get: GetMode = .completed, devices: [Device]? = nil) {
        self.directory = directory
        self.postMode = post
        self.getMode = get
        self.devices = devices ?? [Device(id: "paired-mac")]
    }

    func release() { continuation?.resume(); continuation = nil; paused = false }

    private func pause() async {
        paused = true
        await withCheckedContinuation { continuation = $0 }
    }

    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        requests.append(request)
        require(request.value(forHTTPHeaderField: "Authorization") == "Bearer synthetic-test-token")
        let path = request.url!.path
        var code = 200
        var body: [String: Any]
        if request.httpMethod == "GET", path == "/v1/transcriptions" {
            let metadata = devices.map { ["id": $0.id, "name": $0.id, "online": $0.online, "configured": $0.configured] as [String: Any] }
            body = ["transcription": ["available": true, "devices": metadata,
                "mimeTypes": ["audio/mp4"], "maxAudioBytes": 524288, "provider": "Synthetic"]]
        } else if request.httpMethod == "POST", path == "/v1/transcriptions" {
            let fields = try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: String]
            requestID = fields["requestId"]!
            deviceID = fields["deviceId"]!
            // These must already be durable when POST crosses the transport boundary.
            let receipt = try JSONSerialization.jsonObject(with: Data(contentsOf: directory.appendingPathComponent("receipt.json"))) as! [String: Any]
            let bytes = try Data(contentsOf: directory.appendingPathComponent("recording.m4a"))
            require(UUID(uuidString: receipt["requestID"] as! String) == UUID(uuidString: requestID))
            require(receipt["deviceID"] as? String == deviceID)
            require(bytes == Data(base64Encoded: fields["base64"]!))
            require(fields["mimeType"] == "audio/mp4")
            require((try FileManager.default.attributesOfItem(atPath: directory.path)[.posixPermissions] as! NSNumber).intValue == 0o700)
            for name in ["receipt.json", "recording.m4a"] {
                require((try FileManager.default.attributesOfItem(atPath: directory.appendingPathComponent(name).path)[.posixPermissions] as! NSNumber).intValue == 0o600)
            }
            code = 202
            switch postMode {
            case .loseAcknowledgement:
                postMode = .completed
                throw URLError(.networkConnectionLost)
            case .pauseCompleted:
                await pause() // Deliberately ignores cancellation to exercise a late acknowledgement.
                body = job(status: "completed")
            case .completed: body = job(status: "completed")
            case .pending: body = job(status: "pending")
            case .wrongRequest: body = job(status: "completed", wrongRequest: true)
            case .fail: body = job(status: "failed")
            case .interrupt: body = job(status: "interrupted")
            }
        } else if request.httpMethod == "GET", path == "/v1/transcriptions/\(jobID)" {
            switch getMode {
            case .completed: body = job(status: "completed")
            case .wrongRequest: body = job(status: "completed", wrongRequest: true)
            case .wrongDevice: body = job(status: "completed", wrongDevice: true)
            case .fail: body = job(status: "failed")
            case .interrupt: body = job(status: "interrupted")
            case .pending: body = job(status: "pending")
            case .waitUntilCancelled:
                try await Task.sleep(nanoseconds: 10_000_000_000)
                fatalError("GET was not cancelled at the polling deadline")
            case .pauseCancelled:
                getMode = .completed
                await pause()
                throw CancellationError()
            }
        } else {
            fatalError("Unexpected request or task dispatch: \(request.httpMethod ?? "") \(path)")
        }
        return (try JSONSerialization.data(withJSONObject: body), HTTPURLResponse(
            url: request.url!, statusCode: code, httpVersion: nil, headerFields: nil
        )!)
    }

    private func job(status: String, wrongRequest: Bool = false, wrongDevice: Bool = false) -> [String: Any] {
        var fields: [String: Any] = [
            "id": jobID, "requestId": wrongRequest ? "22222222-2222-4222-8222-222222222222" : requestID,
            "deviceId": wrongDevice ? "wrong-mac" : deviceID, "status": status,
            "text": status == "completed" ? "Preserved exact transcript" : "",
        ]
        if status == "failed" || status == "interrupted" {
            fields["error"] = "Synthetic terminal failure"
            fields["errorCode"] = "restart_interrupted"
        }
        return fields
    }
}

@main
struct RecoveryTests {
    @MainActor
    static func main() async throws {
        try await lostAcknowledgement()
        try await cancelledKnownJob()
        try await lateCancelledCompletion()
        try await identityMismatch()
        try await completedRetention()
        try await invalidReceipt()
        try await deviceSelection()
        try await capturedRouteRetention()
        try await pendingTranscriptCannotBeDiscarded()
        try await terminalFailure()
        try await boundedPolling()
        print("PASS: 11 recovery scenarios (including corruption, identity, device, route and terminal-state matrices)")
    }

    @MainActor
    static func lostAcknowledgement() async throws {
        let directory = tempDirectory(); defer { try? FileManager.default.removeItem(at: directory) }
        let transport = RecoveryTransport(directory: directory, post: .loseAcknowledgement)
        let client = try client(transport)
        let session = VoiceTranscriptionSession(directory: directory)
        do {
            _ = try await session.transcribe(audio: audio, client: client, preferredDeviceID: "paired-mac", purpose: "legacy")
            fatalError("Lost acknowledgement must throw")
        } catch let error as URLError { require(error.code == .networkConnectionLost) }
        require(session.hasRecovery && session.recoveryPurpose == "legacy")
        let stored = try receipt(directory)
        require(stored["jobID"] == nil)
        let restarted = VoiceTranscriptionSession(directory: directory)
        let before = await transport.requests.count
        require(before == 2) // init never performs recovery or discovery.
        let text = try await restarted.recover(client: client)
        require(text == "Preserved exact transcript" && restarted.hasRecovery)
        require(restarted.recoveryPurpose == "legacy")
        let requests = await transport.requests
        require(requests.map(\.httpMethod) == ["GET", "POST", "POST"])
        require(requests[1].httpBody == requests[2].httpBody)
        restarted.consume()
        require(!restarted.hasRecovery && restarted.recoveryPurpose == nil)
        require(!FileManager.default.fileExists(atPath: directory.appendingPathComponent("recording.m4a").path))
        require(!FileManager.default.fileExists(atPath: directory.appendingPathComponent("receipt.json").path))
    }

    @MainActor
    static func cancelledKnownJob() async throws {
        let directory = tempDirectory(); defer { try? FileManager.default.removeItem(at: directory) }
        let transport = RecoveryTransport(directory: directory, post: .pending, get: .pauseCancelled)
        let client = try client(transport)
        let session = VoiceTranscriptionSession(directory: directory)
        let operation = Task { try await session.transcribe(audio: audio, client: client, preferredDeviceID: "paired-mac") }
        try await waitForPause(transport)
        require(try receipt(directory)["jobID"] != nil)
        // A second button cannot start another request while the first is active.
        do { _ = try await session.recover(client: client); fatalError("Concurrent recovery accepted") }
        catch VoiceTranscriptionSession.SessionError.busy { }
        session.consume()
        require(session.hasRecovery)
        operation.cancel()
        await transport.release()
        do { _ = try await operation.value; fatalError("Cancelled operation returned a result") }
        catch is CancellationError { }
        let restarted = VoiceTranscriptionSession(directory: directory)
        let text = try await restarted.recover(client: client)
        require(text == "Preserved exact transcript")
        let requests = await transport.requests
        require(requests.map(\.httpMethod) == ["GET", "POST", "GET", "GET"])
        require(requests.suffix(2).allSatisfy { $0.url!.path.hasPrefix("/v1/transcriptions/") })
    }

    @MainActor
    static func lateCancelledCompletion() async throws {
        let directory = tempDirectory(); defer { try? FileManager.default.removeItem(at: directory) }
        let transport = RecoveryTransport(directory: directory, post: .pauseCompleted)
        let client = try client(transport)
        let session = VoiceTranscriptionSession(directory: directory)
        let operation = Task { try await session.transcribe(audio: audio, client: client, preferredDeviceID: "paired-mac") }
        try await waitForPause(transport)
        operation.cancel()
        await transport.release()
        do { _ = try await operation.value; fatalError("Late result escaped cancellation") }
        catch is CancellationError { }
        require(try receipt(directory)["transcript"] as? String == "Preserved exact transcript")
        let restarted = VoiceTranscriptionSession(directory: directory)
        let result = try await restarted.recover(client: client)
        require(result == "Preserved exact transcript")
        let count = await transport.requests.count
        require(count == 2) // The stored result needs no POST or GET.
    }

    @MainActor
    static func identityMismatch() async throws {
        for getMode in [RecoveryTransport.GetMode.wrongRequest, .wrongDevice] {
            let directory = tempDirectory(); defer { try? FileManager.default.removeItem(at: directory) }
            let transport = RecoveryTransport(directory: directory, post: .pending, get: getMode)
            let client = try client(transport)
            let session = VoiceTranscriptionSession(directory: directory)
            do {
                _ = try await session.transcribe(audio: audio, client: client, preferredDeviceID: "paired-mac")
                fatalError("Mismatched transcript returned")
            } catch VoiceTranscriptionSession.SessionError.identityMismatch { }
            require(session.hasRecovery)
            require(try receipt(directory)["transcript"] == nil)
            let requests = await transport.requests
            require(requests.map(\.httpMethod) == ["GET", "POST", "GET"])
        }
        let directory = tempDirectory(); defer { try? FileManager.default.removeItem(at: directory) }
        let transport = RecoveryTransport(directory: directory, post: .wrongRequest)
        let session = VoiceTranscriptionSession(directory: directory)
        do {
            _ = try await session.transcribe(audio: audio, client: try client(transport), preferredDeviceID: "paired-mac")
            fatalError("Mismatched POST returned")
        } catch CoordinatorClientError.transcriptionResponseMismatch { }
        require(session.hasRecovery)
        require(try receipt(directory)["jobID"] == nil)
    }

    @MainActor
    static func completedRetention() async throws {
        let directory = tempDirectory(); defer { try? FileManager.default.removeItem(at: directory) }
        let transport = RecoveryTransport(directory: directory)
        let client = try client(transport)
        let session = VoiceTranscriptionSession(directory: directory)
        let text = try await session.transcribe(audio: audio, client: client, preferredDeviceID: "paired-mac")
        require(text == "Preserved exact transcript" && session.hasRecovery && session.recoveryPurpose == "task")
        do {
            _ = try await session.transcribe(audio: audio, client: client, preferredDeviceID: "different")
            fatalError("Saved result overwritten")
        } catch VoiceTranscriptionSession.SessionError.recoveryRequired { }
        let restored = VoiceTranscriptionSession(directory: directory)
        require(try await restored.recover(client: client) == text)
        let count = await transport.requests.count
        require(count == 2)
        restored.consume()
        let empty = VoiceTranscriptionSession(directory: directory)
        require(!empty.hasRecovery)
        do { _ = try await empty.recover(client: client); fatalError("Empty recovery accepted") }
        catch VoiceTranscriptionSession.SessionError.noRecovery { }
    }

    @MainActor
    static func invalidReceipt() async throws {
        let source = tempDirectory(); defer { try? FileManager.default.removeItem(at: source) }
        let seedTransport = RecoveryTransport(directory: source, post: .loseAcknowledgement)
        let seed = VoiceTranscriptionSession(directory: source)
        do { _ = try await seed.transcribe(audio: audio, client: try client(seedTransport), preferredDeviceID: "paired-mac") }
        catch is URLError { }
        let valid = try Data(contentsOf: source.appendingPathComponent("receipt.json"))
        for corruption in ["json", "missing-audio", "changed-audio", "purpose", "job", "version", "transcript", "missing-receipt"] {
            let directory = tempDirectory(); defer { try? FileManager.default.removeItem(at: directory) }
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try audio.write(to: directory.appendingPathComponent("recording.m4a"))
            try valid.write(to: directory.appendingPathComponent("receipt.json"))
            switch corruption {
            case "json": try Data("{".utf8).write(to: directory.appendingPathComponent("receipt.json"))
            case "missing-audio": try FileManager.default.removeItem(at: directory.appendingPathComponent("recording.m4a"))
            case "changed-audio": try Data([4, 5, 6, 7]).write(to: directory.appendingPathComponent("recording.m4a"))
            case "missing-receipt": try FileManager.default.removeItem(at: directory.appendingPathComponent("receipt.json"))
            default:
                var fields = try receipt(directory)
                if corruption == "purpose" { fields["purpose"] = "unknown" }
                if corruption == "job" { fields["jobID"] = "bad-id" }
                if corruption == "version" { fields["version"] = 2 }
                if corruption == "transcript" { fields["transcript"] = "Result without job ID" }
                try JSONSerialization.data(withJSONObject: fields).write(to: directory.appendingPathComponent("receipt.json"))
            }
            let transport = RecoveryTransport(directory: directory)
            let client = try client(transport)
            let session = VoiceTranscriptionSession(directory: directory)
            require(session.hasRecovery && session.recoveryPurpose == nil)
            do { _ = try await session.recover(client: client); fatalError("Invalid receipt recovered") }
            catch VoiceTranscriptionSession.SessionError.invalidReceipt { }
            do {
                _ = try await session.transcribe(audio: audio, client: client, preferredDeviceID: "paired-mac")
                fatalError("Invalid receipt overwritten")
            } catch VoiceTranscriptionSession.SessionError.invalidReceipt { }
            session.consume()
            require(session.hasRecovery)
            let count = await transport.requests.count
            require(count == 0)
        }
    }

    @MainActor
    static func deviceSelection() async throws {
        let paired = RecoveryTransport.Device(id: "paired-mac")
        let other = RecoveryTransport.Device(id: "other-mac")
        let offline = RecoveryTransport.Device(id: "paired-mac", online: false)
        let unconfigured = RecoveryTransport.Device(id: "paired-mac", configured: false)
        for (devices, preferred, expected) in [
            ([other, paired], "paired-mac", "paired-mac"),
            ([paired], "paired-mac", "paired-mac"),
            ([offline, other], "paired-mac", ""),
            ([unconfigured, other], "paired-mac", ""),
            ([other], "paired-mac", ""),
            ([other], "unknown", ""),
            ([other, paired], "unknown", ""), ([offline, unconfigured], "paired-mac", ""),
        ] {
            let directory = tempDirectory(); defer { try? FileManager.default.removeItem(at: directory) }
            let transport = RecoveryTransport(directory: directory, devices: devices)
            let session = VoiceTranscriptionSession(directory: directory)
            do {
                _ = try await session.transcribe(audio: audio, client: try client(transport), preferredDeviceID: preferred)
                require(!expected.isEmpty)
                require(try receipt(directory)["deviceID"] as? String == expected)
            } catch VoiceTranscriptionSession.SessionError.deviceSetupRequired { require(expected.isEmpty) }
            if expected.isEmpty {
                require(!session.hasRecovery)
                let requests = await transport.requests
                require(requests.map(\.httpMethod) == ["GET"])
            }
        }
    }

    @MainActor
    static func capturedRouteRetention() async throws {
        let directory = tempDirectory(); defer { try? FileManager.default.removeItem(at: directory) }
        let identity = VoiceCaptureIdentity(actionRequestID: UUID(), transcriptionRequestID: UUID(), actionDeviceID: "action-mac",
                                            actionChatID: "action-chat", transcriptionDeviceID: "paired-mac")
        let session = VoiceTranscriptionSession(directory: directory)
        let transport = RecoveryTransport(directory: directory)
        _ = try await session.transcribe(audio: audio, client: try client(transport), preferredDeviceID: "paired-mac",
                                          captureIdentity: identity)
        require(session.recoveredCaptureIdentity == identity)
        require(UUID(uuidString: try receipt(directory)["requestID"] as? String ?? "") == identity.transcriptionRequestID)
        let reopened = VoiceTranscriptionSession(directory: directory)
        require(reopened.recoveredCaptureIdentity == identity)
        let wrongIdentity = VoiceCaptureIdentity(actionRequestID: UUID(), transcriptionRequestID: UUID(),
                                                 actionDeviceID: "other", actionChatID: "chat", transcriptionDeviceID: "paired-mac")
        require(!reopened.discardCompletedTask(captureIdentity: wrongIdentity))
        require(reopened.discardCompletedTask(captureIdentity: identity))
        require(!reopened.hasRecovery)
        let nextIdentity = VoiceCaptureIdentity(actionRequestID: UUID(), transcriptionRequestID: UUID(),
                                                actionDeviceID: "new-target", actionChatID: "new-chat", transcriptionDeviceID: "paired-mac")
        let next = VoiceTranscriptionSession(directory: directory)
        _ = try await next.transcribe(audio: audio, client: try client(transport), preferredDeviceID: "paired-mac",
                                     captureIdentity: nextIdentity)
        require(next.recoveredCaptureIdentity == nextIdentity)
    }

    @MainActor
    static func pendingTranscriptCannotBeDiscarded() async throws {
        let directory = tempDirectory(); defer { try? FileManager.default.removeItem(at: directory) }
        let identity = VoiceCaptureIdentity(actionRequestID: UUID(), transcriptionRequestID: UUID(),
                                            actionDeviceID: "action", actionChatID: "chat", transcriptionDeviceID: "paired-mac")
        let session = VoiceTranscriptionSession(directory: directory, pollingTimeout: 0)
        do {
            _ = try await session.transcribe(audio: audio, client: try client(RecoveryTransport(directory: directory, post: .pending)),
                                              preferredDeviceID: "paired-mac", captureIdentity: identity)
            fatalError("Pending transcription returned a transcript")
        } catch VoiceTranscriptionSession.SessionError.pollingTimedOut { }
        require(session.hasRecovery && !session.hasCompletedTranscript)
        require(!session.discardCompletedTask(captureIdentity: identity))
    }

    @MainActor
    static func terminalFailure() async throws {
        for (post, get) in [
            (RecoveryTransport.PostMode.fail, RecoveryTransport.GetMode.completed),
            (.interrupt, .completed), (.pending, .fail), (.pending, .interrupt),
        ] {
            let directory = tempDirectory(); defer { try? FileManager.default.removeItem(at: directory) }
            let transport = RecoveryTransport(directory: directory, post: post, get: get)
            let session = VoiceTranscriptionSession(directory: directory)
            do {
                _ = try await session.transcribe(audio: audio, client: try client(transport), preferredDeviceID: "paired-mac")
                fatalError("Terminal failure returned text")
            } catch VoiceTranscriptionSession.SessionError.terminalFailure(let message) {
                require(message == "Synthetic terminal failure")
            }
            require(!session.hasRecovery && session.recoveryPurpose == nil)
            require(!VoiceTranscriptionSession(directory: directory).hasRecovery)
        }
    }

    @MainActor
    static func boundedPolling() async throws {
        for mode in [RecoveryTransport.GetMode.pending, .waitUntilCancelled] {
            let directory = tempDirectory(); defer { try? FileManager.default.removeItem(at: directory) }
            let transport = RecoveryTransport(directory: directory, post: .pending, get: mode)
            let session = VoiceTranscriptionSession(directory: directory, pollingInterval: 0.01, pollingTimeout: 0.03)
            let start = ContinuousClock().now
            do {
                _ = try await session.transcribe(audio: audio, client: try client(transport), preferredDeviceID: "paired-mac")
                fatalError("Pending job exceeded polling bound")
            } catch VoiceTranscriptionSession.SessionError.pollingTimedOut { }
            require(start.duration(to: ContinuousClock().now) < .seconds(1))
            require(session.hasRecovery)
            require(try receipt(directory)["jobID"] != nil)
            let requests = await transport.requests
            require(requests.filter { $0.httpMethod == "POST" }.count == 1)
        }
    }

    static let audio = Data([0, 255, 16, 42])
    static func tempDirectory() -> URL { FileManager.default.temporaryDirectory.appendingPathComponent("transcription-test-\(UUID())") }
    static func receipt(_ directory: URL) throws -> [String: Any] {
        try JSONSerialization.jsonObject(with: Data(contentsOf: directory.appendingPathComponent("receipt.json"))) as! [String: Any]
    }
    static func client(_ transport: RecoveryTransport) throws -> CoordinatorClient {
        try CoordinatorClient(baseURL: URL(string: "https://synthetic.example")!, transport: transport,
            tokenProvider: ClosureBearerTokenProvider { "synthetic-test-token" })
    }
    static func waitForPause(_ transport: RecoveryTransport) async throws {
        let deadline = ContinuousClock().now.advanced(by: .seconds(2))
        while !(await transport.paused) {
            require(ContinuousClock().now < deadline, "Fake transport did not pause")
            try await Task.sleep(nanoseconds: 1_000_000)
        }
    }
}

private func require(_ condition: Bool, _ message: String = "Recovery expectation failed", file: StaticString = #file, line: UInt = #line) {
    precondition(condition, message, file: file, line: line)
}
