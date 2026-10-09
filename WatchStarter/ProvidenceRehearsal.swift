#if DEBUG
import Combine
import Foundation

/// Local presentation fixtures for the integrated Watch rehearsal.
/// This type is deliberately isolated from recorder, coordinator, pairing, and
/// speech services: every state below is explicitly staged for visual QA only.
@MainActor
final class ProvidenceRehearsal: ObservableObject {
    static var requested: Bool {
        let arguments = ProcessInfo.processInfo.arguments
        return arguments.contains("--preview-integrated-flow") || arguments.contains { $0.hasPrefix("--preview-integrated-state=") }
    }

    static func requestedStage(from arguments: [String] = ProcessInfo.processInfo.arguments) -> ProvidenceFlowStage? {
        guard let argument = arguments.first(where: { $0.hasPrefix("--preview-integrated-state=") }) else {
            return nil
        }
        return ProvidenceFlowStage(rawValue: String(argument.dropFirst("--preview-integrated-state=".count)))
    }

    @Published private(set) var stage: ProvidenceFlowStage
    @Published private(set) var pressed = false
    @Published private(set) var level = 0.0
    @Published private(set) var reviewPresented = false
    @Published private(set) var didDismiss = false
    @Published private(set) var resultReady = false
    private var localCapture = false
    private var declined = false
    private var sequenceEpoch = UUID()

    let targetLabel = "Demo MacBook Pro"
    private var interaction = GooseInteraction()

    init(arguments: [String] = ProcessInfo.processInfo.arguments) {
        stage = Self.requestedStage(from: arguments) ?? .idle
        resultReady = [.preparingReply, .speaking, .paused, .success].contains(stage)
    }

    var statusText: String {
        switch stage {
        case .idle: return "Presentation rehearsal ready"
        case .preparing: return "Opening rehearsal microphone"
        case .listening: return "Listening in rehearsal"
        case .transcribing: return "Reading rehearsal words"
        case .routing: return "Routing to \(targetLabel)"
        case .running: return "Running rehearsal action on \(targetLabel)"
        case .approval: return "Rehearsal approval requested"
        case .clarification: return "Rehearsal question requested"
        case .preparingReply: return "Preparing rehearsal reply"
        case .speaking: return "Playing rehearsal reply"
        case .success: return "The demo note is ready. No real action was performed."
        case .paused: return "Rehearsal reply paused"
        case .recoverableError: return declined ? "The demo action was declined. No real action was performed." : "Connection lost. Your original request is saved. Check its status before trying again."
        }
    }

    var question: String? {
        switch stage {
        case .approval: return "Allow creating the demo note on Demo Mac?"
        case .clarification: return "Which folder should I use?"
        default: return nil
        }
    }

    var options: [String] {
        switch stage {
        case .approval: return ["Allow", "Decline"]
        case .clarification: return ["Desktop", "Documents"]
        default: return []
        }
    }

    /// Runs a fixed, silent 45-second fixture. It does not infer completion or
    /// create a request: every shown stage is selected explicitly here.
    func run() async {
        interaction.cancel()
        let epoch = UUID()
        sequenceEpoch = epoch
        async let measurement: Void = measureResponsiveness()
        let sequence: [(ProvidenceFlowStage, TimeInterval)] = [
            (.idle, 2), (.preparing, 1), (.listening, 4), (.transcribing, 2),
            (.routing, 2), (.clarification, 4), (.running, 3), (.approval, 4),
            (.running, 3), (.preparingReply, 2), (.speaking, 4), (.paused, 2),
            (.speaking, 2), (.success, 3), (.idle, 2), (.recoverableError, 3), (.idle, 2)
        ]
        for (fixtureStage, duration) in sequence {
            guard !Task.isCancelled, sequenceEpoch == epoch else { return }
            setStage(fixtureStage, opensReview: fixtureStage == .approval || fixtureStage == .clarification)
            try? await Task.sleep(for: .seconds(duration))
        }
        await measurement
    }

    private func measureResponsiveness() async {
        var delays: [Double] = []
        for _ in 0..<840 {
            let start = ContinuousClock.now
            do { try await Task.sleep(for: .milliseconds(50)) } catch { return }
            let elapsed = start.duration(to: .now).components
            let seconds = Double(elapsed.seconds) + Double(elapsed.attoseconds) / 1e18
            let delay = max(0, seconds - 0.05) * 1_000
            delays.append(delay)
            if delay > 50 { print(String(format: "ProvidenceIntegratedQA slow_sample stage=%@ delay_ms=%.2f", stage.rawValue, delay)) }
        }
        delays.sort()
        print(String(format: "ProvidenceIntegratedQA heartbeat samples=%d p95_ms=%.2f max_ms=%.2f",
            delays.count, delays[Int(Double(delays.count - 1) * 0.95)], delays.last ?? 0))
    }

    func showReview() {
        sequenceEpoch = UUID()
        guard stage != .idle || resultReady || didDismiss else { return }
        reviewPresented = true
        didDismiss = false
    }

    func dismissReview() {
        sequenceEpoch = UUID()
        reviewPresented = false
        didDismiss = true
    }

    func choose(_ option: String) {
        guard options.contains(option) else { return }
        sequenceEpoch = UUID()
        reviewPresented = false
        didDismiss = false
        setStage(option == "Decline" ? .recoverableError : .running)
        declined = option == "Decline"
    }

    func primaryTap() {
        sequenceEpoch = UUID()
        switch stage {
        case .approval, .clarification:
            showReview()
        case .running, .routing, .recoverableError:
            showReview()
        case .idle where didDismiss:
            showReview()
        default: break
        }
    }

    func togglePlayback() {
        sequenceEpoch = UUID()
        switch stage {
        case .speaking: setStage(.paused)
        case .paused, .success:
            if resultReady { setStage(.speaking) }
        default: break
        }
    }

    /// Mirrors the real tap reducer locally. First tap listens, second tap
    /// transcribes, and release never changes recording state.
    func handlePress(_ event: GoosePressEvent) {
        sequenceEpoch = UUID()
        switch event {
        case .began:
            guard interaction.pressBegan() == .activate else { return }
            pressed = true
            switch stage {
            case .idle:
                localCapture = true
                setStage(.listening)
            case .listening:
                guard localCapture else { return }
                localCapture = false
                setStage(.transcribing)
            case .preparing:
                interaction.cancel()
                pressed = false
                localCapture = false
                setStage(.idle)
            default:
                primaryTap()
            }
        case .released:
            pressed = false
            _ = interaction.pressEnded()
        case .cancelled:
            interaction.cancel()
            pressed = false
            level = 0
            if localCapture { setStage(.idle) }
            localCapture = false
        }
    }

    private func setStage(_ newStage: ProvidenceFlowStage, opensReview: Bool = false) {
        didDismiss = false
        declined = false
        reviewPresented = opensReview
        pressed = newStage == .preparing || newStage == .listening
        if [.preparingReply, .speaking, .paused, .success].contains(newStage) { resultReady = true }
        if newStage == .listening || newStage == .recoverableError { resultReady = false }
        level = newStage == .listening ? 0.64 : 0
        stage = newStage
        print("ProvidenceIntegratedQA stage=\(newStage.rawValue)")
    }
}
#endif
