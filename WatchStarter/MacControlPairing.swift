import Foundation

private final class NoRedirectDelegate: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

struct MacControlPairing {
    private struct Response: Decodable { let token: String }

    static func exchange(code: String, configuration: ProvidenceCoordinatorConfiguration) async throws {
        let trimmed = code.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.count <= 50 else {
            throw MacControlError.message("Enter the one-use client pairing code from Providence.")
        }
        let delegate = NoRedirectDelegate()
        let settings = URLSessionConfiguration.ephemeral
        settings.urlCache = nil
        settings.timeoutIntervalForRequest = 30
        let session = URLSession(configuration: settings, delegate: delegate, delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        var request = URLRequest(url: configuration.baseURL.appendingPathComponent("client/exchange"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpBody = try JSONEncoder().encode(["code": trimmed])
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw MacControlError.message("Pairing did not complete. The code may be expired or already used.")
        }
        let received: Response
        do { received = try JSONDecoder().decode(Response.self, from: data) }
        catch { throw MacControlError.message("Pairing returned an invalid response.") }
        try MacControlKeychain.saveToken(received.token)
    }
}
