import UIKit

enum ProvidencePageState: Equatable {
    case loading
    case ready
    case recovery(title: String, message: String)

    static func recovery(for error: Error) -> Self {
        let code = (error as NSError).code
        if code == NSURLErrorNotConnectedToInternet || code == NSURLErrorNetworkConnectionLost {
            return .recovery(title: "You’re offline", message: "Connect to the internet, then try again.")
        }
        return .recovery(title: "Let’s reconnect", message: "Providence couldn’t load this page. Try again when your connection is ready.")
    }
}

enum ProvidenceColors {
    static let paper = UIColor(white: 245.0 / 255, alpha: 1)
    static let graphite = UIColor(white: 11.0 / 255, alpha: 1)
    static let background = UIColor { $0.userInterfaceStyle == .dark ? graphite : .white }
    static let foreground = UIColor { $0.userInterfaceStyle == .dark ? paper : UIColor(white: 17.0 / 255, alpha: 1) }
    static let accent = UIColor { $0.userInterfaceStyle == .dark ? .white : .black }
}

/// A native loading surface only. It never changes account or request state.
final class ProvidenceStatusView: UIView {
    private let heading = UILabel()
    private let message = UILabel()
    private let spinner = UIActivityIndicatorView(style: .medium)
    private let retry = UIButton(type: .system)
    private let safari = UIButton(type: .system)
    private let footnote = UILabel()
    var onRetry: (() -> Void)?
    var onOpenSafari: (() -> Void)?
    private(set) var state: ProvidencePageState = .loading

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = ProvidenceColors.background
        let scroll = UIScrollView()
        let content = UIView()
        scroll.translatesAutoresizingMaskIntoConstraints = false
        content.translatesAutoresizingMaskIntoConstraints = false
        addSubview(scroll); scroll.addSubview(content)
        NSLayoutConstraint.activate([
            scroll.topAnchor.constraint(equalTo: safeAreaLayoutGuide.topAnchor), scroll.bottomAnchor.constraint(equalTo: safeAreaLayoutGuide.bottomAnchor),
            scroll.leadingAnchor.constraint(equalTo: leadingAnchor), scroll.trailingAnchor.constraint(equalTo: trailingAnchor),
            content.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor), content.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor),
            content.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor), content.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor),
            content.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor), content.heightAnchor.constraint(greaterThanOrEqualTo: scroll.frameLayoutGuide.heightAnchor)
        ])
        let stack = UIStackView()
        stack.axis = .vertical; stack.alignment = .center; stack.spacing = 16
        stack.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(stack)
        let mark = ProvidenceOrigamiMark()
        mark.translatesAutoresizingMaskIntoConstraints = false
        mark.accessibilityElementsHidden = true
        stack.addArrangedSubview(mark)
        NSLayoutConstraint.activate([mark.widthAnchor.constraint(equalToConstant: 72), mark.heightAnchor.constraint(equalToConstant: 72)])
        let brand = UILabel()
        brand.text = "Providence"
        brand.font = UIFontMetrics(forTextStyle: .title1).scaledFont(for: .systemFont(ofSize: 30, weight: .semibold))
        brand.adjustsFontForContentSizeCategory = true
        brand.textColor = ProvidenceColors.foreground
        stack.addArrangedSubview(brand)
        stack.setCustomSpacing(28, after: brand)
        heading.font = .preferredFont(forTextStyle: .headline)
        heading.textColor = ProvidenceColors.foreground
        heading.accessibilityTraits = .header
        heading.accessibilityIdentifier = "native-status-title"
        message.font = .preferredFont(forTextStyle: .body)
        message.textColor = .secondaryLabel
        for label in [heading, message] {
            label.numberOfLines = 0; label.textAlignment = .center
            label.adjustsFontForContentSizeCategory = true
            stack.addArrangedSubview(label)
            label.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }
        spinner.color = ProvidenceColors.accent
        spinner.accessibilityLabel = "Connecting to Providence"
        stack.addArrangedSubview(spinner)
        var button = UIButton.Configuration.filled()
        button.title = "Try again"
        button.baseBackgroundColor = ProvidenceColors.foreground
        button.baseForegroundColor = ProvidenceColors.background
        button.cornerStyle = .capsule
        button.contentInsets = .init(top: 16, leading: 28, bottom: 16, trailing: 28)
        retry.configuration = button
        retry.accessibilityIdentifier = "native-retry"
        retry.addTarget(self, action: #selector(retryTapped), for: .touchUpInside)
        stack.addArrangedSubview(retry)
        safari.setTitle("Open in Safari", for: .normal)
        safari.tintColor = ProvidenceColors.accent
        safari.titleLabel?.font = .preferredFont(forTextStyle: .body)
        safari.titleLabel?.adjustsFontForContentSizeCategory = true
        safari.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true
        safari.addTarget(self, action: #selector(safariTapped), for: .touchUpInside)
        stack.addArrangedSubview(safari)
        footnote.text = "Reloading doesn’t resend a request."
        footnote.font = .preferredFont(forTextStyle: .footnote)
        footnote.textColor = .secondaryLabel
        footnote.numberOfLines = 0; footnote.textAlignment = .center
        footnote.adjustsFontForContentSizeCategory = true
        stack.addArrangedSubview(footnote)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: content.centerXAnchor), stack.centerYAnchor.constraint(equalTo: content.centerYAnchor),
            stack.topAnchor.constraint(greaterThanOrEqualTo: content.topAnchor, constant: 28), stack.bottomAnchor.constraint(lessThanOrEqualTo: content.bottomAnchor, constant: -28),
            stack.leadingAnchor.constraint(greaterThanOrEqualTo: content.leadingAnchor, constant: 28),
            stack.trailingAnchor.constraint(lessThanOrEqualTo: content.trailingAnchor, constant: -28),
            stack.widthAnchor.constraint(lessThanOrEqualToConstant: 360)
        ])
        apply(.loading)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func apply(_ state: ProvidencePageState) {
        self.state = state
        isHidden = state == .ready
        switch state {
        case .loading:
            heading.text = "Your computers, one conversation."
            message.text = "Connecting to Providence…"
            spinner.startAnimating()
            retry.isHidden = true; safari.isHidden = true; footnote.isHidden = true
        case .ready:
            spinner.stopAnimating()
        case let .recovery(title, detail):
            heading.text = title; message.text = detail
            spinner.stopAnimating()
            retry.isHidden = false; safari.isHidden = false; footnote.isHidden = false
        }
    }

    @objc private func retryTapped() { onRetry?() }
    @objc private func safariTapped() { onOpenSafari?() }
}

/// The same seven facets used by the web favicon and iPhone app icon.
private final class ProvidenceOrigamiMark: UIView {
    override init(frame: CGRect) { super.init(frame: frame); isOpaque = false; backgroundColor = .clear }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override func draw(_ rect: CGRect) {
        guard let context = UIGraphicsGetCurrentContext() else { return }
        context.scaleBy(x: bounds.width / 64, y: bounds.height / 64)
        ProvidenceColors.foreground.setFill()
        let facets: [[CGPoint]] = [
            [.init(x: 3, y: 12), .init(x: 8.5, y: 6.4), .init(x: 9, y: 12)],
            [.init(x: 9.7, y: 6.1), .init(x: 18.9, y: 8.5), .init(x: 11.1, y: 20.5)],
            [.init(x: 12.2, y: 21), .init(x: 20.8, y: 7), .init(x: 30.2, y: 20.8)],
            [.init(x: 22, y: 6.7), .init(x: 33.1, y: 3.2), .init(x: 31.3, y: 20.3)],
            [.init(x: 34.3, y: 3), .init(x: 61, y: 8.4), .init(x: 32.5, y: 20.4)],
            [.init(x: 12.4, y: 22.3), .init(x: 31, y: 22.1), .init(x: 41.7, y: 38.1)],
            [.init(x: 21.9, y: 28.9), .init(x: 42.3, y: 39.4), .init(x: 21.9, y: 61)]
        ]
        for points in facets {
            let path = UIBezierPath(); path.move(to: points[0])
            points.dropFirst().forEach { path.addLine(to: $0) }
            path.close(); path.fill()
        }
    }
    override func traitCollectionDidChange(_ previous: UITraitCollection?) {
        super.traitCollectionDidChange(previous)
        setNeedsDisplay()
    }
}
