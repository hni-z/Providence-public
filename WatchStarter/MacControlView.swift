import SwiftUI
import WatchCoordinatorAdapter

struct MacControlView: View {
    @ObservedObject var model: MacControlModel
    let dictate: (@escaping (String) -> Void) -> Void

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: "laptopcomputer.and.iphone")
                .font(.title2).foregroundStyle(ProvidencePalette.accent)
            Text("Your Mac request").font(.headline)
            if let setup = model.setupMessage {
                Text(setup).font(.caption2).foregroundStyle(ProvidencePalette.paper)
            }
            if model.setupMessage == nil {
                pairing
                request
                taskStatus
            }
        }
        .buttonStyle(.bordered)
    }

    private var pairing: some View {
        Group {
            if !model.hasCredential {
                Text("Pair this Watch with a one-use client code before sending requests.")
                    .font(.caption2).foregroundStyle(.secondary)
                TextField("Client pairing code", text: $model.pairingCode)
                    .accessibilityIdentifier("mac-client-pairing-code")
                Button("Speak pairing code", systemImage: "mic") { dictate { model.pairingCode = $0 } }
                Button("Pair Watch") { model.pair() }
                    .disabled(model.busy || model.pairingCode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            } else {
                Text("This Watch is paired. A rejected credential will require a new one-use pairing code.")
                    .font(.caption2).foregroundStyle(.secondary)
            }
        }
    }

    private var request: some View {
        VStack(spacing: 8) {
            Text(model.text).font(.caption).accessibilityIdentifier("mac-request-text")
            Text("This exact request goes to your configured Mac conversation. Available actions depend on that Mac's tools.")
                .font(.caption2).foregroundStyle(.secondary)
            if model.preparedRequest != nil {
                Text("A request is saved for an explicit retry with the same ID and text.")
                    .font(.caption2).foregroundStyle(ProvidencePalette.paper)
            }
            Button(model.preparedRequest == nil ? "Send to Mac" : "Retry same request", systemImage: "arrow.up.circle") {
                model.sendOrRetry()
            }
            .tint(ProvidencePalette.accent)
            .disabled(!model.canSend)
        }
    }

    private var taskStatus: some View {
        VStack(spacing: 8) {
            Text(model.status).font(.caption).multilineTextAlignment(.center)
            if model.hasPendingTask, model.task?.status.isTerminal != true {
                Button("Refresh status") { model.refresh() }.disabled(model.busy)
            }
            if let task = model.task {
                if task.status == .needsInput {
                    if let approval = model.pendingApproval {
                        VStack(spacing: 6) {
                            Text(model.approvalTitle(approval)).font(.caption)
                            Text(model.approvalDetails(approval)).font(.caption2)
                            Button("Accept") { model.resolve(approval, .accept) }.tint(ProvidencePalette.accent).disabled(model.busy)
                            Button("Decline") { model.resolve(approval, .decline) }.tint(ProvidencePalette.accent).disabled(model.busy)
                        }
                    } else {
                        Text("Open the Providence workspace to review this approval.")
                            .font(.caption2).foregroundStyle(ProvidencePalette.paper)
                    }
                }
                if task.status.isTerminal { Button("New request") { model.newRequest() }.disabled(model.busy) }
            }
            if model.busy { ProgressView() }
        }
    }
}
