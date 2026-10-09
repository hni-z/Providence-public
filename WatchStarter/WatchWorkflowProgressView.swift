import SwiftUI

struct WatchWorkflowProgressView: View {
    let progress: WorkflowProgressSnapshot
    let targets: [WatchTargetOption]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(progress.rows, id: \.role) { row in
                VStack(alignment: .leading, spacing: 3) {
                    Text(row.role.rawValue.capitalized).font(.headline)
                    Text(targets.first(where: { $0.deviceID == row.deviceID })?.deviceName ?? "Assigned computer")
                        .font(.caption2).foregroundStyle(.secondary)
                    Text(label(row.state)).font(.caption2)
                    ForEach(row.artifactNames, id: \.self) { name in
                        Text(name).font(.caption2).foregroundStyle(Color(white: 0.78))
                    }
                }
                .accessibilityIdentifier("workflow-progress-\(row.role.rawValue)")
            }
            if progress.outputsReady {
                Text("The brief, comparison, and webpage files are ready.")
                    .font(.caption).foregroundStyle(Color(white: 0.78))
            }
        }
    }

    private func label(_ state: WorkflowProgressSnapshot.State) -> String {
        switch state {
        case .waiting: "Waiting"
        case .running: "Working"
        case .needsInput: "Needs your response"
        case .created: "File ready"
        case .failed: "Could not finish"
        case .blocked: "Waiting for a required result"
        case .uncertain: "Check status"
        }
    }
}
