import SwiftUI

enum GooseVisualState: String, Equatable {
    case idle, listening, sending, thinking, ready, speaking, paused, review, error
}

enum GoosePressEvent { case began, released, cancelled }

struct GooseButton: View {
    let state: GooseVisualState
    let level: Double
    let reducedMotion: Bool
    var stage: ProvidenceFlowStage? = nil
    var active = true
    var targetIdentity: String? = nil
    var pressedOverride = false
    let pressChanged: (GoosePressEvent) -> Void
    @GestureState private var gestureActive = false
    @State private var touchStarted = false
    @State private var touchCancelled = false
    var body: some View {
        GeometryReader { proxy in
            let size = min(proxy.size.width, proxy.size.height)
            ProvidenceGooseScene(stage: stage ?? state.flowStage, level: level,
                pressed: touchStarted || pressedOverride, reducedMotion: reducedMotion, active: active, targetIdentity: targetIdentity)
                .frame(width: size, height: size)
            .contentShape(Circle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .updating($gestureActive) { _, state, _ in state = true }
                    .onChanged { value in
                        guard !touchCancelled else { return }
                        let dx = value.location.x - size / 2, dy = value.location.y - size / 2
                        let travel = value.translation.width * value.translation.width + value.translation.height * value.translation.height
                        guard dx * dx + dy * dy <= size * size / 4, travel <= 32 * 32 else {
                            touchCancelled = true; touchStarted = false
                            pressChanged(.cancelled)
                            return
                        }
                        if !touchStarted { touchStarted = true; pressChanged(.began) }
                    }
                    .onEnded { value in
                        defer { touchCancelled = false }
                        guard touchStarted else { return }
                        touchStarted = false
                        let dx = value.location.x - size / 2, dy = value.location.y - size / 2
                        let inside = dx * dx + dy * dy <= size * size / 4
                        let travelSquared = value.translation.width * value.translation.width + value.translation.height * value.translation.height
                        pressChanged(inside && travelSquared <= 32 * 32 ? .released : .cancelled)
                    }
            )
            // System cancellation resets GestureState without calling onEnded.
            .onChange(of: gestureActive) { _, active in
                guard !active else { return }
                touchCancelled = false
                if touchStarted { touchStarted = false; pressChanged(.cancelled) }
            }
        }
        .aspectRatio(1, contentMode: .fit)
        .accessibilityElement(children: .ignore)
    }
}

extension GooseVisualState {
    var flowStage: ProvidenceFlowStage {
        switch self {
        case .idle: return .idle
        case .listening: return .listening
        case .sending: return .transcribing
        case .thinking: return .routing
        case .ready: return .success
        case .speaking: return .speaking
        case .paused: return .paused
        case .review: return .approval
        case .error: return .recoverableError
        }
    }
}
