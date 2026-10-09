#if DEBUG
import SwiftUI

/// Silent, isolated animation QA. No service models, recording, credentials,
/// speech synthesizer, or requests are created by this view.
struct ProvidenceFlowPreview: View {
    static var requested: Bool {
        ProcessInfo.processInfo.arguments.contains("--preview-flow-sequence") ||
        ProcessInfo.processInfo.arguments.contains { $0.hasPrefix("--preview-flow-state=") }
    }

    @State private var stage: ProvidenceFlowStage = .idle
    @State private var pressed = false
    @Environment(\.accessibilityReduceMotion) private var accessibilityReduceMotion
    @Environment(\.scenePhase) private var scenePhase

    private var reducedMotion: Bool {
        accessibilityReduceMotion || ProcessInfo.processInfo.arguments.contains("--preview-reduce-motion")
    }

    var body: some View {
        GeometryReader { geometry in
            VStack(spacing: 5) {
                ProvidenceGooseScene(stage: stage, level: stage == .listening ? 0.65 : 0,
                    pressed: pressed, reducedMotion: reducedMotion, active: scenePhase == .active)
                    .frame(width: min(geometry.size.width * 0.82, geometry.size.height * 0.69),
                           height: min(geometry.size.width * 0.82, geometry.size.height * 0.69))
                    .accessibilityIdentifier("flow-preview-goose")
                    .accessibilityLabel(stage.title)
                    .accessibilityValue(stage.rawValue)
                Text(stage.title).font(.caption).fontWeight(.medium).lineLimit(1).minimumScaleFactor(0.75)
                Text(stage == .running || stage == .routing ? "Demo Mac" : "Animation preview")
                    .font(.caption2).foregroundStyle(.secondary).lineLimit(1)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(ProvidencePalette.graphite)
        .task {
            if let argument = ProcessInfo.processInfo.arguments.first(where: { $0.hasPrefix("--preview-flow-state=") }) {
                let value = String(argument.dropFirst("--preview-flow-state=".count))
                pressed = value == "pressed"
                stage = ProvidenceFlowStage(rawValue: value) ?? .idle
                return
            }
            let sequence: [(ProvidenceFlowStage, Bool, Double)] = [
                (.idle, false, 2), (.idle, true, 1), (.preparing, true, 1),
                (.listening, true, 3), (.transcribing, false, 2), (.routing, false, 2),
                (.running, false, 3), (.approval, false, 2), (.clarification, false, 2),
                (.running, false, 2), (.preparingReply, false, 2), (.speaking, false, 3),
                (.paused, false, 2), (.speaking, false, 2), (.success, false, 3),
                (.idle, false, 2), (.recoverableError, false, 3), (.idle, false, 2)
            ]
            for (next, touch, seconds) in sequence {
                guard !Task.isCancelled else { return }
                stage = next; pressed = touch
                NSLog("ProvidenceAnimationQA stage=%@ pressed=%@", next.rawValue, touch.description)
                do { try await Task.sleep(for: .seconds(seconds)) } catch { return }
            }
        }
        .task {
            guard ProcessInfo.processInfo.arguments.contains("--preview-flow-sequence") else { return }
            // Main-actor scheduling delay while every visual state animates.
            // This detects blocking; it is not a physical-device FPS claim.
            var delays: [Double] = []
            for _ in 0..<780 {
                let start = ContinuousClock.now
                do { try await Task.sleep(for: .milliseconds(50)) } catch { return }
                let elapsed = start.duration(to: .now).components
                let seconds = Double(elapsed.seconds) + Double(elapsed.attoseconds) / 1e18
                delays.append(max(0, seconds - 0.05) * 1_000)
            }
            delays.sort()
            NSLog("ProvidenceAnimationQA main-actor overshoot samples=%d p95_ms=%.2f max_ms=%.2f reduce_motion=%@",
                  delays.count, delays[Int(Double(delays.count - 1) * 0.95)], delays.last ?? 0, reducedMotion.description)
        }
    }
}
#endif
