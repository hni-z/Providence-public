import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public protocol HTTPTransport: Sendable {
    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

public struct URLSessionTransport: HTTPTransport {
    private let session: URLSession

    public init(session: URLSession = .shared) {
        self.session = session
    }

    public func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await session.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw CoordinatorClientError.nonHTTPResponse
        }
        return (data, httpResponse)
    }
}

public struct ClosureBearerTokenProvider: Sendable {
    private let provider: @Sendable () async throws -> String

    public init(_ provider: @escaping @Sendable () async throws -> String) {
        self.provider = provider
    }

    func token() async throws -> String {
        try await provider()
    }
}
