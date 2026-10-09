import SwiftUI

/// A compact, read-only summary of the current voice-action phase.
/// Slots never move or imply that an earlier phase completed.
struct ProvidencePhaseIndicators: View {
    let stage: ProvidenceFlowStage
    var compact: Bool = false

    fileprivate enum Phase: CaseIterable {
        case listen, work, reply

        var label: String {
            switch self {
            case .listen: return "Listen"
            case .work: return "Work"
            case .reply: return "Reply"
            }
        }

        var icon: String {
            switch self {
            case .listen: return "mic.fill"
            case .work: return "bolt.fill"
            case .reply: return "speaker.wave.2.fill"
            }
        }
    }

    private var currentPhase: Phase? {
        switch stage {
        case .preparing, .listening, .transcribing:
            return .listen
        case .routing, .running, .approval, .clarification:
            return .work
        case .preparingReply, .speaking, .paused, .success:
            return .reply
        case .idle, .recoverableError:
            return nil
        }
    }

    var body: some View {
        if !compact, let currentPhase {
            HStack(spacing: 8) {
                ForEach(Phase.allCases, id: \.self) { phase in
                    PhaseSlot(
                        phase: phase,
                        active: phase == currentPhase
                    )
                }
            }
            .frame(maxWidth: .infinity, idealHeight: 28)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Current phase: \(currentPhase.label)")
        }
    }
}

private struct PhaseSlot: View {
    let phase: ProvidencePhaseIndicators.Phase
    let active: Bool

    private let graphite = ProvidencePalette.accent
    private let inactive = Color(white: 0.42)

    var body: some View {
        VStack(spacing: 1) {
            Image(systemName: phase.icon)
                .font(.system(size: 12, weight: .semibold, design: .rounded))
                .accessibilityHidden(true)
            Text(phase.label)
                .font(.system(size: 9, weight: .semibold, design: .rounded))
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                .accessibilityHidden(true)
            Capsule()
                .fill(active ? graphite : .clear)
                .frame(width: 18, height: 2)
        }
        .foregroundStyle(active ? graphite : inactive)
        .frame(maxWidth: .infinity, idealHeight: 28)
    }
}
