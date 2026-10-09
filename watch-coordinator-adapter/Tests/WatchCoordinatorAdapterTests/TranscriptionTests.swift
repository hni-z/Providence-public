import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import WatchCoordinatorAdapter

@MainActor
final class TranscriptionTests: XCTestCase {
    private let requestID = UUID(uuidString: "aaecb697-430a-4e6b-9938-7c9c874e74c1")!
    private let jobID = "cb5fa411-d1f3-4659-b13d-7fd794b63b8a"
    private let otherID = "1d6770e0-ed18-485a-a2dc-5f8042b23c86"
    private let deviceID = "test-mac"
    private let audio = Data([0, 255, 16])

    func testAvailabilityUnwrapsMetadataAndUsesAuthenticatedGET() async throws {
        for available in [true, false] {
            let body = Data("""
            {"transcription":{"available":\(available),"devices":[
              {"id":"test-mac","name":"Test Mac","online":\(available),"configured":true},
              {"id":"other-mac","name":"Other Mac","online":true,"configured":false}
            ],"mimeTypes":["audio/webm","audio/mp4","audio/ogg","audio/wav"],
            "maxAudioBytes":524288,"provider":"OpenAI"}}
            """.utf8)
            let transport = TranscriptionTransport([.http(200, body)])
            let client = try makeClient(transport)

            let availability = try await client.transcriptionAvailability()

            XCTAssertEqual(availability.available, available)
            XCTAssertEqual(availability.devices.count, 2)
            XCTAssertEqual(availability.devices[0].id, deviceID)
            XCTAssertEqual(availability.devices[0].name, "Test Mac")
            XCTAssertEqual(availability.devices[0].online, available)
            XCTAssertTrue(availability.devices[0].configured)
            XCTAssertFalse(availability.devices[1].configured)
            XCTAssertTrue(availability.mimeTypes.contains("audio/mp4"))
            XCTAssertEqual(availability.maxAudioBytes, 524_288)
            XCTAssertEqual(availability.provider, "OpenAI")
            let requests = await transport.requests
            XCTAssertEqual(requests.count, 1)
            let request = try XCTUnwrap(requests.first)
            assertAuthenticated(request, method: "GET", path: "/v1/transcriptions")
            XCTAssertNil(request.httpBody)
        }
    }

    func testSubmissionPreservesExactBytesAndLowercasedRequestIdentity() async throws {
        let transport = TranscriptionTransport([.http(202, try job())])
        let client = try makeClient(transport)

        let result = try await client.submitTranscription(requestID: requestID, deviceID: deviceID, audio: audio)

        XCTAssertEqual(result.id, jobID)
        XCTAssertEqual(result.requestID, requestID.uuidString.lowercased())
        XCTAssertEqual(result.deviceID, deviceID)
        XCTAssertEqual(result.status, .pending)
        XCTAssertFalse(result.status.isTerminal)
        XCTAssertNil(result.error)
        XCTAssertNil(result.errorCode)
        let requests = await transport.requests
        XCTAssertEqual(requests.count, 1)
        let request = try XCTUnwrap(requests.first)
        assertAuthenticated(request, method: "POST", path: "/v1/transcriptions")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        let body = try XCTUnwrap(request.httpBody)
        XCTAssertEqual(String(data: body, encoding: .utf8),
            #"{"base64":"AP8Q","deviceId":"test-mac","mimeType":"audio/mp4","requestId":"aaecb697-430a-4e6b-9938-7c9c874e74c1"}"#)
        let fields = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: String])
        XCTAssertEqual(Data(base64Encoded: try XCTUnwrap(fields["base64"])), audio)
    }

    func testExplicitResubmissionKeepsIdenticalBody() async throws {
        let response = TranscriptionTransport.Response.http(202, try job())
        let transport = TranscriptionTransport([response, response])
        let client = try makeClient(transport)
        for _ in 0..<2 {
            _ = try await client.submitTranscription(requestID: requestID, deviceID: deviceID, audio: audio)
        }
        let requests = await transport.requests
        XCTAssertEqual(requests.count, 2)
        XCTAssertEqual(requests[0].httpBody, requests[1].httpBody)
    }

    func testEmptyAndOversizedAudioAreRejectedBeforeNetwork() async throws {
        let transport = TranscriptionTransport([])
        let client = try makeClient(transport)
        for bytes in [Data(), Data(repeating: 1, count: 524_289)] {
            await assertError(.invalidTranscriptionAudioSize(bytes.count)) {
                try await client.submitTranscription(requestID: self.requestID, deviceID: self.deviceID, audio: bytes)
            }
        }
        let requests = await transport.requests
        XCTAssertTrue(requests.isEmpty)
    }

    func testMaximumAudioSizeIsAcceptedWithoutChangingBytes() async throws {
        let bytes = Data(repeating: 255, count: 524_288)
        let transport = TranscriptionTransport([.http(202, try job())])
        let client = try makeClient(transport)
        _ = try await client.submitTranscription(requestID: requestID, deviceID: deviceID, audio: bytes)
        let requests = await transport.requests
        let body = try XCTUnwrap(requests.first?.httpBody)
        let fields = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: String])
        XCTAssertEqual(Data(base64Encoded: try XCTUnwrap(fields["base64"])), bytes)
    }

    func testWrongEchoedRequestOrDeviceIsRejected() async throws {
        for overrides in [["requestId": otherID], ["deviceId": "other-mac"]] {
            let transport = TranscriptionTransport([.http(202, try job(overrides))])
            let client = try makeClient(transport)
            await assertError(.transcriptionResponseMismatch(
                id: jobID, expectedRequestID: requestID, expectedDeviceID: deviceID
            )) {
                try await client.submitTranscription(requestID: self.requestID, deviceID: self.deviceID, audio: self.audio)
            }
            let requests = await transport.requests
            XCTAssertEqual(requests.count, 1)
        }
    }

    func testPollingOnlyGetsRequestedJobAndNeverDispatchesCompletedText() async throws {
        let transport = TranscriptionTransport([
            .http(200, try job()),
            .http(200, try job(["status": "completed", "text": "A transcript / with emoji 🙂"])),
        ])
        let client = try makeClient(transport)
        let pending = try await client.transcription(id: jobID)
        let completed = try await client.transcription(id: jobID)
        XCTAssertEqual(pending.status, .pending)
        XCTAssertEqual(completed.status, .completed)
        XCTAssertTrue(completed.status.isTerminal)
        XCTAssertEqual(completed.text, "A transcript / with emoji 🙂")
        let requests = await transport.requests
        XCTAssertEqual(requests.count, 2)
        for request in requests {
            assertAuthenticated(request, method: "GET", path: "/v1/transcriptions/\(jobID)")
            XCTAssertNil(request.httpBody)
        }
    }

    func testPollingRejectsDifferentJobIdentity() async throws {
        let transport = TranscriptionTransport([.http(200, try job(["id": otherID]))])
        let client = try makeClient(transport)
        await assertError(.transcriptionIDMismatch(expectedID: jobID, actualID: otherID)) {
            try await client.transcription(id: self.jobID)
        }
    }

    func testUUIDIdentityComparisonAcceptsLetterCaseDifferences() async throws {
        let body = try job(["id": jobID.uppercased(), "requestId": requestID.uuidString])
        let transport = TranscriptionTransport([.http(202, body), .http(200, body)])
        let client = try makeClient(transport)
        _ = try await client.submitTranscription(requestID: requestID, deviceID: deviceID, audio: audio)
        _ = try await client.transcription(id: jobID)
    }

    func testInvalidLocalIdentitiesNeverReachTransport() async throws {
        let transport = TranscriptionTransport([])
        let client = try makeClient(transport)
        for invalid in ["", "test/mac", " mac", "é", String(repeating: "x", count: 201)] {
            await assertError(.invalidTranscriptionDeviceID) {
                try await client.submitTranscription(requestID: self.requestID, deviceID: invalid, audio: self.audio)
            }
        }
        for invalid in ["", "not-a-uuid", "../messages"] {
            await assertError(.invalidTranscriptionID) { try await client.transcription(id: invalid) }
        }
        let requests = await transport.requests
        XCTAssertTrue(requests.isEmpty)
    }

    func testInvalidPublicJobsAreRejectedAsMalformedResponses() async throws {
        let invalidFields: [[String: String]] = [
            ["id": "not-a-uuid"], ["requestId": "not-a-uuid"], ["deviceId": ""],
            ["deviceId": "bad/device"], ["status": "running"],
            ["status": "completed", "text": ""], ["status": "completed", "text": " \n\t"],
            ["status": "completed", "text": String(repeating: "x", count: 8001)],
            ["status": "completed", "text": String(repeating: "🙂", count: 4001)],
        ]
        for fields in invalidFields {
            // Both endpoints must validate the public job, not merely decode its text.
            for status in [200, 202] {
                let transport = TranscriptionTransport([.http(status, try job(fields))])
                let client = try makeClient(transport)
                do {
                    if status == 200 {
                        _ = try await client.transcription(id: jobID)
                    } else {
                        _ = try await client.submitTranscription(requestID: requestID, deviceID: deviceID, audio: audio)
                    }
                    XCTFail("Expected malformed public job")
                } catch let error as CoordinatorClientError {
                    guard case .malformedResponse = error else { return XCTFail("Unexpected error: \(error)") }
                }
                let requests = await transport.requests
                XCTAssertEqual(requests.count, 1)
            }
        }
    }

    func testCompletedTranscriptAtUTF16LimitIsAccepted() async throws {
        let transcript = String(repeating: "🙂", count: 4000)
        let transport = TranscriptionTransport([.http(200, try job(["status": "completed", "text": transcript]))])
        let client = try makeClient(transport)
        let completed = try await client.transcription(id: jobID)
        XCTAssertEqual(completed.text, transcript)
    }

    func testFailedAndInterruptedJobsPreserveErrorsWithoutRetry() async throws {
        for status in [TranscriptionStatus.failed, .interrupted] {
            let transport = TranscriptionTransport([.http(200, try job([
                "status": status.rawValue, "error": "No automatic retry was made.",
                "errorCode": status == .failed ? "provider_timeout" : "restart_interrupted",
            ]))])
            let client = try makeClient(transport)
            let result = try await client.transcription(id: jobID)
            XCTAssertEqual(result.status, status)
            XCTAssertTrue(result.status.isTerminal)
            XCTAssertEqual(result.error, "No automatic retry was made.")
            XCTAssertEqual(result.errorCode, status == .failed ? "provider_timeout" : "restart_interrupted")
            let requests = await transport.requests
            XCTAssertEqual(requests.map(\.httpMethod), ["GET"])
        }
    }

    func testHTTPFailuresAndUnexpectedSuccessStatusDoNotRetry() async throws {
        for status in [401, 409, 413, 429, 503, 200] {
            let transport = TranscriptionTransport([.http(status, Data(#"{"error":"Rejected"}"#.utf8))])
            let client = try makeClient(transport)
            await assertError(.unexpectedStatus(code: status, message: "Rejected")) {
                try await client.submitTranscription(requestID: self.requestID, deviceID: self.deviceID, audio: self.audio)
            }
            let requests = await transport.requests
            XCTAssertEqual(requests.count, 1)
        }
    }

    func testAmbiguousTransportFailureDoesNotRetryOrPoll() async throws {
        let transport = TranscriptionTransport([.failure(.timedOut)])
        let client = try makeClient(transport)
        do {
            _ = try await client.submitTranscription(requestID: requestID, deviceID: deviceID, audio: audio)
            XCTFail("Expected transport error")
        } catch let error as URLError {
            XCTAssertEqual(error.code, .timedOut)
        }
        let requests = await transport.requests
        XCTAssertEqual(requests.map(\.httpMethod), ["POST"])
    }

    func testAllTranscriptionEndpointsRequireBearerToken() async throws {
        let transport = TranscriptionTransport([])
        let client = try makeClient(transport, token: " \n")
        await assertError(.missingBearerToken) { try await client.transcriptionAvailability() }
        await assertError(.missingBearerToken) { try await client.transcription(id: self.jobID) }
        await assertError(.missingBearerToken) {
            try await client.submitTranscription(requestID: self.requestID, deviceID: self.deviceID, audio: self.audio)
        }
        let requests = await transport.requests
        XCTAssertTrue(requests.isEmpty)
    }

    private func makeClient(_ transport: TranscriptionTransport, token: String = "test-token") throws -> CoordinatorClient {
        try CoordinatorClient(
            baseURL: URL(string: "https://providence.example")!, transport: transport,
            tokenProvider: ClosureBearerTokenProvider { token }
        )
    }

    private func job(_ overrides: [String: String] = [:]) throws -> Data {
        var fields = [
            "id": jobID, "requestId": requestID.uuidString.lowercased(), "deviceId": deviceID,
            "status": "pending", "text": "",
        ]
        fields.merge(overrides) { _, replacement in replacement }
        return try JSONSerialization.data(withJSONObject: fields)
    }

    private func assertAuthenticated(_ request: URLRequest, method: String, path: String) {
        XCTAssertEqual(request.httpMethod, method)
        XCTAssertEqual(request.url?.scheme, "https")
        XCTAssertEqual(request.url?.host, "providence.example")
        XCTAssertEqual(request.url?.path, path)
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer test-token")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Accept"), "application/json")
    }

    private func assertError<T>(
        _ expected: CoordinatorClientError, file: StaticString = #filePath, line: UInt = #line,
        operation: () async throws -> T
    ) async {
        do {
            _ = try await operation()
            XCTFail("Expected \(expected)", file: file, line: line)
        } catch {
            XCTAssertEqual(error as? CoordinatorClientError, expected, file: file, line: line)
        }
    }
}

private actor TranscriptionTransport: HTTPTransport {
    enum Response: Sendable {
        case http(Int, Data)
        case failure(URLError.Code)
    }

    private var responses: [Response]
    private(set) var requests: [URLRequest] = []

    init(_ responses: [Response]) { self.responses = responses }

    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        requests.append(request)
        guard !responses.isEmpty else { throw URLError(.badServerResponse) }
        switch responses.removeFirst() {
        case let .http(status, data):
            let response = HTTPURLResponse(
                url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
            )!
            return (data, response)
        case let .failure(code):
            throw URLError(code)
        }
    }
}
