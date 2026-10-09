#if DEBUG
import SwiftUI

/// Opt-in observation of SwiftUI timeline updates. This does not measure the
/// physical display's presented frames and is absent from Release builds.
struct ProvidenceFrameProbe: ViewModifier {
    let stage: ProvidenceFlowStage
    let date: Date
    @State private var sampler = ProvidenceFrameSampler()

    func body(content: Content) -> some View {
        content.onChange(of: date) { _, next in
            guard ProvidenceFrameSampler.enabled else { return }
            sampler.record(stage: stage, date: next)
        }
        .onChange(of: stage) { _, next in
            guard ProvidenceFrameSampler.enabled else { return }
            // A paused timeline produces no dates. Reset on the stage change
            // itself so its intentional pause is not counted as a dropped frame.
            sampler.transition(to: next)
        }
        .onDisappear { sampler.report() }
    }
}

private final class ProvidenceFrameSampler {
    static let enabled = ProcessInfo.processInfo.arguments.contains("--measure-goose-frames")
    private var stage: ProvidenceFlowStage?
    private var last: Date?
    private var intervals: [Double] = []

    func transition(to next: ProvidenceFlowStage) {
        guard stage != next else { return }
        report(); stage = next; last = nil
    }

    func record(stage next: ProvidenceFlowStage, date: Date) {
        transition(to: next)
        if let last {
            let delta = date.timeIntervalSince(last)
            if delta > 0 { intervals.append(delta) }
        }
        last = date
        if intervals.count >= 180 { report() }
    }

    func report() {
        guard intervals.count >= 10, let stage else { intervals.removeAll(keepingCapacity: true); return }
        let sorted = intervals.sorted()
        let mean = intervals.reduce(0, +) / Double(intervals.count)
        NSLog("ProvidenceFrameQA stage=%@ intervals=%d update_hz=%.2f p95_interval_ms=%.2f max_interval_ms=%.2f",
              stage.rawValue, intervals.count, 1 / mean,
              sorted[Int(Double(sorted.count - 1) * 0.95)] * 1_000,
              (sorted.last ?? 0) * 1_000)
        intervals.removeAll(keepingCapacity: true)
    }
}
#endif
