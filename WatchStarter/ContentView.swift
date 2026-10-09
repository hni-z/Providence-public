import SwiftUI
import WatchKit

struct ContentView: View {
    @StateObject private var model = AssistantModel()
    @StateObject private var mac: MacControlModel
    @State private var dismissedCaptureError: String?
    @State private var recordingRecoveryError: String?
    @State private var targetSheet: TargetSheet?
    @State private var taskRecordingFrozen = false
    @State private var transcriptionStarted = false
    @State private var reviewAfterOptions = false

    private enum TargetSheet: String, Identifiable {
        case options, computer
        var id: String { rawValue }
    }

    init() {
        #if DEBUG
        _mac = StateObject(wrappedValue: ProvidenceRehearsal.requested ? WatchRecoveryFixtures.silentRehearsalModel() : (WatchRecoveryFixtures.modelFromArguments() ?? MacControlModel()))
        #else
        _mac = StateObject(wrappedValue: MacControlModel())
        #endif
    }
    @StateObject private var dictation = NativeDictation()
    @StateObject private var capture = VoiceCapture()
    @StateObject private var voiceSession = VoiceTranscriptionSession()
    @State private var recoveryTask: Task<Void, Never>?
    @State private var recovering = false
    @State private var recoveredLegacyText: String?
    @AppStorage("voice.activeRoute") private var routeName = ""
    @AppStorage("voice.waitingTranscript") private var transcript = ""
    @State private var showingReview = false
    @State private var dismissReviewToGoose = true
    @State private var gooseInteraction = GooseInteraction()
    @State private var showingLegacyEmail = false
    @State private var successResting = false
    @Environment(\.scenePhase) private var scenePhase
    #if DEBUG
    @State private var gestureProof = "idle"
    @StateObject private var rehearsal = ProvidenceRehearsal()
    #endif

    private var isRehearsal: Bool {
        #if DEBUG
        ProvidenceRehearsal.requested
        #else
        false
        #endif
    }

    private var isRecoveryPreview: Bool {
        #if DEBUG
        ProcessInfo.processInfo.arguments.contains { $0.hasPrefix("--preview-watch-recovery=") }
        #else
        false
        #endif
    }

    private var isPlaybackPreview: Bool {
        #if DEBUG
        // With no bundled coordinator config, speakReply takes the real local
        // Apple fallback before reading credentials or contacting a provider.
        ProcessInfo.processInfo.arguments.contains("--allow-preview-audio") &&
        ProcessInfo.processInfo.arguments.contains("--preview-watch-recovery=playback") &&
        Bundle.main.url(forResource: "ProvidenceCoordinatorConfig", withExtension: "json") == nil
        #else
        false
        #endif
    }

    private var isUIPreview: Bool {
        #if DEBUG
        ProvidenceRehearsal.requested ||
        ProcessInfo.processInfo.arguments.contains("--preview-voice-idle") ||
        ProcessInfo.processInfo.arguments.contains("--preview-apple-fallback") ||
        ProcessInfo.processInfo.arguments.contains("--preview-goose-gestures") ||
        ProcessInfo.processInfo.arguments.contains { $0.hasPrefix("--preview-goose-state=") }
        #else
        false
        #endif
    }

    var body: some View {
        NavigationStack {
            ZStack {
                ProvidencePalette.graphite.ignoresSafeArea()
                if !mac.hasCredential && !isUIPreview && !mac.recoveryDismissed { pairing }
                else if showingLegacyEmail && capture.phase == .idle {
                    ScrollView { VStack(spacing: 10) { emailFlow }.padding(8) }
                } else { voiceSurface }
            }
            .toolbar(.hidden, for: .navigationBar)
        }
        .tint(ProvidencePalette.accent)
        .onAppear {
            dictation.directInput = { completion in beginCapture(purpose: "legacy", completion) }
            #if DEBUG
            if ProcessInfo.processInfo.arguments.contains("--preview-apple-fallback") { dictation.previewAppleFallback() }
            if ProcessInfo.processInfo.arguments.contains(where: { $0.hasPrefix("--preview-watch-recovery=targets") }) {
                targetSheet = .computer
            } else if isRecoveryPreview && !mac.recoveryDismissed { mac.refresh() }
            #endif
        }
        .task {
            guard mac.hasCredential, !isUIPreview else { return }
            await mac.refreshTargetCatalog()
        }
        .onDisappear { gooseInteraction.cancel(); cancelCurrentCapture() }
        #if DEBUG
        .task {
            if isRehearsal && ProcessInfo.processInfo.arguments.contains("--preview-integrated-flow") {
                await rehearsal.run()
            }
        }
        .onChange(of: rehearsal.reviewPresented) { _, presented in
            guard isRehearsal else { return }
            if !presented { dismissReviewToGoose = false }
            showingReview = presented
        }
        #endif
        .task(id: settledResultID) {
            successResting = false
            guard settledResultID != nil else { return }
            do { try await Task.sleep(for: .seconds(3)) } catch { return }
            // Decorative settling only: keep the verified result for replay.
            successResting = true
        }
        .onChange(of: scenePhase, initial: true) { _, phase in
            guard !isUIPreview && !isRecoveryPreview else { return }
            if phase != .active { recoveryTask?.cancel(); recovering = false; gooseInteraction.cancel() }
            let wasRecording = capture.phase == .recording
            capture.sceneChanged(phase)
            if phase == .background || (phase != .active && wasRecording) { clearUnsubmittedCaptureSelection() }
            if phase == .inactive && wasRecording { dictation.cancelInput() }
            dictation.sceneChanged(phase)
            model.sceneChanged(phase)
            mac.sceneChanged(phase)
            if phase == .active {
                // Preserve recoverable legacy drafts, including uncertain sends.
                dispatchConfirmedDictation()
            }
        }
        .onChange(of: mac.busy) { _, busy in
            if !busy { dispatchConfirmedDictation() }
        }
        .onChange(of: capture.phase) { _, phase in
            dictation.setMicrophoneActive(phase != .idle)
        }
        .onChange(of: mac.task?.id) { _, id in dictation.taskChanged(id) }
        .onChange(of: mac.pendingApproval?.id) { _, id in
            if id != nil && !isUIPreview && !mac.recoveryDismissed { openReview() }
        }
        .onChange(of: mac.result?.spokenText) { _, text in
            let context = mac.task.flatMap { task in text.map { VoiceReplyContext(taskID: task.id, text: $0) } }
            dictation.replyChanged(context)
        }
        .onChange(of: mac.result?.status) { _, state in
            if state != .completed || !mac.canPlayResult { dictation.stopReply() }
        }
        .onChange(of: mac.voiceHandoffComplete) { _, complete in
            if complete && voiceSession.recoveryPurpose == "task" { voiceSession.consume() }
        }
        .onChange(of: capture.errorMessage) { _, message in
            if message != nil {
                clearUnsubmittedCaptureSelection()
                dismissedCaptureError = nil
                dictation.setMicrophoneActive(false)
                dictation.cancelInput()
            }
        }
        .onChange(of: mac.result?.status) { _, status in
            if status == .completed && mac.canPlayResult {
                WKInterfaceDevice.current().play(.notification)
                if isPlaybackPreview { openReview() }
            }
        }
        .sheet(isPresented: $showingReview, onDismiss: {
            if dismissReviewToGoose { dismissRecovery() }
            dismissReviewToGoose = true
        }) {
            ScrollView {
                VStack(spacing: 10) {
                    HStack(spacing: 6) {
                        Button("Back to Providence", systemImage: "chevron.left") {
                            dismissRecovery(); showingReview = false
                        }.font(.caption2).accessibilityIdentifier("back-to-goose")
                        ProvidenceGooseScene(stage: flowStage, level: 0, pressed: false,
                            reducedMotion: displayReducedMotion, active: scenePhase == .active)
                            .frame(width: 38, height: 38)
                    }
                    if mac.busy { ProgressView().accessibilityLabel("Checking request") }
                    if isRehearsal {
                        #if DEBUG
                        rehearsalReview
                        #endif
                    } else if let recoveredLegacyText {
                        Text(recoveredLegacyText).font(.caption)
                        Button("Return to draft") {
                            voiceSession.consume(); self.recoveredLegacyText = nil
                            dismissReviewToGoose = false
                            showingReview = false; showingLegacyEmail = true
                        }
                    } else if let approval = mac.pendingApproval {
                        if let question = MacControlContracts.decisionQuestion(approval) {
                            decisionQuestionView(question.question, options: question.options, busy: mac.busy) {
                                mac.answer(approval, option: $0)
                            }
                        } else {
                            Text(mac.approvalTitle(approval)).font(.headline)
                            Text(mac.approvalDetails(approval)).font(.caption2)
                            Button("Allow") { mac.resolve(approval, .accept) }.tint(.gray).disabled(mac.busy)
                            Button("Decline") { mac.resolve(approval, .decline) }.disabled(mac.busy)
                        }
                    } else {
                        if let target = executionTargetLabel {
                            Text("On \(target)").font(.caption2).foregroundStyle(Color(white: 0.78))
                                .fixedSize(horizontal: false, vertical: true)
                                .accessibilityIdentifier("review-target")
                        }
                        Text(reviewMessage).font(.caption).fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("request-recovery-message")
                        if let progress = mac.result?.workflow {
                            WatchWorkflowProgressView(progress: progress, targets: mac.targetOptions)
                        }
                        if let reply = mac.result, mac.canPlayResult, let task = mac.task {
                            Button("Hear result", systemImage: "speaker.wave.2.fill") {
                                guard (!isRecoveryPreview || isPlaybackPreview), !mac.busy, mac.task?.id == task.id, mac.canPlayResult,
                                      let current = mac.result, current.status == .completed,
                                      current.spokenText == reply.spokenText else { return }
                                dismissReviewToGoose = false
                                mac.showRecovery()
                                dictation.speakReply(current.spokenText, taskID: task.id)
                                showingReview = false
                            }.disabled(mac.busy).accessibilityIdentifier("hear-verified-result")
                        }
                        if mac.hasPendingTask {
                            Button("Check status") { mac.refresh() }.disabled(mac.busy)
                                .accessibilityIdentifier("check-request-status")
                        }
                        if mac.canRetryPrepared {
                            Text("Uses the same saved request. This will not create another request.").font(.caption2)
                            Button("Retry saved request") { mac.sendOrRetry() }
                                .accessibilityIdentifier("retry-saved-request")
                        }
                        if mac.canStartNewRequest && !voiceSession.hasRecovery {
                            Button("New request") {
                                mac.newRequest(); dismissedCaptureError = capture.errorMessage
                                recordingRecoveryError = nil; transcript = ""
                                dismissReviewToGoose = false; showingReview = false
                            }.accessibilityIdentifier("new-request")
                        }
                        if voiceSession.hasRecovery && !mac.hasPendingTask && !mac.hasPreparedIdentity {
                            Button("Recover recording") { recoverRecording() }.disabled(recovering)
                        }
                        if mac.canDiscardUnsubmittedRecording(voiceSession) {
                            Text("Discard this recording to choose a different target or record again.")
                                .font(.caption2).foregroundStyle(.secondary)
                            Button("Discard recording", role: .destructive) {
                                guard mac.discardUnsubmittedRecording(voiceSession) else { return }
                                transcript = ""; recordingRecoveryError = nil
                                dismissedCaptureError = capture.errorMessage
                                taskRecordingFrozen = false; transcriptionStarted = false
                                dismissReviewToGoose = false; showingReview = false
                            }.accessibilityIdentifier("discard-unsent-recording")
                        }
                        if mac.hasPendingTask || mac.hasPreparedIdentity || mac.hasApprovalAttempt {
                            Text("Going back keeps this request. It does not cancel or send anything.")
                                .font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                }.buttonStyle(.bordered).padding(8)
            }
        }
        .sheet(item: $model.approval) { approval in
            ScrollView {
                VStack(spacing: 12) {
                    Text("Send this email?").font(.headline)
                    Text("From: \(approval.sender)").font(.caption2)
                    Text("To: \(approval.draft.recipientEmail ?? "")").font(.caption2)
                    Text(approval.draft.subject).font(.headline)
                    Text(approval.draft.body).font(.caption)
                    Button("Send email", systemImage: "paperplane.fill") { model.confirmSend(approval) }
                        .tint(.gray).disabled(model.busy)
                    Button("Keep draft") { model.approval = nil }
                }.buttonStyle(.bordered).padding(8)
            }
        }
    }

    private var pairing: some View {
        ScrollView {
            VStack(spacing: 12) {
                ProvidenceGooseScene(stage: .idle, level: 0, pressed: false, reducedMotion: true, active: false)
                    .frame(width: 54, height: 54).accessibilityHidden(true)
                Text("Connect your Watch").font(.headline).multilineTextAlignment(.center)
                    .foregroundStyle(ProvidencePalette.paper).accessibilityAddTraits(.isHeader)
                Text("On your phone, open Providence’s Account page. Choose Apple Watch to get a one-use code.")
                    .font(.caption2).foregroundStyle(ProvidencePalette.secondary).multilineTextAlignment(.center)
                TextField("Pairing code", text: $mac.pairingCode)
                    .textContentType(.oneTimeCode)
                    .accessibilityHint("Enter the code shown on your phone.")
                    .accessibilityIdentifier("mac-client-pairing-code")
                Button { mac.pair() } label: {
                    Label("Connect Watch", systemImage: "link").frame(maxWidth: .infinity, minHeight: 32)
                        .foregroundStyle(ProvidencePalette.graphite)
                }
                .buttonStyle(.borderedProminent).tint(ProvidencePalette.accent)
                .disabled(mac.busy || mac.pairingCode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                if mac.busy { ProgressView("Connecting").font(.caption2).accessibilityLabel("Connecting your Watch") }
                if let error = mac.setupMessage ?? mac.errorMessage {
                    Text(error).font(.caption2).foregroundStyle(ProvidencePalette.paper).multilineTextAlignment(.center)
                }
                Button("Not now") { dismissRecovery() }.font(.caption2)
                    .accessibilityIdentifier("pairing-back-to-goose")
            }.padding(.horizontal, 12).padding(.vertical, 8)
        }
    }

    private var voiceSurface: some View {
        GeometryReader { geometry in
            VStack(spacing: 5) {
                HStack {
                    Text("Providence").font(.caption2.weight(.semibold)).foregroundStyle(ProvidencePalette.secondary)
                    Spacer()
                    Button { targetSheet = .options } label: {
                        Image(systemName: "ellipsis").font(.body.weight(.semibold))
                            .frame(width: 44, height: 36).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).foregroundStyle(ProvidencePalette.paper)
                    .accessibilityLabel("Request options")
                    .accessibilityIdentifier("request-options")
                }.padding(.leading, 12)
                GooseButton(state: gooseState, level: displayLevel, reducedMotion: displayReducedMotion,
                    stage: flowStage, active: scenePhase == .active && !showingReview && targetSheet == nil,
                    targetIdentity: executionTargetLabel, pressedOverride: displayPressed) { event in
                    handleGoosePress(event)
                }
                .frame(maxWidth: geometry.size.width * 0.64, minHeight: 52, maxHeight: .infinity)
                .layoutPriority(-1)
                .accessibilityIdentifier("talk")
                .accessibilityLabel(buttonLabel)
                .accessibilityValue(gestureEvidence)
                .accessibilityHint(buttonHint)
                .accessibilityAddTraits(.isButton)
                .accessibilityAction { primaryTap() }
                .accessibilityAction(named: Text("Record")) { beginTaskCapture() }
                .accessibilityAction(named: Text("Finish recording")) { capture.finish() }
                .accessibilityAction(named: Text("Cancel recording")) { cancelCurrentCapture() }
                .accessibilityAction(named: Text("Play or pause reply")) { toggleReplyPlayback() }
                Text(hasSavedRequest ? "Request saved" : showsRecoveryControls ? surfaceMessage : flowTitle)
                    .font(.headline).fontWeight(.medium)
                    .lineLimit(2).minimumScaleFactor(0.8).multilineTextAlignment(.center)
                    .foregroundStyle(ProvidencePalette.paper)
                    .accessibilityIdentifier("flow-stage")
                Text(voiceHint)
                    .font(.caption2).foregroundStyle(ProvidencePalette.secondary)
                    .lineLimit(2).minimumScaleFactor(0.8).multilineTextAlignment(.center)
                    .accessibilityIdentifier("voice-next-action")
                if hasPlayableResult && capture.phase == .idle {
                    Button(flowStage == .speaking ? "Pause reply" : flowStage == .paused ? "Resume reply" : "Hear reply",
                           systemImage: flowStage == .speaking ? "pause.fill" : "play.fill") { toggleReplyPlayback() }
                        .font(.caption2).frame(minHeight: 32)
                        .buttonStyle(.plain).foregroundStyle(ProvidencePalette.accent)
                        .disabled(mac.busy)
                        .accessibilityIdentifier("voice-reply-playback")
                } else if mac.hasCredential {
                    Button { targetSheet = .computer } label: {
                        HStack(spacing: 4) {
                            Image(systemName: "laptopcomputer")
                            Text(mac.targetSelectionLabel).lineLimit(1).minimumScaleFactor(0.7)
                            Image(systemName: "chevron.down").font(.system(size: 8, weight: .semibold))
                        }.font(.caption2).frame(maxWidth: .infinity, minHeight: 32)
                    }
                    .buttonStyle(.plain).foregroundStyle(ProvidencePalette.accent)
                    .disabled(capture.phase != .idle || recovering || voiceSession.hasRecovery || !mac.canStartNewRequest)
                    .accessibilityLabel("Computer: \(mac.targetSelectionLabel)")
                    .accessibilityHint("Choose the target for your next request.")
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .sheet(item: $targetSheet, onDismiss: {
            if reviewAfterOptions { reviewAfterOptions = false; openReview() }
        }) { sheet in
            switch sheet {
            case .computer: WatchTargetSelectionView(model: mac)
            case .options: requestOptions
            }
        }
    }

    private var requestOptions: some View {
        NavigationStack {
            List {
                if capture.phase == .recording || capture.phase == .preparing {
                    Button("Cancel recording", systemImage: "xmark.circle") {
                        cancelCurrentCapture(); targetSheet = nil
                    }.accessibilityIdentifier("cancel-recording")
                }
                if hasPlayableResult {
                    Button(flowStage == .speaking ? "Pause reply" : flowStage == .paused ? "Resume reply" : "Hear result",
                           systemImage: "speaker.wave.2") {
                        toggleReplyPlayback(); targetSheet = nil
                    }
                    .disabled(mac.busy || capture.phase != .idle)
                    .accessibilityIdentifier("reply-playback")
                }
                if mac.needsRecovery || voiceSession.hasRecovery || showsRecoveryControls {
                    Button("Review request", systemImage: "tray") {
                        reviewAfterOptions = true; targetSheet = nil
                    }
                    .disabled(capture.phase != .idle)
                    .accessibilityIdentifier("review-request")
                }
                if mac.hasCredential {
                    Button { targetSheet = .computer } label: {
                        VStack(alignment: .leading, spacing: 3) {
                            Text("Computers & workflow")
                            Text(mac.targetSelectionLabel).font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                    .disabled(capture.phase != .idle || recovering || voiceSession.hasRecovery || !mac.canStartNewRequest)
                    .accessibilityIdentifier("choose-action-target")
                } else if !isUIPreview {
                    Button("Connect Watch") { mac.showRecovery(); targetSheet = nil }
                        .accessibilityIdentifier("connect-watch")
                }
            }
            .navigationTitle("Options")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { targetSheet = nil }
                }
            }
        }
    }

    private var displayLevel: Double {
        #if DEBUG
        if isRehearsal { return rehearsal.level }
        #endif
        return capture.level
    }

    private var displayPressed: Bool {
        #if DEBUG
        if isRehearsal { return rehearsal.pressed }
        #endif
        return false
    }

    private var displayReducedMotion: Bool {
        #if DEBUG
        if isRehearsal && ProcessInfo.processInfo.arguments.contains("--preview-reduce-motion") { return true }
        #endif
        return accessibilityReduceMotion
    }

    private var hasSavedRequest: Bool {
        #if DEBUG
        if isRehearsal { return rehearsal.didDismiss }
        #endif
        return mac.recoveryDismissed && mac.needsRecovery
    }

    private var hasPlayableResult: Bool {
        #if DEBUG
        if isRehearsal { return rehearsal.resultReady }
        #endif
        return mac.canPlayResult
    }

    private func decisionQuestionView(_ question: String, options: [String], busy: Bool,
                                      choose: @escaping (String) -> Void) -> some View {
        VStack(spacing: 10) {
            Text(question).font(.caption)
            ForEach(options, id: \.self) { option in
                Button(option) { choose(option) }.disabled(busy)
            }
        }
    }

    #if DEBUG
    @ViewBuilder private var rehearsalReview: some View {
        if let question = rehearsal.question {
            decisionQuestionView(question, options: rehearsal.options, busy: false) { rehearsal.choose($0) }
        } else {
            Text("On \(rehearsal.targetLabel)").font(.caption2).foregroundStyle(Color(white: 0.78))
                .fixedSize(horizontal: false, vertical: true)
            Text(rehearsal.statusText).font(.caption).fixedSize(horizontal: false, vertical: true)
            if rehearsal.resultReady {
                Button("Hear result", systemImage: "speaker.wave.2.fill") {
                    dismissReviewToGoose = false; showingReview = false
                    rehearsal.primaryTap()
                }
            } else {
                Button("Check status") { rehearsal.showReview() }
                Text("Going back keeps this request. It does not cancel or send anything.")
                    .font(.caption2).foregroundStyle(.secondary)
            }
        }
    }
    #endif

    private var captureError: String? {
        guard capture.errorMessage != dismissedCaptureError else { return nil }
        return capture.errorMessage
    }

    private var showsRecoveryControls: Bool {
        #if DEBUG
        if isRehearsal {
            return !rehearsal.didDismiss && [.routing, .running, .approval, .clarification, .recoverableError].contains(rehearsal.stage)
        }
        #endif
        guard capture.phase == .idle else { return false }
        return captureError != nil || recordingRecoveryError != nil ||
            (!mac.recoveryDismissed && (mac.needsRecovery || mac.busy) && !mac.canPlayResult)
    }

    private var surfaceMessage: String {
        #if DEBUG
        if isRehearsal {
            return rehearsal.stage == .recoverableError ? "Request needs attention" : rehearsal.question != nil ? "Review your decision" : "Working on your request"
        }
        #endif
        if captureError != nil || recordingRecoveryError != nil || mac.errorMessage != nil { return "Request needs attention" }
        if mac.pendingApproval != nil { return "Review your decision" }
        if mac.approvalRecoveryMessage != nil { return "Request saved · check status" }
        return mac.hasPreparedIdentity ? "Request saved" : "Working on your request"
    }

    private var reviewMessage: String {
        #if DEBUG
        if isRecoveryPreview && ProcessInfo.processInfo.arguments.contains("--preview-long-status") {
            return "The connection ended before Providence could confirm the result on Demo MacBook Pro. Your original request is still saved. Check its status before trying again; a new request could repeat the action."
        }
        #endif
        return captureError ?? recordingRecoveryError ?? mac.errorMessage ?? mac.approvalRecoveryMessage ?? mac.status
    }

    private func openReview() {
        targetSheet = nil
        #if DEBUG
        if isRehearsal { rehearsal.showReview(); return }
        #endif
        dismissReviewToGoose = true
        mac.showRecovery()
        showingReview = true
    }

    private func dismissRecovery() {
        #if DEBUG
        if isRehearsal { rehearsal.dismissReview(); return }
        #endif
        recoveryTask?.cancel(); recoveryTask = nil; recovering = false
        dismissedCaptureError = capture.errorMessage
        recordingRecoveryError = nil
        dictation.stopSpeaking()
        mac.dismissRecovery()
    }

    @Environment(\.accessibilityReduceMotion) private var accessibilityReduceMotion

    private var gooseState: GooseVisualState {
        #if DEBUG
        if isRehearsal {
            if rehearsal.didDismiss { return .idle }
            switch rehearsal.stage {
            case .idle: return .idle
            case .preparing, .transcribing: return .sending
            case .listening: return .listening
            case .routing, .running, .preparingReply: return .thinking
            case .approval, .clarification: return .review
            case .speaking: return .speaking
            case .success: return .ready
            case .paused: return .paused
            case .recoverableError: return .error
            }
        }
        if let argument = ProcessInfo.processInfo.arguments.first(where: { $0.hasPrefix("--preview-goose-state=") }),
           let fixture = GooseVisualState(rawValue: String(argument.dropFirst("--preview-goose-state=".count))) { return fixture }
        #endif
        if capture.phase == .recording { return .listening }
        if capture.phase == .preparing || capture.phase == .transcribing { return .sending }
        if mac.recoveryDismissed && captureError == nil && recordingRecoveryError == nil { return .idle }
        if captureError != nil || recordingRecoveryError != nil || mac.errorMessage != nil { return .error }
        if mac.approvalRecoveryMessage != nil { return .review }
        if mac.pendingApproval != nil || mac.result?.status == .needsInput { return .review }
        if let result = mac.result, result.status.isTerminal, result.status != .completed { return .error }
        if dictation.isPreparingReply { return .thinking }
        if dictation.isSpeaking { return .speaking }
        if dictation.isOutputPaused { return .paused }
        if mac.canPlayResult { return .ready }
        if mac.busy || recovering || (mac.hasPendingTask && !mac.isFinished) { return .thinking }
        return .idle
    }

    private var settledResultID: String? {
        guard mac.canPlayResult, !dictation.isPreparingReply, !dictation.isSpeaking,
              !dictation.isOutputPaused else { return nil }
        return mac.task?.id
    }

    private var flowStage: ProvidenceFlowStage {
        #if DEBUG
        if isRehearsal { return rehearsal.didDismiss ? .idle : rehearsal.stage }
        if isUIPreview { return gooseState.flowStage }
        #endif
        var snapshot = ProvidenceFlowSnapshot()
        switch capture.phase {
        case .idle: snapshot.capture = .idle
        case .preparing: snapshot.capture = .preparing
        case .recording: snapshot.capture = .recording
        case .transcribing: snapshot.capture = .transcribing
        }
        if let status = mac.result?.status ?? mac.task.map({ MacControlContracts.workStatus($0) }) {
            switch status {
            case .queued: snapshot.work = .queued
            case .running: snapshot.work = .running
            case .needsInput: snapshot.work = .needsInput
            case .completed: snapshot.work = mac.canPlayResult ? .completed : .queued
            case .failed, .cancelled, .interrupted: snapshot.work = .failed
            }
        }
        if let approval = mac.pendingApproval {
            snapshot.decision = MacControlContracts.decisionQuestion(approval) == nil ? .approval : .clarification
        }
        snapshot.reconcilingDecision = mac.approvalRecoveryMessage != nil && mac.pendingApproval == nil
        snapshot.hasError = captureError != nil || recordingRecoveryError != nil || mac.errorMessage != nil
        snapshot.recoveryDismissed = mac.recoveryDismissed && captureError == nil && recordingRecoveryError == nil
        snapshot.needsRecovery = mac.needsRecovery
        snapshot.preparingReply = dictation.isPreparingReply
        snapshot.speaking = dictation.isSpeaking
        snapshot.paused = dictation.isOutputPaused
        snapshot.busy = mac.busy
        snapshot.recoveringRecording = recovering
        snapshot.hasPendingTask = mac.hasPendingTask
        snapshot.successResting = successResting
        return snapshot.stage
    }

    private var flowTitle: String {
        if flowStage == .idle && hasPlayableResult { return "Ready when you are" }
        return flowStage.title
    }

    private var voiceHint: String {
        if hasSavedRequest || showsRecoveryControls { return "Tap the mark to review." }
        if let detail = flowDetail { return detail }
        if flowStage == .idle { return "Tap again to send." }
        if flowStage == .preparing { return "Tap again to cancel." }
        if flowStage == .transcribing { return "Sending your words…" }
        return "Your request stays with this conversation."
    }

    private var executionTargetLabel: String? {
        #if DEBUG
        if isRehearsal { return rehearsal.stage == .idle ? nil : rehearsal.targetLabel }
        if isRecoveryPreview && ProcessInfo.processInfo.arguments.contains("--preview-long-target") {
            return "Demo MacBook Pro — engineering workspace upstairs"
        }
        #endif
        return mac.selectedDeviceName.isEmpty ? mac.task?.deviceID : mac.selectedDeviceName
    }

    private var flowDetail: String? {
        #if DEBUG
        if isRehearsal && flowStage == .speaking { return "Silent playback preview" }
        #endif
        if flowStage == .speaking {
            return dictation.voiceStatus == "Apple voice · fallback" ? "Apple voice fallback" : dictation.voiceStatus
        }
        if flowStage == .running || flowStage == .routing {
            return executionTargetLabel ?? "Finding your device"
        }
        if flowStage == .listening { return "Tap again to send" }
        if flowStage == .paused { return "Resume reply below" }
        if hasPlayableResult && (flowStage == .success || flowStage == .idle) { return "Tap to ask again" }
        return nil
    }

    private var buttonLabel: String {
        #if DEBUG
        if isRehearsal {
            if hasSavedRequest || showsRecoveryControls { return "Review request" }
            if flowStage == .speaking { return "Speaking result" }
            if flowStage == .listening { return "Stop recording" }
            return "Tap to talk"
        }
        #endif
        if !mac.hasCredential && !isUIPreview { return "Connect Watch" }
        if mac.recoveryDismissed && mac.needsRecovery && !mac.canStartNewRequest { return "Review saved request" }
        if showsRecoveryControls { return "Review request" }
        if capture.phase == .recording { return "Stop recording" }
        if capture.phase == .preparing { return "Cancel microphone setup" }
        if capture.phase == .transcribing { return "Thinking" }
        if mac.pendingApproval != nil || mac.result?.status == .needsInput { return "Review approval" }
        if voiceSession.hasRecovery { return "Recover your recording" }
        if mac.preparedRequest != nil { return "Retry the same request" }
        if mac.hasPendingTask && !mac.isFinished { return "Working" }
        if mac.canPlayResult { return "Record a follow-up" }
        return "Tap to talk"
    }

    private var buttonHint: String {
        #if DEBUG
        if isRehearsal && (hasSavedRequest || showsRecoveryControls) {
            return "Tap to review the saved request. Dismiss returns to Providence without resending."
        }
        #endif
        if mac.needsRecovery && !mac.canStartNewRequest { return "Tap to review the saved request. Dismiss returns to Providence without resending." }
        if capture.phase == .recording { return "Tap again to stop recording and send." }
        if capture.phase == .preparing { return "Tap again to cancel microphone setup." }
        return "Tap to start recording. Tap again to stop and send."
    }

    private var gestureEvidence: String {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--preview-goose-gestures") { return gestureProof }
        #endif
        return gooseState.rawValue
    }

    private func handleGoosePress(_ event: GoosePressEvent) {
        #if DEBUG
        if isRehearsal { rehearsal.handlePress(event); return }
        #endif
        guard !isUIPreview else {
            #if DEBUG
            if ProcessInfo.processInfo.arguments.contains("--preview-goose-gestures") { inspectGesture(event) }
            #endif
            return
        }
        switch event {
        case .began:
            if gooseInteraction.pressBegan() == .activate { primaryTap() }
        case .released:
            _ = gooseInteraction.pressEnded()
        case .cancelled:
            gooseInteraction.cancel()
            cancelCurrentCapture()
        }
    }

    #if DEBUG
    /// Exercises the real gesture adapter/reducer without recorder, credentials,
    /// transcription, task dispatch or provider playback.
    private func inspectGesture(_ event: GoosePressEvent) {
        switch event {
        case .began:
            if gooseInteraction.pressBegan() == .activate {
                gestureProof = gestureProof == "recording" ? "submitted" : "recording"
            }
        case .released:
            _ = gooseInteraction.pressEnded()
        case .cancelled:
            gooseInteraction.cancel(); gestureProof = "cancelled"
        }
    }
    #endif

    private func primaryTap() {
        #if DEBUG
        if isRehearsal { rehearsal.primaryTap(); return }
        #endif
        guard !isUIPreview else { return }
        switch GooseInteraction.recordingAction(for: capture.phase) {
        case .stop: capture.finish(); return
        case .cancelPreparation: cancelCurrentCapture(); return
        case .ignore: return
        case .start: break
        }
        if !mac.hasCredential { mac.showRecovery(); return }
        if showsRecoveryControls || (mac.recoveryDismissed && mac.needsRecovery && !mac.canStartNewRequest) { openReview(); return }
        if mac.pendingApproval != nil || mac.result?.status == .needsInput { openReview(); return }
        if mac.hasPreparedIdentity { openReview(); return }
        if voiceSession.hasRecovery { recoverRecording(); return }
        if model.hasPendingRequest || model.preparedVoice != nil || model.hasRecording || model.sendNeedsRefresh {
            showingLegacyEmail = true; return
        }
        if mac.hasPendingTask && !mac.isFinished { openReview(); return }
        if captureError != nil || recordingRecoveryError != nil { openReview(); return }
        beginTaskCapture()
    }

    private func toggleReplyPlayback() {
        #if DEBUG
        if isRehearsal { rehearsal.togglePlayback(); return }
        #endif
        guard capture.phase == .idle, let result = mac.result, mac.canPlayResult, let task = mac.task else { return }
        guard !isRecoveryPreview || isPlaybackPreview else { openReview(); return }
        _ = dictation.toggleReplyPlayback(result.spokenText, taskID: task.id)
    }

    private func beginTaskCapture() {
        guard !isUIPreview && !isRecoveryPreview else { return }
        if !mac.hasCredential { mac.showRecovery(); return }
        if dictation.isSpeaking || dictation.isOutputPaused { dictation.stopReplyAndRetain() }
        guard capture.phase == .idle else { return }
        if model.hasPendingRequest || model.preparedVoice != nil || model.hasRecording || model.sendNeedsRefresh {
            showingLegacyEmail = true; return
        }
        if mac.pendingApproval != nil { openReview(); return }
        guard mac.canStartNewRequest else { openReview(); return }
        if voiceSession.hasRecovery { recoverRecording(); return }
        beginCapture { transcript = $0; dispatchConfirmedDictation() }
    }

    private func beginCapture(purpose: String = "task", _ completion: @escaping (String) -> Void) {
        if purpose == "task" {
            guard mac.beginVoiceCapture() else { openReview(); return }
            taskRecordingFrozen = true
        } else { taskRecordingFrozen = false }
        transcriptionStarted = false
        mac.showRecovery()
        dismissedCaptureError = nil; recordingRecoveryError = nil
        dictation.setMicrophoneActive(true)
        capture.start(transcribe: { data in
            transcriptionStarted = true
            return try await mac.transcribe(data, session: voiceSession, purpose: purpose)
        }) { text in
            dictation.setMicrophoneActive(false)
            completion(text)
            if purpose == "legacy" { voiceSession.consume() }
        }
    }

    private func clearUnsubmittedCaptureSelection() {
        guard taskRecordingFrozen, !transcriptionStarted, !voiceSession.hasRecovery else { return }
        mac.cancelVoiceCapture()
        taskRecordingFrozen = false
    }

    private func cancelCurrentCapture() {
        capture.cancel()
        clearUnsubmittedCaptureSelection()
    }

    private func recoverRecording() {
        guard !isRecoveryPreview, !recovering, scenePhase == .active else { return }
        recordingRecoveryError = nil
        recovering = true
        recoveryTask = Task { @MainActor in
            defer { recovering = false }
            do {
                let purpose = voiceSession.recoveryPurpose
                let text = try await mac.recoverTranscription(voiceSession)
                guard !Task.isCancelled, scenePhase == .active else { return }
                if purpose == "task" {
                    transcript = text
                    dispatchConfirmedDictation()
                } else {
                    recoveredLegacyText = text
                    showingReview = true
                }
            } catch {
                guard !Task.isCancelled, scenePhase == .active else { return }
                recordingRecoveryError = WatchRecoveryPresentation.message(for: error)
                showingReview = true
            }
        }
    }

    private func dispatchConfirmedDictation() {
        guard !isUIPreview, !isRecoveryPreview, !transcript.isEmpty, scenePhase == .active, !mac.busy else { return }
        // A cancelled or failed follow-up keeps the prior verified reply. Only
        // a confirmed transcript supersedes it with a new task identity.
        if mac.isFinished { mac.newRequest(preservingVoiceCapture: true) }
        let text = transcript
        if mac.submitVoiceRequest(text) { transcript = ""; routeName = VoiceRoute.mac.rawValue }
    }

    @ViewBuilder private var emailFlow: some View {
        Text(model.statusText).font(.caption).foregroundStyle(.secondary)
        if let error = model.errorMessage { Text(error).font(.caption2).foregroundStyle(ProvidencePalette.paper) }
        switch model.phase {
        case .idle:
            Text("Speak your email request.").font(.caption)
            Button("Talk", systemImage: "mic.fill") {
                dictation.collect { transcript = $0; dispatchConfirmedDictation() }
            }
                .tint(.gray).disabled(model.busy)
        case .preparing:
            ProgressView()
        case .recording:
            Text("\(Int(model.duration)) / 30s").monospacedDigit()
            ProgressView(value: model.level).tint(.gray).accessibilityLabel("Microphone level")
            Button("Stop", systemImage: "stop.fill") { model.stopRecording() }.tint(ProvidencePalette.accent)
            Button("Cancel") { model.discardRecording(); routeName = "" }
        case .recorded:
            recordedControls
        case .uploading, .processing:
            ProgressView()
            Text("Keep the app open. Reopen to check this request if interrupted.").font(.caption2)
        case .ready:
            if let job = model.job {
                EmailVoiceReview(model: model, dictation: dictation, job: job)
                    .id("\(job.id)-\(job.version)")
            }
        case .error:
            if model.hasRecording { recordedControls }
        }
        if model.hasPendingRequest {
            Button("Refresh status") { model.resume() }.disabled(model.busy)
        }
        if model.preparedVoice != nil {
            Text("Your exact request is saved. Retry keeps its original ID and text.").font(.caption2)
            Button("Retry same request") { model.retryVoice() }.disabled(model.busy)
        }
        if model.canStartNewRequest, model.phase != .recording, model.phase != .preparing {
            Button("New request") { model.newRequest(); transcript = ""; routeName = ""; showingLegacyEmail = false }
        }
    }

    private var recordedControls: some View {
        VStack(spacing: 10) {
            Text("\(Int(model.duration)) second recording").font(.caption)
            Text("Upload shares this recording through our development tunnel with the Mac backend and OpenAI to transcribe and draft. No email is sent yet.").font(.caption2)
            Button("Upload & draft", systemImage: "arrow.up.circle") { model.upload() }
                .tint(.gray).disabled(model.busy)
            Button("Discard recording") { model.discardRecording() }.disabled(model.busy)
        }
    }
}

#Preview { ContentView() }
