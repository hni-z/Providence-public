import UIKit
import WebKit
import SafariServices

enum ProvidenceOrigin {
    static let url = URL(string: "https://providence.hani.so/")!

    static func contains(_ url: URL?) -> Bool {
        guard let url else { return false }
        return url.scheme == "https" && url.host == Self.url.host &&
            (url.port == nil || url.port == 443) && url.user == nil && url.password == nil
    }

    static func permitsContent(_ url: URL?) -> Bool {
        guard let url else { return false }
        if contains(url) { return true }
        // Authenticated artifact previews/downloads are object URLs created by the web app.
        return url.scheme == "blob" && contains(URL(string: String(url.absoluteString.dropFirst(5))))
    }
}

final class ProvidenceViewController: UIViewController, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    private(set) lazy var webView = WKWebView(frame: .zero, configuration: Self.configuration())
    private let statusView = ProvidenceStatusView()
    private var loadingTimeout: Task<Void, Never>?
    private var hasLoadedPage = false
    private var downloadFiles: [ObjectIdentifier: URL] = [:]
    private var pendingShares: [URL] = []

    static func configuration() -> WKWebViewConfiguration {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.allowsInlineMediaPlayback = true
        // Shared web voice arms playback only after an explicit Start gesture.
        configuration.mediaTypesRequiringUserActionForPlayback = []
        configuration.applicationNameForUserAgent = "Providence-iPhone/1.0"
        return configuration
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = ProvidenceColors.background
        webView.isOpaque = false
        webView.backgroundColor = ProvidenceColors.background
        webView.scrollView.backgroundColor = ProvidenceColors.background
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            webView.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor)
        ])
        statusView.translatesAutoresizingMaskIntoConstraints = false
        statusView.onRetry = { [weak self] in self?.reload() }
        statusView.onOpenSafari = { UIApplication.shared.open(ProvidenceOrigin.url) }
        view.addSubview(statusView)
        NSLayoutConstraint.activate([
            statusView.topAnchor.constraint(equalTo: view.topAnchor), statusView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            statusView.leadingAnchor.constraint(equalTo: view.leadingAnchor), statusView.trailingAnchor.constraint(equalTo: view.trailingAnchor)
        ])
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--preview-native-loading") { showState(.loading); return }
        if ProcessInfo.processInfo.arguments.contains("--preview-native-offline") {
            showState(.recovery(for: URLError(.notConnectedToInternet))); return
        }
        #endif
        showState(.loading)
        webView.load(URLRequest(url: ProvidenceOrigin.url))
    }

    @objc private func reload() {
        showState(.loading)
        if ProvidenceOrigin.contains(webView.url) { webView.reload() }
        else { webView.load(URLRequest(url: ProvidenceOrigin.url)) }
    }

    func suspendVoice() {
        guard isViewLoaded else { return }
        // Native cutoff backs up the shared web visibility/pagehide cancellation.
        webView.setMicrophoneCaptureState(.none, completionHandler: nil)
        webView.pauseAllMediaPlayback(completionHandler: nil)
        webView.setAllMediaPlaybackSuspended(true, completionHandler: nil)
    }

    func resumePage() {
        guard isViewLoaded else { return }
        // Pause first: unsuspending alone can resume previously suspended media.
        // Only a new web play gesture may restart it after returning to the app.
        webView.pauseAllMediaPlayback { [weak self] in
            guard UIApplication.shared.applicationState == .active else { return }
            self?.webView.setAllMediaPlaybackSuspended(false, completionHandler: nil)
        }
        presentNextShare()
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
        if ProvidenceOrigin.permitsContent(action.request.url) {
            decisionHandler(action.shouldPerformDownload ? .download : .allow)
            return
        }
        decisionHandler(.cancel)
        guard action.navigationType == .linkActivated, let url = action.request.url,
              ["http", "https"].contains(url.scheme ?? ""), presentedViewController == nil else { return }
        present(SFSafariViewController(url: url), animated: true)
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
                 decisionHandler: @escaping @MainActor @Sendable (WKNavigationResponsePolicy) -> Void) {
        guard ProvidenceOrigin.permitsContent(response.response.url) else {
            decisionHandler(.cancel)
            return
        }
        if response.isForMainFrame, let http = response.response as? HTTPURLResponse, http.statusCode >= 500 {
            decisionHandler(.cancel)
            showState(.recovery(title: "Providence is taking a moment", message: "The service isn’t available right now. Try again shortly."))
            return
        }
        decisionHandler(response.canShowMIMEType ? .allow : .download)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if action.targetFrame == nil, ProvidenceOrigin.permitsContent(action.request.url) {
            webView.load(action.request)
        }
        return nil
    }

    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping @MainActor @Sendable (WKPermissionDecision) -> Void) {
        let trusted = origin.protocol == "https" && origin.host == ProvidenceOrigin.url.host &&
            (origin.port == 0 || origin.port == 443) && frame.isMainFrame &&
            ProvidenceOrigin.contains(frame.request.url) && ProvidenceOrigin.contains(webView.url)
        decisionHandler(trusted && type == .microphone && UIApplication.shared.applicationState == .active ? .prompt : .deny)
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        if !hasLoadedPage || !statusView.isHidden { showState(.loading) }
        loadingTimeout?.cancel()
        loadingTimeout = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(20)) } catch { return }
            guard let self else { return }
            self.showState(.recovery(title: "Still connecting", message: "This is taking longer than usual. Check your connection, then try again."))
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        hasLoadedPage = true
        showState(.ready)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        navigationFailed(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        navigationFailed(error)
    }

    private func navigationFailed(_ error: Error) {
        guard (error as NSError).code != NSURLErrorCancelled else { return }
        showState(.recovery(for: error))
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        showState(.recovery(title: "Let’s reopen Providence", message: "iOS closed this page. Reload to check your conversation and the status of any submitted requests."))
    }

    private func showState(_ state: ProvidencePageState) {
        if state != .loading { loadingTimeout?.cancel(); loadingTimeout = nil }
        statusView.apply(state)
        webView.accessibilityElementsHidden = state != .ready
        if case .recovery = state { UIAccessibility.post(notification: .screenChanged, argument: statusView) }
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                  suggestedFilename: String, completionHandler: @escaping @MainActor @Sendable (URL?) -> Void) {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let name = (suggestedFilename as NSString).lastPathComponent
            let file = directory.appendingPathComponent(name.isEmpty || name == "." || name == ".." ? "Artifact" : name)
            downloadFiles[ObjectIdentifier(download)] = file
            completionHandler(file)
        } catch { completionHandler(nil) }
    }

    func download(_ download: WKDownload, willPerformHTTPRedirection response: HTTPURLResponse,
                  newRequest request: URLRequest, decisionHandler: @escaping @MainActor @Sendable (WKDownload.RedirectPolicy) -> Void) {
        decisionHandler(ProvidenceOrigin.contains(request.url) ? .allow : .cancel)
    }

    func downloadDidFinish(_ download: WKDownload) {
        if !webView.isLoading { showState(.ready) }
        guard let file = downloadFiles.removeValue(forKey: ObjectIdentifier(download)) else { return }
        pendingShares.append(file)
        presentNextShare()
    }

    private func presentNextShare() {
        guard UIApplication.shared.applicationState == .active, presentedViewController == nil,
              !pendingShares.isEmpty else { return }
        let file = pendingShares.removeFirst()
        let sheet = UIActivityViewController(activityItems: [file], applicationActivities: nil)
        sheet.completionWithItemsHandler = { [weak self] _, _, _, _ in
            try? FileManager.default.removeItem(at: file.deletingLastPathComponent())
            self?.presentNextShare()
        }
        sheet.popoverPresentationController?.sourceView = view
        present(sheet, animated: true)
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        if let file = downloadFiles.removeValue(forKey: ObjectIdentifier(download)) {
            try? FileManager.default.removeItem(at: file.deletingLastPathComponent())
        }
        let alert = UIAlertController(title: "Download unavailable", message: "Return to the artifact and try its download again.", preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default))
        if presentedViewController == nil { present(alert, animated: true) }
    }
}
