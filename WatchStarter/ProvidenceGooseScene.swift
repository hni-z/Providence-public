import SwiftUI

/// A visual-only companion for the voice surface. Product state remains owned
/// by the parent; this scene neither starts nor delays capture, routing, or audio.
struct ProvidenceGooseScene: View {
    let stage: ProvidenceFlowStage
    let level: Double
    let pressed: Bool
    let reducedMotion: Bool
    var active: Bool = true
    var targetIdentity: String? = nil
    @State private var stageBegan = Date()
    @State private var reactionBegan = Date.distantPast
    @Environment(\.isLuminanceReduced) private var isLuminanceReduced

    private var motionAllowed: Bool {
        active && !reducedMotion && !isLuminanceReduced && stage != .paused
    }
    private var interval: TimeInterval { stage == .idle ? 1.0 / 30.0 : 1.0 / 60.0 }

    private var previewTime: TimeInterval? {
        #if DEBUG
        let prefix = "--preview-goose-time="
        return ProcessInfo.processInfo.arguments.first(where: { $0.hasPrefix(prefix) })
            .flatMap { Double($0.dropFirst(prefix.count)) }
        #else
        return nil
        #endif
    }

    var body: some View {
        GeometryReader { proxy in
            let size = min(proxy.size.width, proxy.size.height)
            TimelineView(.animation(minimumInterval: interval, paused: !motionAllowed || previewTime != nil)) { timeline in
                ProvidenceOrigamiArtwork(
                    stage: stage,
                    level: min(1, max(0, level)),
                    pressed: pressed,
                    animated: motionAllowed,
                    time: motionAllowed ? (previewTime ?? timeline.date.timeIntervalSinceReferenceDate) : 0,
                    elapsed: motionAllowed ? (previewTime ?? max(0, timeline.date.timeIntervalSince(stageBegan))) : 0,
                    reactionElapsed: motionAllowed ? max(0, timeline.date.timeIntervalSince(reactionBegan)) : 100,
                    size: size
                )
                .frame(width: size, height: size)
                #if DEBUG
                .modifier(ProvidenceFrameProbe(stage: stage, date: timeline.date))
                #endif
            }
            .frame(width: size, height: size)
            .accessibilityHidden(true)
        }
        .aspectRatio(1, contentMode: .fit)
        .onChange(of: stage) { _, _ in stageBegan = Date() }
        .onChange(of: targetIdentity) { _, value in
            if value != nil { reactionBegan = Date() }
        }
        .onChange(of: pressed) { _, value in
            if value { reactionBegan = Date() }
        }
    }
}

private struct ProvidenceOrigamiArtwork: View {
    let stage: ProvidenceFlowStage
    let level: Double
    let pressed: Bool
    let animated: Bool
    let time: TimeInterval
    let elapsed: TimeInterval
    let reactionElapsed: TimeInterval
    let size: CGFloat
    private let paper = ProvidencePalette.paper
    private let paperShade = Color(white: 0.87)
    private let paperDeep = ProvidencePalette.accent
    private let seam = ProvidencePalette.graphite
    private let graphite = ProvidencePalette.secondary
    private let silver = ProvidencePalette.accent

    private var working: Bool { [.preparing, .transcribing, .routing, .running, .preparingReply].contains(stage) }
    private var listening: Bool { stage == .listening }
    private var speaking: Bool { stage == .speaking }
    private var success: Bool { stage == .success }
    private var showsPhases: Bool { size >= 150 && stage != .idle && stage != .recoverableError }
    private var characterScale: CGFloat {
        if working { return showsPhases ? 0.46 : 0.50 }
        if listening || speaking { return showsPhases ? 0.52 : 0.68 }
        return showsPhases ? 0.62 : 0.88
    }
    private var characterOffset: CGFloat {
        guard showsPhases else { return 0 }
        return size * (listening || speaking ? 0.04 : working ? 0.13 : 0.15)
    }
    private var bob: CGFloat { 0 }
    private var tilt: Double {
        guard animated else { return 0 }
        if listening { return 1 }
        if working { return -1.6 }
        if stage == .clarification { return -4.5 }
        if stage == .recoverableError { return 3.5 }
        return 0
    }
    private var wingFold: Double {
        guard animated else { return 0 }
        if success && elapsed < 0.55 { return -5 * sin(elapsed * .pi / 0.55) }
        if pressed { return 3 }
        if reactionElapsed < 0.40 { return -3 * sin(reactionElapsed * .pi / 0.40) }
        if listening { return -1.5 - level * 2.5 }
        if speaking { return -1.5 - abs(sin(time * 4.5)) * 1.5 }
        if working { return 1.5 + sin(time * 1.1) * 0.45 }
        return 0
    }
    private var activeScale: CGFloat { pressed ? 0.975 : 1 }

    var body: some View {
        ZStack {
            ProvidencePhaseIndicators(stage: stage, compact: !showsPhases).frame(width: size * 0.92, height: 28).offset(y: -size * 0.39)
            if working { thinkingOrbit }
            bird.scaleEffect(characterScale * activeScale).offset(y: characterOffset + bob)
                .animation(animated ? .easeOut(duration: 0.16) : nil, value: pressed)
                .animation(animated ? .easeInOut(duration: 0.28) : nil, value: stage)
            stageCue
        }
    }

    private var bird: some View {
        ZStack {
            // Normalized from the supplied 193...500 × 99...411 artwork bounds.
            facet([p(0,16),p(10,5),p(11,16)], paperShade)
            facet([p(11,5),p(28,10),p(14,32)], paper)
            facet([p(30,7),p(14,32),p(47,31)], LinearGradient(colors: [paper,paperShade], startPoint: .top, endPoint: .bottom))
            facet([p(16,33),p(47,31),p(67,60)], LinearGradient(colors: [paper,paperDeep], startPoint: .top, endPoint: .bottom))
            // Both wing facets hinge together. The breast stays joined to the
            // tail, so a flap never tears the central silhouette apart.
            ZStack {
                facet([p(31,6),p(50,0),p(48,31)], paperShade)
                facet([p(52,0),p(100,10),p(49,31)], LinearGradient(colors: [paper,paperShade], startPoint: .topLeading, endPoint: .bottomTrailing))
            }.rotationEffect(.degrees(wingFold), anchor: UnitPoint(x: 0.49, y: 0.31))
            facet([p(33,44),p(67,63),p(33,100)], LinearGradient(colors: [paper,paperShade], startPoint: .top, endPoint: .bottom))
        }
        .frame(width: size, height: size).rotationEffect(.degrees(tilt)).shadow(color: .black.opacity(0.22), radius: size * 0.014, x: 0, y: size * 0.018)
    }

    private func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: x, y: y) }
    private func facet<S: ShapeStyle>(_ points: [CGPoint], _ fill: S) -> some View {
        OrigamiFacet(points).fill(fill).overlay(OrigamiFacet(points).stroke(seam, lineWidth: size * 0.009))
    }
    private var thinkingOrbit: some View {
        let diameter: CGFloat = size * (showsPhases ? 0.64 : 0.74)
        let centerOffset: CGFloat = showsPhases ? size * 0.13 : 0
        let lineWidth: CGFloat = max(1, size * 0.009)
        let rotation = animated ? time * 46 : 0
        return ZStack {
            Circle().stroke(graphite.opacity(0.24), lineWidth: lineWidth)
            Circle().trim(from: 0.55, to: 0.75)
                .stroke(silver, style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
            Circle().fill(silver).frame(width: lineWidth * 1.65, height: lineWidth * 1.65)
                .offset(y: -diameter * 0.5)
        }
        .frame(width: diameter, height: diameter)
        .rotationEffect(.degrees(rotation))
        .offset(y: centerOffset)
    }
    @ViewBuilder private var stageCue: some View {
        if listening { listeningBars }
        else if speaking { playbackBars }
        else if stage == .approval { badge("hand.raised.fill") }
        else if stage == .clarification { badge("questionmark") }
        else if stage == .recoverableError { badge("exclamationmark") }
        else if stage == .paused { badge("pause.fill") }
        else if success { badge("checkmark") }
    }
    private var listeningBars: some View {
        HStack(spacing: size * 0.020) { ForEach(0..<9, id: \.self) { index in
            let contour = 0.52 + 0.48 * sin((Double(index) / 8) * .pi)
            let wave = animated ? 0.5 + 0.5 * sin(time * 6.2 + Double(index) * 0.9) : 0.5
            let baseline = 0.018 + (animated ? 0.007 * wave : 0)
            let microphone = level * 0.070 * contour * (0.55 + 0.45 * wave)
            Capsule().fill(silver).frame(width: max(1.5, size * 0.014), height: size * (baseline + microphone))
        }}.offset(y: size * 0.43)
    }
    private var playbackBars: some View {
        HStack(spacing: size * 0.020) { ForEach(0..<9, id: \.self) { index in
            // This is a reply rhythm, deliberately independent of microphone level.
            let wave = animated ? 0.5 + 0.5 * sin(time * 4.2 + Double(index) * 0.72) : 0.5
            let height = 0.025 + 0.042 * wave
            Capsule().fill(silver).frame(width: max(1.5, size * 0.014), height: size * height)
        }}.offset(y: size * 0.43)
    }
    private func badge(_ symbol: String) -> some View {
        let iconSize: CGFloat = size * 0.085
        let inset: CGFloat = size * 0.038
        let diameter: CGFloat = iconSize + inset * 2
        let fillColor: Color = success ? silver : .white
        let verticalOffset: CGFloat = size * 0.28
        return ZStack {
            Circle().fill(fillColor.opacity(success ? 0.94 : 0.90))
            Circle().stroke(graphite.opacity(0.72), lineWidth: size * 0.009)
            Image(systemName: symbol)
                .font(.system(size: iconSize, weight: .black, design: .rounded))
                .foregroundColor(seam)
        }
        .frame(width: diameter, height: diameter)
        // Keep the cue in the negative space beside the tail, away from the head.
        .offset(x: size * 0.31, y: verticalOffset)
    }
}

private struct OrigamiFacet: Shape {
    let points: [CGPoint]
    init(_ points: [CGPoint]) { self.points = points }
    func path(in rect: CGRect) -> Path {
        guard let first = points.first else { return Path() }
        func point(_ value: CGPoint) -> CGPoint { CGPoint(x: rect.minX + rect.width * value.x / 100, y: rect.minY + rect.height * value.y / 100) }
        var path = Path(); path.move(to: point(first))
        for value in points.dropFirst() { path.addLine(to: point(value)) }
        path.closeSubpath(); return path
    }
}
