import SwiftUI
import WatchCoordinatorAdapter

/// Uses the existing paired client's registry. Choosing a row never creates a
/// conversation, changes permissions, or submits work.
struct WatchTargetSelectionView: View {
    @ObservedObject var model: MacControlModel
    @Environment(\.dismiss) private var dismiss

    private struct ComputerSection: Identifiable {
        let id: String
        let name: String
        let chats: [WatchTargetOption]
    }

    private var computers: [ComputerSection] {
        Dictionary(grouping: model.targetOptions, by: \.deviceID).map { id, options in
            ComputerSection(id: id, name: options.first?.deviceName ?? id,
                chats: options.sorted { ($0.chatName, $0.id) < ($1.chatName, $1.id) })
        }.sorted { ($0.name, $0.id) < ($1.name, $1.id) }
    }

    private func availability(_ option: WatchTargetOption) -> String {
        if model.targetCatalogLoading { return "Checking" }
        if model.targetCatalogError != nil { return "Unconfirmed" }
        return option.online ? "Online" : "Offline"
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Button {
                        model.selectVoiceTarget()
                        dismiss()
                    } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 3) {
                                Text("Choose by voice")
                                Text("Name a computer, or use your default.")
                                    .font(.caption2).foregroundStyle(.secondary)
                            }
                            Spacer(minLength: 4)
                            if model.usesVoiceTarget { Image(systemName: "checkmark").foregroundStyle(Color(white: 0.78)) }
                        }
                    }
                    .accessibilityIdentifier("target-by-voice")
                } header: { Text("Next request") }

                if model.targetCatalogLoading {
                    ProgressView("Checking computers")
                        .accessibilityIdentifier("target-catalog-loading")
                }
                if let error = model.targetCatalogError {
                    Text(error).font(.caption2).foregroundStyle(ProvidencePalette.paper)
                        .accessibilityIdentifier("target-catalog-error")
                }
                if computers.isEmpty && !model.targetCatalogLoading && model.targetCatalogError == nil {
                    Text("No existing conversations are available. Open Providence on your computer to check its connection.")
                        .font(.caption2).foregroundStyle(.secondary)
                        .accessibilityIdentifier("target-catalog-empty")
                }
                ForEach(computers) { computer in
                    Section {
                        ForEach(computer.chats) { option in
                            Button {
                                model.selectLockedTarget(option)
                                if model.lockedTargetID == option.id { dismiss() }
                            } label: {
                                HStack {
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(option.chatName).lineLimit(2)
                                        Text(availability(option))
                                            .font(.caption2).foregroundStyle(.secondary)
                                    }
                                    Spacer(minLength: 4)
                                    if model.lockedTargetID == option.id {
                                        Image(systemName: "checkmark").foregroundStyle(Color(white: 0.78))
                                    }
                                }
                            }
                            .disabled(!option.online || model.targetCatalogLoading || model.targetCatalogError != nil)
                            .accessibilityIdentifier("target-chat-\(option.id)")
                            .accessibilityLabel("\(computer.name), \(option.chatName), \(availability(option))")
                        }
                    } header: { Text(computer.name) }
                }
                Section {
                    ForEach(CoordinatorWorkflowRole.allCases, id: \.self) { role in
                        Picker(role.rawValue.capitalized, selection: Binding(
                            get: { model.workflowTargetID(for: role) ?? "" },
                            set: { selected in
                                if let option = model.targetOptions.first(where: { $0.id == selected }) {
                                    model.setWorkflowTarget(option, for: role)
                                }
                            })) {
                                if model.workflowTargetID(for: role) == nil {
                                    Text("Choose computer").tag("")
                                }
                                ForEach(model.targetOptions) { option in
                                    Text("\(option.deviceName) · \(option.chatName)")
                                        .tag(option.id).disabled(!option.online)
                                }
                            }
                            .disabled(model.targetCatalogLoading || model.targetCatalogError != nil || !model.canStartNewRequest)
                            .accessibilityIdentifier("workflow-target-\(role.rawValue)")
                    }
                    Text("Research first. Analysis and presentation follow on two other computers.")
                        .font(.caption2).foregroundStyle(.secondary)
                    if let error = model.workflowSelectionError {
                        Text(error).font(.caption2).foregroundStyle(ProvidencePalette.paper)
                    }
                    Button("Use three-computer workflow") {
                        if model.selectWorkflowMode() { dismiss() }
                    }
                    .disabled(!model.canSelectWorkflow)
                    .accessibilityIdentifier("select-workflow")
                } header: { Text("Three-computer workflow") }

                Button("Refresh computers", systemImage: "arrow.clockwise") {
                    Task { await model.refreshTargetCatalog() }
                }
                .disabled(model.targetCatalogLoading)
                .accessibilityIdentifier("refresh-target-catalog")
            }
            .navigationTitle("Computers")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .task { await model.refreshTargetCatalog() }
        }
    }
}
