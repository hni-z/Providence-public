import Foundation
import SwiftUI
import OSLog
import WatchCoordinatorAdapter

@MainActor
final class MacControlModel: ObservableObject {
    @Published var text = ""
    @Published private(set) var status = "Pair your Providence account to begin."
    @Published private(set) var setupMessage: String?
    @Published private(set) var task: CoordinatorTask?
    @Published private(set) var result: TaskResultSnapshot?
    @Published private(set) var pendingApproval: CoordinatorApproval?
    @Published private(set) var busy = false
    @Published private(set) var hasCredential = false
    @Published var pairingCode = ""
    @Published private(set) var errorMessage: String?
    @Published private(set) var selectedDeviceName = ""
    @Published private(set) var voiceHandoffComplete = false
    @Published private(set) var targetOptions: [WatchTargetOption] = []
    @Published private(set) var targetCatalogLoading = false
    @Published private(set) var targetCatalogError: String?
    @Published private(set) var lockedTargetID: String?
    @Published private(set) var workflowMode = false
    @Published private(set) var workflowSelectionError: String?

    @Published private(set) var recoveryDismissed = false
    @Published private(set) var approvalRecoveryMessage: String?
    private var terminalReconciled = false
    private var lastDiagnostic: String?
    private let diagnostics = Logger(subsystem: "so.demo.providence.watch", category: "recovery")
    private let defaults: UserDefaults
    private var injectedClient: CoordinatorClient?
    private let dismissedKey = "macControl.recoveryDismissed"
    private let approvalAttemptKey = "macControl.approvalAttempt"
    private let preparedKey = "macControl.preparedRequest"
    private let taskKey = "macControl.taskID"
    private let selectedRouteKey = "macControl.selectedRoute"
    private let voiceCaptureKey = "macControl.voiceCapture"
    private let lockedTargetKey = "macControl.lockedTarget"
    private let workflowModeKey = "macControl.workflowMode"
    private let workflowTargetKey = "macControl.workflowTarget."
    private var configuration: ProvidenceCoordinatorConfiguration?
    private var pollTask: Task<Void, Never>?
    private var pollingTaskID: String?
    private var pollingStartedAt: Date?
    private var workTask: Task<Void, Never>?
    private var transcriptionMayHaveStarted = false
    private var active = true
    private var generation = UUID()

    private struct FrozenVoiceCapture: Codable, Equatable {
        let identity: VoiceCaptureIdentity
        let lockedTargetID: String?
        let lockedDeviceName: String?
        let defaultDeviceID: String
        let defaultChatID: String
        let preferredChatIDsByDevice: [String: String]
        let deviceAliasesByID: [String: String]
        let iphoneMirroringTarget: IPhoneMirroringTarget?
        let workflow: CoordinatorWorkflowManifest?
        var prospectiveWorkflow: CoordinatorWorkflowManifest? = nil
    }

    init() {
        defaults = .standard
        recoveryDismissed = defaults.bool(forKey: dismissedKey)
        lockedTargetID = defaults.string(forKey: lockedTargetKey)
        workflowMode = defaults.bool(forKey: workflowModeKey)
        do {
            configuration = try ProvidenceCoordinatorConfiguration.load()
            do { hasCredential = try MacControlKeychain.readToken() != nil }
            catch { hasCredential = false }
            if let saved = loadPrepared() { text = saved.spokenText ?? saved.text }
            status = hasPendingTask ? "Your request is saved. Check status when ready." : "Ready. Choose a computer or ask Providence."
            if let selected = selectedRoute { selectedDeviceName = selected.deviceID }
        } catch { setupMessage = error.localizedDescription }
    }

    #if DEBUG
    /// Synthetic transport + isolated storage; never reads credentials or live config.
    init(defaults: UserDefaults, configuration: ProvidenceCoordinatorConfiguration, client: CoordinatorClient) {
        self.defaults = defaults
        self.configuration = configuration
        injectedClient = client
        hasCredential = true
        recoveryDismissed = defaults.bool(forKey: dismissedKey)
        lockedTargetID = defaults.string(forKey: lockedTargetKey)
        workflowMode = defaults.bool(forKey: workflowModeKey)
        if let saved = loadPrepared() { text = saved.spokenText ?? saved.text }
        status = hasPendingTask ? "Your request is saved. Check status when ready." : "Ready."
    }
    #endif

    deinit { pollTask?.cancel(); workTask?.cancel() }

    var canSend: Bool {
        guard configuration != nil, hasCredential, !busy, !hasPendingTask, !hasApprovalAttempt else { return false }
        if let prepared = loadPrepared() { return text == (prepared.spokenText ?? prepared.text) }
        return !hasPreparedIdentity && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var preparedRequest: MacPreparedRequest? { loadPrepared() }
    var hasPendingTask: Bool { task != nil || defaults.object(forKey: taskKey) != nil }
    var hasPreparedIdentity: Bool { defaults.object(forKey: preparedKey) != nil }
    var hasApprovalAttempt: Bool { defaults.object(forKey: approvalAttemptKey) != nil }
    var canStartNewRequest: Bool { !busy && !hasPreparedIdentity && !hasApprovalAttempt && (!hasPendingTask || isFinished) }
    var canRetryPrepared: Bool { !busy && !hasPendingTask && !hasApprovalAttempt && preparedRequest != nil }
    var needsRecovery: Bool { errorMessage != nil || hasPreparedIdentity || hasPendingTask || hasApprovalAttempt }
    var canPlayResult: Bool { isFinished && result?.status == .completed }
    var usesVoiceTarget: Bool { lockedTargetID == nil && !workflowMode }
    private var canEditWorkflow: Bool { hasCredential && canStartNewRequest }
    var canSelectWorkflow: Bool {
        guard canEditWorkflow, targetCatalogError == nil, let workflow = selectedWorkflowManifest() else { return false }
        return workflow.bindings.allSatisfy { binding in
            targetOptions.contains { $0.deviceID == binding.deviceID && $0.chatID == binding.chatID && $0.online }
        }
    }
    func workflowTargetID(for role: CoordinatorWorkflowRole) -> String? {
        if let saved = defaults.string(forKey: workflowTargetKey + role.rawValue) { return saved }
        return configuration?.workflow?.bindings.first(where: { $0.role == role }).map { "\($0.deviceID):\($0.chatID)" }
    }
    var targetSelectionLabel: String {
        if workflowMode { return "Three-computer workflow" }
        if lockedTargetID != nil && !targetOptions.contains(where: { $0.id == lockedTargetID }) { return "Locked target unavailable" }
        guard let lockedTargetID, let option = targetOptions.first(where: { $0.id == lockedTargetID }) else {
            return "All computers"
        }
        return "\(option.deviceName) — \(option.chatName)"
    }
    var transcriptionHostLabel: String {
        guard let configuration else { return "Transcription host unavailable" }
        return targetOptions.first(where: { $0.deviceID == configuration.transcriptionDeviceID })?.deviceName ?? configuration.transcriptionDeviceID
    }

    /// This is a UI dismissal, never a server cancellation, decline, or resend.
    func dismissRecovery() {
        invalidateWork()
        errorMessage = nil
        recoveryDismissed = true
        defaults.set(true, forKey: dismissedKey)
        if !hasPendingTask && !hasPreparedIdentity && !hasApprovalAttempt { text = ""; status = "Ready." }
    }

    func showRecovery() {
        recoveryDismissed = false
        defaults.set(false, forKey: dismissedKey)
    }

    func refreshTargetCatalog() async {
        guard let configuration, hasCredential, !targetCatalogLoading else { return }
        targetCatalogLoading = true
        targetCatalogError = nil
        defer { targetCatalogLoading = false }
        do {
            let client = try makeClient(configuration)
            async let devices = client.devices()
            async let chats = client.chats()
            let (freshDevices, freshChats) = try await (devices, chats)
            guard Set(freshDevices.map(\.id)).count == freshDevices.count,
                  Set(freshChats.map(\.id)).count == freshChats.count else {
                throw MacControlError.message("Device information changed. Refresh devices and try again.")
            }
            let options = freshChats.map { chat -> WatchTargetOption in
                guard let device = freshDevices.first(where: { $0.id == chat.deviceID }) else {
                    // Conversation history can outlive a registered computer.
                    // Keep that exact identity unavailable; it must not disable
                    // unrelated online computers or become a fallback target.
                    return WatchTargetOption(id: "\(chat.deviceID):\(chat.id)", deviceID: chat.deviceID,
                        chatID: chat.id, deviceName: configuration.deviceAliasesByID[chat.deviceID] ?? "Unavailable computer",
                        chatName: chat.name.isEmpty ? chat.id : chat.name, online: false)
                }
                let deviceName = configuration.deviceAliasesByID[device.id]?.trimmingCharacters(in: .whitespacesAndNewlines)
                return WatchTargetOption(id: "\(device.id):\(chat.id)", deviceID: device.id, chatID: chat.id,
                    deviceName: deviceName?.isEmpty == false ? deviceName! : (device.name.isEmpty ? device.id : device.name),
                    chatName: chat.name.isEmpty ? chat.id : chat.name, online: device.online && chat.online)
            }.sorted { $0.id < $1.id }
            targetOptions = options
        } catch { targetCatalogError = safeMessage(error) }
    }

    func selectVoiceTarget() {
        lockedTargetID = nil; defaults.removeObject(forKey: lockedTargetKey)
        workflowMode = false; defaults.set(false, forKey: workflowModeKey)
    }

    func setWorkflowTarget(_ option: WatchTargetOption, for role: CoordinatorWorkflowRole) {
        guard canEditWorkflow, targetOptions.contains(option), option.online else { workflowSelectionError = "Choose an online exact computer and conversation."; return }
        defaults.set(option.id, forKey: workflowTargetKey + role.rawValue)
        workflowSelectionError = nil
    }

    @discardableResult
    func selectWorkflowMode() -> Bool {
        guard canSelectWorkflow, let manifest = selectedWorkflowManifest() else {
            workflowSelectionError = "Choose three distinct online computers and conversations for the workflow."; return false
        }
        guard manifest.bindings.allSatisfy({ binding in targetOptions.contains(where: { $0.deviceID == binding.deviceID && $0.chatID == binding.chatID && $0.online }) }) else {
            workflowSelectionError = "Refresh and choose three online workflow targets."; return false
        }
        workflowMode = true; defaults.set(true, forKey: workflowModeKey); lockedTargetID = nil; defaults.removeObject(forKey: lockedTargetKey); workflowSelectionError = nil
        return true
    }

    func selectLockedTarget(_ option: WatchTargetOption) {
        // Preserve even a now-unavailable explicit choice. Only an explicit
        // return to voice selection may release this lock.
        lockedTargetID = option.id
        workflowMode = false; defaults.set(false, forKey: workflowModeKey)
        defaults.set(option.id, forKey: lockedTargetKey)
        guard targetOptions.contains(option), option.online else {
            targetCatalogError = "That computer or conversation is offline. Choose an online exact target."
            return
        }
        targetCatalogError = nil
    }

    @discardableResult
    func beginVoiceCapture() -> Bool {
        guard let configuration, active, !busy, hasCredential, !hasPreparedIdentity, !hasApprovalAttempt,
              (!hasPendingTask || isFinished) else {
            errorMessage = "Finish or review the saved request before recording another."; return false
        }
        if loadFrozenVoiceCapture() != nil { return true }
        // Voice selection is resolved from fresh inventory after transcription.
        // The optional picker catalog is not a prerequisite for recording; an
        // explicit lock/workflow still requires its verified exact selection.
        guard targetCatalogError == nil || (lockedTargetID == nil && !workflowMode) else {
            errorMessage = "Refresh computers before recording with this selection."; return false
        }
        guard !workflowMode || lockedTargetID == nil else {
            errorMessage = "Choose either one locked computer or the workflow before recording."; return false
        }
        let locked = lockedTargetID.flatMap { id in targetOptions.first(where: { $0.id == id }) }
        let prospectiveWorkflow = selectedWorkflowManifest()
        let workflow = workflowMode ? prospectiveWorkflow : nil
        guard !workflowMode || workflow != nil else { errorMessage = "Choose three distinct workflow targets before recording."; return false }
        guard lockedTargetID == nil || (locked?.online == true) else {
            errorMessage = "Choose an online computer and conversation before recording."; return false
        }
        let identity = VoiceCaptureIdentity(actionRequestID: UUID(), transcriptionRequestID: UUID(),
            actionDeviceID: locked?.deviceID ?? configuration.deviceID,
            actionChatID: locked?.chatID ?? configuration.chatID,
            transcriptionDeviceID: configuration.transcriptionDeviceID)
        do {
            defaults.set(try JSONEncoder().encode(FrozenVoiceCapture(identity: identity,
                lockedTargetID: locked?.id, lockedDeviceName: locked?.deviceName,
                defaultDeviceID: configuration.deviceID, defaultChatID: configuration.chatID,
                preferredChatIDsByDevice: configuration.preferredChatIDsByDevice,
                deviceAliasesByID: configuration.deviceAliasesByID,
                iphoneMirroringTarget: configuration.iphoneMirroringTarget, workflow: workflow,
                prospectiveWorkflow: prospectiveWorkflow)), forKey: voiceCaptureKey)
            transcriptionMayHaveStarted = false
            return true
        } catch { errorMessage = "Could not save the recording route. Try again before speaking."; return false }
    }

    func cancelVoiceCapture() {
        // Once transcription begins, its receipt owns the frozen identity and
        // cancellation must leave recovery intact.
        guard !transcriptionMayHaveStarted, !hasPreparedIdentity, !hasApprovalAttempt else { return }
        defaults.removeObject(forKey: voiceCaptureKey)
    }

    @discardableResult
    func submitVoiceRequest(_ reviewedText: String) -> Bool {
        guard active, !busy, !hasPreparedIdentity, !hasApprovalAttempt, (!hasPendingTask || isFinished) else { return false }
        // Finishing direct microphone capture is the user's submission.
        // Offline/unpaired recovery and uncertain outcomes still require explicit
        // retry; this entry point never replaces a saved request's ID or body.
        guard beginVoiceCapture() else { return false }
        if hasPendingTask && isFinished { newRequest(preservingVoiceCapture: true) }
        showRecovery()
        voiceHandoffComplete = false
        text = reviewedText
        if canSend { sendOrRetry() }
        return true
    }

    func pair() {
        guard injectedClient == nil else { return }
        guard let configuration, active, !busy else { return }
        busy = true
        let current = beginWork()
        workTask = Task { [weak self] in
            guard let self else { return }
            defer { finishWork(current) }
            do {
                try await MacControlPairing.exchange(code: pairingCode, configuration: configuration)
                guard isCurrent(current) else { return }
                pairingCode = ""
                hasCredential = true
                status = "Paired on this Watch. Your Mac route is ready to check."
                setupMessage = nil
            } catch { guard isCurrent(current) else { return }; status = safeMessage(error); errorMessage = status }
        }
    }

    func sendOrRetry() {
        guard let configuration, active, !busy else { return }
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { status = "Enter a request first."; return }
        guard !hasPendingTask, !hasApprovalAttempt else { return }
        busy = true
        let current = beginWork()
        workTask = Task { [weak self] in
            guard let self else { return }
            defer { finishWork(current) }
            var postStarted = false
            do {
                let saved = loadPrepared()
                guard !hasPreparedIdentity || saved != nil else {
                    throw MacControlError.message("Your saved request cannot be read. Check it on your Mac before starting again.")
                }
                let client = try makeClient(configuration)
                let capture = loadFrozenVoiceCapture()
                let routingConfiguration = capture.map { self.frozenConfiguration($0, base: configuration) } ?? configuration
                let explicitWorkflow = WatchWorkflowIntent.isExplicit(text)
                let frozenWorkflow: CoordinatorWorkflowManifest?
                if let saved { frozenWorkflow = saved.workflow }
                else { frozenWorkflow = capture?.workflow ?? (explicitWorkflow ? capture?.prospectiveWorkflow : nil) }
                let coordinated = saved.map { $0.coordinated == true } ??
                    (frozenWorkflow != nil || explicitWorkflow || WatchCoordinationIntent.isExplicit(text) ||
                     (routingConfiguration.deviceID == "coordinator" && routingConfiguration.chatID == "master" && capture?.lockedTargetID == nil))
                if saved == nil {
                    guard !(capture?.lockedTargetID != nil && coordinated) else {
                        throw MacControlError.message("The workflow conflicts with your locked computer. Discard the unsent recording and choose the intended mode.")
                    }
                    guard !explicitWorkflow || frozenWorkflow != nil else {
                        throw MacControlError.message("Choose all three workflow conversations before recording this request.")
                    }
                }
                let needsInventory = !coordinated || (frozenWorkflow != nil && saved == nil)
                let devices = needsInventory ? try await client.devices() : []
                let chats = needsInventory ? try await client.chats() : []
                let prepared: MacPreparedRequest
                if let saved {
                    guard (saved.spokenText ?? saved.text) == text else {
                        throw MacControlError.message("Retry keeps the original request and selected device.")
                    }
                    prepared = saved
                } else if coordinated && frozenWorkflow == nil {
                    guard let capture else { throw MacControlError.message("The recording route is missing. Record a new request before sending.") }
                    prepared = MacPreparedRequest(requestID: capture.identity.actionRequestID, text: try VoiceTaskEnvelope.make(text, coordinated: true),
                        chatID: "master", deviceID: "coordinator", transcriptionDeviceID: capture.identity.transcriptionDeviceID,
                        spokenText: text, coordinated: true)
                    selectedDeviceName = "Your computers"
                } else if let workflow = frozenWorkflow {
                    guard let capture else { throw MacControlError.message("The recording route is missing. Record a new request before sending.") }
                    guard workflow.bindings.allSatisfy({ binding in
                        devices.contains(where: { $0.id == binding.deviceID && $0.online }) &&
                        chats.contains(where: { $0.id == binding.chatID && $0.deviceID == binding.deviceID && $0.online })
                    }) else { throw MacControlError.message("A selected workflow computer or conversation is unavailable. Nothing was sent.") }
                    prepared = MacPreparedRequest(requestID: capture.identity.actionRequestID, text: try VoiceTaskEnvelope.make(text, coordinated: true),
                        chatID: "master", deviceID: "coordinator", transcriptionDeviceID: capture.identity.transcriptionDeviceID,
                        spokenText: text, coordinated: true, workflow: workflow)
                    selectedDeviceName = "Three-computer workflow"
                } else {
                    guard let capture else { throw MacControlError.message("The recording route is missing. Record a new request before sending.") }
                    let selection: TaskRouteSelection
                    if capture.lockedTargetID != nil {
                        selection = try TaskRoutePlanner.resolveLocked(text: text,
                            lockedDeviceID: capture.identity.actionDeviceID, lockedChatID: capture.identity.actionChatID,
                            devices: devices, chats: chats, expectedMirroringTarget: routingConfiguration.iphoneMirroringTarget,
                            preferredChatIDsByDevice: routingConfiguration.preferredChatIDsByDevice,
                            deviceAliasesByID: routingConfiguration.deviceAliasesByID)
                    } else {
                        selection = try TaskRoutePlanner.resolve(text: text, devices: devices, chats: chats,
                            defaultDeviceID: capture.identity.actionDeviceID, defaultChatID: capture.identity.actionChatID,
                            expectedMirroringTarget: routingConfiguration.iphoneMirroringTarget,
                            preferredChatIDsByDevice: routingConfiguration.preferredChatIDsByDevice,
                            deviceAliasesByID: routingConfiguration.deviceAliasesByID)
                    }
                    prepared = MacPreparedRequest(requestID: capture.identity.actionRequestID,
                        text: try VoiceTaskEnvelope.make(text, iphoneMirroring: selection.iphoneMirroring),
                        chatID: selection.chatID, deviceID: selection.deviceID,
                        transcriptionDeviceID: capture.identity.transcriptionDeviceID, spokenText: text,
                        iphoneMirroring: selection.iphoneMirroring)
                    selectedDeviceName = selection.deviceName
                }
                if !coordinated && prepared.workflow == nil && !devices.contains(where: { $0.id == prepared.deviceID && $0.online }) {
                    throw MacControlError.message(saved == nil ? "The selected computer is offline. Nothing was sent." :
                        "The selected computer is offline. Your original request is saved; its outcome is not confirmed.")
                }
                let chat = chats.first(where: { $0.id == prepared.chatID && $0.deviceID == prepared.deviceID && $0.online })
                if !coordinated && prepared.workflow == nil && chat == nil {
                    throw MacControlError.message(saved == nil ? "The selected conversation is unavailable. Nothing was sent." :
                        "The selected conversation is unavailable. Your original request is saved.")
                }
                if let route = prepared.iphoneMirroring {
                    guard !coordinated else { throw IPhoneMirroringError.wrongTarget }
                    guard route.target == routingConfiguration.iphoneMirroringTarget,
                          route.target.deviceID == prepared.deviceID, route.target.chatID == prepared.chatID else {
                        throw IPhoneMirroringError.wrongTarget
                    }
                    // Let an uncertain retry reach UUID reconciliation even
                    // when its original admission lease has since expired.
                    if saved == nil { try IPhoneMirroringPreflight.revalidate(route, devices: devices, chats: chats) }
                }
                if (coordinated || prepared.workflow != nil) && (prepared.chatID != "master" || prepared.deviceID != "coordinator" || prepared.iphoneMirroring != nil) {
                    throw MacControlError.message("The saved coordination route changed. Review it in Providence on your Mac.")
                }
                guard isCurrent(current) else { return }
                if saved == nil { try savePrepared(prepared); defaults.removeObject(forKey: voiceCaptureKey) }
                voiceHandoffComplete = true
                defaults.set(try JSONEncoder().encode(prepared), forKey: selectedRouteKey)
                guard isCurrent(current) else { return }
                status = "Working on \(selectedDeviceName.isEmpty ? prepared.deviceID : selectedDeviceName)…"
                postStarted = true
                let received: CoordinatorTask
                if coordinated || prepared.workflow != nil {
                    received = try await client.submit(MessageSubmission(requestID: prepared.requestID, text: prepared.text, workflow: prepared.workflow))
                    guard received.chatID == "master", received.deviceID == "coordinator", received.executionTarget == nil else {
                        throw CoordinatorClientError.responseTargetMismatch(taskID: received.id,
                            expectedChatID: "master", expectedDeviceID: "coordinator")
                    }
                    if let workflow = prepared.workflow, received.workflow != workflow { throw MacControlError.message("The coordinator returned a different workflow. Keep this request for recovery.") }
                } else {
                    guard let chat else { throw MacControlError.message("The selected conversation is unavailable.") }
                    received = try await client.submit(DirectMessageSubmission(requestID: prepared.requestID,
                        text: prepared.text, chat: chat, expectedDeviceID: prepared.deviceID,
                        executionTarget: try executionTarget(for: prepared)))
                }
                guard isCurrent(current) else { return }
                guard received.requestID == prepared.requestID.uuidString.lowercased() else {
                    throw MacControlError.message("The computer returned a different request. Keep this request for recovery.")
                }
                task = received
                defaults.set(received.id, forKey: taskKey)
                defaults.removeObject(forKey: preparedKey)
                if prepared.workflow != nil {
                    workflowMode = false; defaults.set(false, forKey: workflowModeKey)
                }
                try await acceptTask(received, client: client, generation: current)
            } catch {
                guard isCurrent(current) else { return }
                if case let CoordinatorClientError.requestNotAccepted(requestID, _, _) = error,
                   postStarted, defaults.string(forKey: taskKey) == nil,
                   loadPrepared()?.requestID == requestID {
                    // Only exact authenticated pre-admission rejection proves
                    // this UUID created no worker task after a POST attempt.
                    defaults.removeObject(forKey: preparedKey)
                    defaults.removeObject(forKey: selectedRouteKey)
                    postStarted = false
                }
                if defaults.string(forKey: taskKey) != nil {
                    status = "Request saved. \(safeMessage(error))"
                } else if postStarted || hasPreparedIdentity {
                    status = "Outcome unknown. \(safeMessage(error))"
                } else {
                    status = "Nothing submitted. \(safeMessage(error))"
                }
                errorMessage = status
                // Until the prepared body is durable, the transcription
                // receipt remains the only saved copy of these spoken words.
            }
        }
    }

    func refresh() {
        guard let configuration, active, !busy else { return }
        guard let id = task?.id ?? defaults.string(forKey: taskKey) else { return }
        terminalReconciled = false
        pendingApproval = nil
        busy = true
        let current = beginWork()
        workTask = Task { [weak self] in
            guard let self else { return }
            defer { finishWork(current) }
            do {
                let client = try makeClient(configuration)
                let received = try await client.task(id: id)
                guard isCurrent(current) else { return }
                guard matchesSelectedTask(received, id: id) else {
                    throw MacControlError.message("The returned task does not belong to your configured Mac route.")
                }
                if selectedRoute != nil { voiceHandoffComplete = true }
                try await acceptTask(received, client: client, generation: current)
            } catch { guard isCurrent(current) else { return }; status = safeMessage(error); errorMessage = status }
        }
    }

    func resolve(_ displayed: CoordinatorApproval, _ decision: ApprovalDecision) {
        guard MacControlContracts.isBasicApproval(displayed) else { return }
        resolve(displayed, resolution: .decision(decision))
    }

    func answer(_ displayed: CoordinatorApproval, option: String) {
        guard let question = MacControlContracts.decisionQuestion(displayed), question.options.contains(option) else { return }
        resolve(displayed, resolution: .answers([question.id: ApprovalAnswer([option])]))
    }

    private func resolve(_ displayed: CoordinatorApproval, resolution: ApprovalResolution) {
        guard let configuration, let root = task, result?.status == .needsInput,
              let displayedOwner = result?.tasks.first(where: { $0.id == displayed.taskID }),
              pendingApproval == displayed, !hasApprovalAttempt, active, !busy else { return }
        busy = true
        let currentGeneration = beginWork()
        workTask = Task { [weak self] in
            guard let self else { return }
            defer { finishWork(currentGeneration) }
            do {
                let client = try makeClient(configuration)
                let freshRoot = try await client.task(id: root.id)
                guard matchesSelectedTask(freshRoot, id: root.id) else {
                    throw MacControlError.message("That task changed. Check its latest status.")
                }
                let snapshot = try await TaskResultResolver.resolve(root: freshRoot) { id in try await client.task(id: id) }
                guard snapshot.status == .needsInput else { throw MacControlError.message("That decision is no longer pending.") }
                guard let freshTask = snapshot.tasks.first(where: {
                    $0.id == displayedOwner.id && $0.requestID == displayedOwner.requestID &&
                    $0.deviceID == displayedOwner.deviceID && $0.chatID == displayedOwner.chatID && $0.status == .needsInput
                }) else {
                    throw MacControlError.message("That approval no longer belongs to this request.")
                }
                guard let states = freshTask.approvalStates else {
                    throw MacControlError.message("Review this decision on your Mac. Update Providence there to enable safe Watch decisions.")
                }
                guard states.contains(where: { $0.id == displayed.id && $0.method == displayed.method && $0.status == "pending" }) else {
                    throw MacControlError.message("That decision changed. Check its latest status.")
                }
                let expected = ProvidenceCoordinatorConfiguration(baseURL: configuration.baseURL, deviceID: freshTask.deviceID, chatID: freshTask.chatID)
                let briefing = try await client.briefing()
                guard let approval = briefing.approvals.first(where: { MacControlContracts.matchesDisplayedApproval($0, displayed: displayed, task: freshTask, configuration: expected) && MacControlContracts.isSupportedApproval($0) }) else {
                    throw MacControlError.message("That approval is no longer available. Refresh the task in Providence.")
                }
                guard isCurrent(currentGeneration) else { return }
                // Persist before crossing the POST boundary. A lost acknowledgement
                // must never make this same decision actionable again.
                let attempt = WatchApprovalAttempt(root: freshRoot, owner: freshTask, approval: approval)
                defaults.set(try JSONEncoder().encode(attempt), forKey: approvalAttemptKey)
                pendingApproval = nil
                approvalRecoveryMessage = "Checking your decision. It will not be submitted again."
                let acknowledgement = try await client.resolveApproval(approval, for: freshTask, with: resolution)
                guard isCurrent(currentGeneration) else { return }
                guard acknowledgement.resolved else {
                    throw MacControlError.message("Your decision was not acknowledged. Check status before continuing.")
                }
                // Even an HTTP acknowledgement must not re-enable the same
                // choice while a task read still lags behind. Reconcile its
                // exact structured state before releasing this receipt.
                approvalRecoveryMessage = "Decision accepted. Checking the task outcome."
                pendingApproval = nil
                let refreshed = try await client.task(id: freshRoot.id)
                guard isCurrent(currentGeneration) else { return }
                guard matchesSelectedTask(refreshed, id: root.id) else {
                    throw MacControlError.message("The returned task does not belong to your configured Mac route.")
                }
                try await acceptTask(refreshed, client: client, generation: currentGeneration)
            } catch {
                guard isCurrent(currentGeneration) else { return }
                pendingApproval = nil
                status = safeMessage(error); errorMessage = status
            }
        }
    }

    func sceneChanged(_ phase: ScenePhase) {
        active = phase == .active
        if active {
            if injectedClient == nil { hasCredential = (try? MacControlKeychain.readToken()) != nil }
            // A dismissed request stays on the neutral goose after reopen.
            // Checking it is explicit and always uses its saved identity.
            if !recoveryDismissed { refresh() }
        }
        else { invalidateWork() }
    }

    func stoppedDisplaying() { active = false; invalidateWork() }

    func newRequest(preservingVoiceCapture: Bool = false) {
        guard active, canStartNewRequest else { return }
        invalidateWork()
        showRecovery()
        defaults.removeObject(forKey: taskKey)
        defaults.removeObject(forKey: selectedRouteKey)
        if !preservingVoiceCapture {
            defaults.removeObject(forKey: voiceCaptureKey)
            transcriptionMayHaveStarted = false
        }
        task = nil; result = nil; pendingApproval = nil; approvalRecoveryMessage = nil
        terminalReconciled = false
        text = ""; errorMessage = nil; status = "Ready."
    }

    private func makeClient(_ configuration: ProvidenceCoordinatorConfiguration) throws -> CoordinatorClient {
        if let injectedClient { return injectedClient }
        return try CoordinatorClient(baseURL: configuration.baseURL, tokenProvider: ClosureBearerTokenProvider {
            guard let token = try MacControlKeychain.readToken() else {
                throw MacControlError.message("Pair this Watch with a one-use client code before sending to your Mac.")
            }
            return token
        })
    }

    var isFinished: Bool { result?.status.isTerminal == true && terminalReconciled && !hasApprovalAttempt && approvalRecoveryMessage == nil }

    private func matchesSelectedTask(_ value: CoordinatorTask, id: String) -> Bool {
        let selected = selectedRoute
        guard (defaults.object(forKey: selectedRouteKey) == nil || selected != nil) &&
            value.id == id && value.chatID == taskConfiguration?.chatID && value.deviceID == taskConfiguration?.deviceID &&
            (selected == nil || value.requestID == selected?.requestID.uuidString.lowercased()) else { return false }
        do { return value.executionTarget == (try selected.flatMap { try executionTarget(for: $0) }) }
        catch { return false }
    }

    private func executionTarget(for prepared: MacPreparedRequest) throws -> IPhoneMirroringExecutionTarget? {
        guard let route = prepared.iphoneMirroring else { return nil }
        guard let action = IPhoneMirroringAction(rawValue: route.action) else { throw IPhoneMirroringError.invalidEvidence }
        return try IPhoneMirroringExecutionTarget(deviceID: route.target.deviceID, chatID: route.target.chatID,
            phoneID: route.target.phoneID, phoneName: route.target.phoneName, leaseID: route.sessionID, action: action)
    }

    private var selectedRoute: MacPreparedRequest? {
        guard let data = defaults.data(forKey: selectedRouteKey) else { return nil }
        return try? JSONDecoder().decode(MacPreparedRequest.self, from: data)
    }

    private var taskConfiguration: ProvidenceCoordinatorConfiguration? {
        guard let configuration else { return nil }
        guard let selected = selectedRoute else { return configuration }
        return ProvidenceCoordinatorConfiguration(baseURL: configuration.baseURL, deviceID: selected.deviceID, chatID: selected.chatID)
    }

    /// Transcription is separate from task execution. Cancelling it cannot run a task.
    func transcribe(_ audio: Data, session: VoiceTranscriptionSession, purpose: String) async throws -> String {
        guard let configuration, hasCredential else { throw MacControlError.message("Pair your Watch first.") }
        if purpose == "legacy" {
            do {
                return try await session.transcribe(audio: audio, client: makeClient(configuration),
                    preferredDeviceID: configuration.transcriptionDeviceID, purpose: purpose)
            } catch { throw MacControlError.message(safeMessage(error)) }
        }
        guard beginVoiceCapture(), let capture = loadFrozenVoiceCapture() else {
            throw MacControlError.message("Choose a valid computer route before recording.")
        }
        transcriptionMayHaveStarted = true
        do {
            return try await session.transcribe(audio: audio, client: makeClient(configuration),
                preferredDeviceID: capture.identity.transcriptionDeviceID, captureIdentity: capture.identity, purpose: purpose)
        } catch {
            // A rejected availability check has no upload to reconcile. Only
            // release our exact unsent capture when the session confirms that
            // no operation or recovery receipt owns it.
            if session.canStartNewRecording, loadFrozenVoiceCapture()?.identity == capture.identity,
               !hasPreparedIdentity, !hasApprovalAttempt,
               selectedRoute?.requestID != capture.identity.actionRequestID {
                transcriptionMayHaveStarted = false
                defaults.removeObject(forKey: voiceCaptureKey)
            }
            throw MacControlError.message(safeMessage(error))
        }
    }

    func recoverTranscription(_ session: VoiceTranscriptionSession) async throws -> String {
        guard let configuration, hasCredential else { throw MacControlError.message("Pair your Watch first.") }
        if session.recoveryPurpose == "legacy" {
            do { return try await session.recover(client: makeClient(configuration)) }
            catch { throw MacControlError.message(safeMessage(error)) }
        }
        guard let capture = loadFrozenVoiceCapture(), session.recoveredCaptureIdentity == capture.identity else {
            throw MacControlError.message("This saved recording has no verified route. Review it on the computer before recording a new request.")
        }
        transcriptionMayHaveStarted = true
        do { return try await session.recover(client: makeClient(configuration)) }
        catch { throw MacControlError.message(safeMessage(error)) }
    }

    func canDiscardUnsubmittedRecording(_ session: VoiceTranscriptionSession) -> Bool {
        guard active, !busy, !hasPreparedIdentity, !hasApprovalAttempt, (!hasPendingTask || isFinished),
              let capture = loadFrozenVoiceCapture(), session.recoveryPurpose == "task",
              session.hasCompletedTranscript, session.recoveredCaptureIdentity == capture.identity else { return false }
        if let task {
            guard let previousRequestID = UUID(uuidString: task.requestID),
                  previousRequestID != capture.identity.actionRequestID else { return false }
        }
        guard selectedRoute?.requestID != capture.identity.actionRequestID else { return false }
        return true
    }

    @discardableResult
    func discardUnsubmittedRecording(_ session: VoiceTranscriptionSession) -> Bool {
        guard canDiscardUnsubmittedRecording(session), let capture = loadFrozenVoiceCapture(),
              session.discardCompletedTask(captureIdentity: capture.identity) else { return false }
        defaults.removeObject(forKey: voiceCaptureKey)
        transcriptionMayHaveStarted = false
        text = ""
        errorMessage = nil
        if !hasPendingTask { status = "Ready." }
        return true
    }

    private func loadPrepared() -> MacPreparedRequest? {
        guard let data = defaults.data(forKey: preparedKey) else { return nil }
        return try? JSONDecoder().decode(MacPreparedRequest.self, from: data)
    }

    private func loadFrozenVoiceCapture() -> FrozenVoiceCapture? {
        guard let data = defaults.data(forKey: voiceCaptureKey) else { return nil }
        return try? JSONDecoder().decode(FrozenVoiceCapture.self, from: data)
    }

    private func frozenConfiguration(_ capture: FrozenVoiceCapture, base: ProvidenceCoordinatorConfiguration) -> ProvidenceCoordinatorConfiguration {
        ProvidenceCoordinatorConfiguration(baseURL: base.baseURL, deviceID: capture.defaultDeviceID, chatID: capture.defaultChatID,
            iphoneMirroringTarget: capture.iphoneMirroringTarget, preferredChatIDsByDevice: capture.preferredChatIDsByDevice,
            deviceAliasesByID: capture.deviceAliasesByID, transcriptionDeviceID: capture.identity.transcriptionDeviceID,
            workflow: capture.workflow)
    }

    private func selectedWorkflowManifest() -> CoordinatorWorkflowManifest? {
        guard let bindings = try? CoordinatorWorkflowRole.allCases.map({ role -> CoordinatorWorkflowBinding in
            guard let id = workflowTargetID(for: role) else { throw CoordinatorWorkflowError.invalidManifest }
            let parts = id.split(separator: ":", omittingEmptySubsequences: false)
            guard parts.count == 2 else { throw CoordinatorWorkflowError.invalidManifest }
            return try CoordinatorWorkflowBinding(role: role, deviceID: String(parts[0]), chatID: String(parts[1]))
        }) else { return nil }
        return try? CoordinatorWorkflowManifest(bindings: bindings)
    }

    private func savePrepared(_ request: MacPreparedRequest) throws {
        defaults.set(try JSONEncoder().encode(request), forKey: preparedKey)
    }

    private func acceptTask(_ received: CoordinatorTask, client: CoordinatorClient, generation: UUID) async throws {
        // Never publish a playable/replaceable terminal result before all linked
        // tasks AND exact-task approval records have been reconciled.
        terminalReconciled = false
        result = nil
        pendingApproval = nil
        approvalRecoveryMessage = nil
        task = received
        let snapshot = try await TaskResultResolver.resolve(root: received, expectedWorkflow: selectedRoute?.workflow) { id in try await client.task(id: id) }
        guard isCurrent(generation) else { return }
        if snapshot.status == .needsInput || snapshot.status.isTerminal || hasApprovalAttempt {
            try await refreshApproval(client: client, family: snapshot.tasks, generation: generation)
            guard isCurrent(generation) else { return }
        }
        result = snapshot
        if approvalRecoveryMessage == nil {
            status = pendingApproval == nil ? snapshot.spokenText : "Your request needs a decision."
        } else { status = approvalRecoveryMessage! }
        terminalReconciled = snapshot.status.isTerminal && pendingApproval == nil && approvalRecoveryMessage == nil && !hasApprovalAttempt
        if isFinished { pollTask?.cancel() }
        else { schedulePollIfNeeded() }
    }

    private func refreshApproval(client: CoordinatorClient, family: [CoordinatorTask], generation: UUID) async throws {
        guard let configuration else { return }
        pendingApproval = nil
        // Exact task states are authoritative for a submitted decision. Read
        // them before a secondary briefing fetch can fail or add latency.
        if hasApprovalAttempt {
            guard let data = defaults.data(forKey: approvalAttemptKey),
                  let attempt = try? JSONDecoder().decode(WatchApprovalAttempt.self, from: data),
                  let root = task,
                  let owner = family.first(where: { $0.id == attempt.taskID }),
                  attempt.matches(root: root, owner: owner),
                  let state = owner.approvalStates?.first(where: { $0.id == attempt.approvalID && $0.method == attempt.method }),
                  ["resolved", "expired"].contains(state.status) else {
                approvalRecoveryMessage = "Decision outcome unknown. Check status or review it on your Mac. Do not send it again."
                return
            }
            defaults.removeObject(forKey: approvalAttemptKey)
        }
        for candidate in family {
            if candidate.approvalStates?.contains(where: { $0.status == "resolving" || !["pending", "resolved", "expired"].contains($0.status) }) == true {
                approvalRecoveryMessage = "Your decision is still being checked. Do not send it again."
                return
            }
            if candidate.status != .needsInput && candidate.approvalStates?.contains(where: { $0.status == "pending" }) == true {
                approvalRecoveryMessage = "The task and its approval disagree. Check status or review it on your Mac."
                return
            }
        }
        let needsDecision = family.contains(where: { $0.status == .needsInput || $0.workStatus == .needsInput })
        if !needsDecision && family.allSatisfy({ $0.approvalStates != nil }) { return }
        let briefing = try await client.briefing()
        guard isCurrent(generation) else { return }
        for candidate in family {
            // A pending record on a completed task is a server mismatch, never
            // permission to approve stale work or to replace this request.
            let records = briefing.approvals.filter {
                $0.taskID == candidate.id && $0.deviceID == candidate.deviceID && ["pending", "resolving"].contains($0.status)
            }
            if records.contains(where: { $0.status == "resolving" }) {
                approvalRecoveryMessage = "Your decision is still being checked. Do not send it again."
                return
            }
            let declaredPending = candidate.approvalStates?.contains(where: { $0.status == "pending" }) == true
            if (!records.isEmpty || declaredPending) && candidate.status != .needsInput {
                approvalRecoveryMessage = "The task and its approval disagree. Check status or review it on your Mac."
                return
            }
            if let states = candidate.approvalStates, records.contains(where: { record in
                !states.contains(where: { $0.id == record.id && $0.method == record.method && $0.status == "pending" })
            }) {
                approvalRecoveryMessage = "The approval changed. Check its latest status before deciding."
                return
            }
            if !records.isEmpty && candidate.approvalStates == nil {
                approvalRecoveryMessage = "Review this decision on your Mac. Update Providence there to enable safe Watch decisions."
                return
            }
            let expected = ProvidenceCoordinatorConfiguration(baseURL: configuration.baseURL, deviceID: candidate.deviceID, chatID: candidate.chatID)
            if let approval = records.first(where: {
                MacControlContracts.matchesDisplayedApproval($0, displayed: $0, task: candidate, configuration: expected) && MacControlContracts.isSupportedApproval($0)
            }) { pendingApproval = approval; return }
        }
        if family.contains(where: { $0.status == .needsInput || $0.workStatus == .needsInput }) {
            approvalRecoveryMessage = "Open Providence on your Mac to respond. You can check again here."
        }
    }

    private func schedulePollIfNeeded() {
        guard active, hasCredential, let task, !isFinished, !recoveryDismissed else { return }
        if pollingTaskID != task.id {
            pollingTaskID = task.id
            pollingStartedAt = Date()
        }
        // Avoid adding an eight-second observation delay to short actions.
        // Longer jobs and user decisions back off without replaying work.
        let elapsed = pollingStartedAt.map { Date().timeIntervalSince($0) } ?? 0
        let seconds = pendingApproval != nil || approvalRecoveryMessage != nil || elapsed >= 30 ? 3 : 1
        pollTask?.cancel()
        pollTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(seconds))
            guard !Task.isCancelled else { return }
            guard self?.active == true else { return }
            self?.refresh()
        }
    }

    func approvalDetails(_ approval: CoordinatorApproval) -> String {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        guard let data = try? encoder.encode(approval.details), let text = String(data: data, encoding: .utf8) else { return "Unavailable" }
        return "Device: \(approval.deviceID)\n" + text
    }

    func approvalTitle(_ approval: CoordinatorApproval) -> String {
        switch approval.method {
        case "item/commandExecution/requestApproval": return "Allow this command?"
        case "item/fileChange/requestApproval": return "Allow these file changes?"
        default: return "Approval needed"
        }
    }

    private func safeMessage(_ error: Error) -> String {
        lastDiagnostic = String(reflecting: error)
        diagnostics.error("Watch request failed: \(String(reflecting: error), privacy: .private)")
        if let coordinatorError = error as? CoordinatorClientError,
           case let .unexpectedStatus(code, _) = coordinatorError, code == 401 {
            if injectedClient == nil { MacControlKeychain.clearRejectedToken() }
            hasCredential = false
        }
        return WatchRecoveryPresentation.message(for: error)
    }

    private func beginWork() -> UUID {
        errorMessage = nil
        showRecovery()
        pollTask?.cancel(); pollTask = nil
        let next = UUID(); generation = next; return next
    }
    private func isCurrent(_ value: UUID) -> Bool { active && generation == value && !Task.isCancelled }
    private func finishWork(_ value: UUID) { if generation == value { busy = false; workTask = nil } }
    private func invalidateWork() { generation = UUID(); pollTask?.cancel(); pollTask = nil; workTask?.cancel(); workTask = nil; busy = false }
}
