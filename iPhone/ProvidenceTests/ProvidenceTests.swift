import XCTest
import WebKit
@testable import Providence

@MainActor
final class ProvidenceTests: XCTestCase {
    func testOriginBoundaryRejectsCredentialsLookalikesAndForeignBlobs() {
        XCTAssertTrue(ProvidenceOrigin.contains(URL(string: "https://providence.hani.so/")))
        XCTAssertTrue(ProvidenceOrigin.contains(URL(string: "https://providence.hani.so:443/v1/chats")))
        for address in ["http://providence.hani.so/", "https://providence.hani.so.evil.example/",
                        "https://evil.example/?providence.hani.so", "https://user@providence.hani.so/",
                        "https://providence.hani.so:8443/", "file:///tmp/index.html"] {
            XCTAssertFalse(ProvidenceOrigin.permitsContent(URL(string: address)), address)
        }
        XCTAssertTrue(ProvidenceOrigin.permitsContent(URL(string: "blob:https://providence.hani.so/test-artifact")))
        XCTAssertFalse(ProvidenceOrigin.permitsContent(URL(string: "blob:https://evil.example/artifact")))
        XCTAssertFalse(ProvidenceOrigin.permitsContent(URL(string: "blob:null/artifact")))
    }

    func testConfigurationRetainsWebStorageAndAllowsInlineReplyPlayback() {
        let configuration = ProvidenceViewController.configuration()
        XCTAssertTrue(configuration.websiteDataStore.isPersistent)
        XCTAssertTrue(configuration.allowsInlineMediaPlayback)
        XCTAssertTrue(configuration.mediaTypesRequiringUserActionForPlayback.isEmpty)
        XCTAssertTrue(configuration.preferences.javaScriptCanOpenWindowsAutomatically == false)
    }

    func testNativeRecoveryIsInformativeAndNeverRetriesUntilTapped() {
        let status = ProvidenceStatusView(frame: CGRect(x: 0, y: 0, width: 320, height: 568))
        var retries = 0, safari = 0
        status.onRetry = { retries += 1 }
        status.onOpenSafari = { safari += 1 }
        status.apply(.loading)
        status.apply(.recovery(for: URLError(.notConnectedToInternet)))
        status.layoutIfNeeded()
        XCTAssertEqual(retries, 0); XCTAssertEqual(safari, 0)
        XCTAssertEqual(status.state, .recovery(title: "You’re offline", message: "Connect to the internet, then try again."))
        func descendants(_ view: UIView) -> [UIView] { view.subviews.flatMap { [$0] + descendants($0) } }
        let controls = descendants(status).compactMap { $0 as? UIButton }
        let retry = controls.first { $0.accessibilityIdentifier == "native-retry" }
        XCTAssertNotNil(retry)
        XCTAssertEqual(retry?.isHidden, false)
        retry?.sendActions(for: .touchUpInside)
        XCTAssertEqual(retries, 1); XCTAssertEqual(safari, 0)
        status.apply(.ready)
        XCTAssertTrue(status.isHidden)
        XCTAssertEqual(retries, 1)
    }

    func testNativeRecoveryDoesNotExposeUnderlyingErrorDetails() {
        let error = NSError(domain: NSURLErrorDomain, code: NSURLErrorTimedOut,
                            userInfo: [NSLocalizedDescriptionKey: "private-fixture-diagnostic"])
        XCTAssertEqual(ProvidencePageState.recovery(for: error), .recovery(title: "Let’s reconnect", message: "Providence couldn’t load this page. Try again when your connection is ready."))
    }

    // Read-only live-origin integration. Does not pair, record, submit a task or call providers.
    func testLiveOriginRendersAndExposesVoiceAPIs() async throws {
        let browser = WKWebView(frame: CGRect(x: 0, y: 0, width: 390, height: 844),
                                configuration: ProvidenceViewController.configuration())
        let observer = NavigationObserver()
        browser.navigationDelegate = observer
        try await observer.navigate(browser, request: URLRequest(url: ProvidenceOrigin.url))
        let properties = try await browser.evaluateJavaScript("""
        ({ secure: isSecureContext, capture: typeof navigator.mediaDevices?.getUserMedia === 'function',
           audioContext: typeof AudioContext === 'function', worklet: typeof AudioWorkletNode === 'function',
           recorder: typeof MediaRecorder === 'function', mp4: MediaRecorder.isTypeSupported('audio/mp4'),
           audio: document.createElement('audio').canPlayType('audio/mpeg'),
           title: document.title, origin: location.origin })
        """) as! [String: Any]
        XCTAssertEqual(properties["origin"] as? String, "https://providence.hani.so")
        XCTAssertEqual(properties["secure"] as? Bool, true)
        XCTAssertEqual(properties["capture"] as? Bool, true)
        XCTAssertEqual(properties["recorder"] as? Bool, true)
        XCTAssertEqual(properties["audioContext"] as? Bool, true)
        XCTAssertEqual(properties["worklet"] as? Bool, true)
        XCTAssertEqual(properties["mp4"] as? Bool, true)
        XCTAssertFalse((properties["audio"] as? String ?? "").isEmpty)
        XCTAssertTrue((properties["title"] as? String ?? "").contains("Providence"))
        // Use a non-auth fixture key. Reload preserves a page session, a new WebView does not.
        _ = try await browser.evaluateJavaScript("sessionStorage.setItem('providence.native-test', 'fixture')")
        try await observer.reload(browser)
        let retained = try await browser.evaluateJavaScript("sessionStorage.getItem('providence.native-test')")
        XCTAssertEqual(retained as? String, "fixture")
        let fresh = WKWebView(frame: .zero, configuration: ProvidenceViewController.configuration())
        let freshObserver = NavigationObserver()
        fresh.navigationDelegate = freshObserver
        try await freshObserver.navigate(fresh, request: URLRequest(url: ProvidenceOrigin.url))
        let freshSession = try await fresh.evaluateJavaScript("sessionStorage.getItem('providence.native-test')")
        XCTAssertTrue(freshSession is NSNull)
        _ = try await browser.evaluateJavaScript("sessionStorage.removeItem('providence.native-test')")
    }
}

@MainActor
private final class NavigationObserver: NSObject, WKNavigationDelegate {
    private var completion: CheckedContinuation<Void, Error>?

    func navigate(_ browser: WKWebView, request: URLRequest) async throws {
        try await withCheckedThrowingContinuation { continuation in
            completion = continuation
            browser.load(request)
        }
    }

    func reload(_ browser: WKWebView) async throws {
        try await withCheckedThrowingContinuation { continuation in
            completion = continuation
            browser.reload()
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        completion?.resume()
        completion = nil
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        completion?.resume(throwing: error)
        completion = nil
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        completion?.resume(throwing: error)
        completion = nil
    }
}
