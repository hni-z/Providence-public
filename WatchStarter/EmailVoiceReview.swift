import SwiftUI

struct EmailVoiceReview: View {
    @ObservedObject var model: AssistantModel
    @ObservedObject var dictation: NativeDictation
    let job: AssistantJob
    @State private var answer: String?

    var body: some View {
        VStack(spacing: 10) {
            if let draft = job.draft {
                Text("From: \(job.sender ?? "Not configured")").font(.caption2)
                Text("To: \(draft.recipientEmail ?? draft.recipientName ?? "Not specified")").font(.caption2)
                Text(draft.subject).font(.headline)
                Text(draft.body).font(.caption).frame(maxWidth: .infinity, alignment: .leading)
            }
            if VoiceContracts.canClarify(job), !model.sendNeedsRefresh {
                if let question = VoiceContracts.followUp(job) {
                    Text(question).font(.caption)
                    Button("Answer by voice", systemImage: "mic.fill") {
                        dictation.collect { answer = $0 }
                    }.tint(ProvidencePalette.accent).accessibilityIdentifier("clarify-by-voice")
                    Button("Hear question") { dictation.speak(question) }
                } else if VoiceContracts.isEditable(job) {
                    Button("Change recipient by voice", systemImage: "mic") {
                        dictation.collect { answer = $0 }
                    }
                    ContactMemoryReview(model: model, dictation: dictation, job: job)
                    Button("Review & send", systemImage: "paperplane") { model.prepareSend() }
                        .tint(ProvidencePalette.accent).accessibilityIdentifier("review-email-send")
                }
                if let answer {
                    Text("You said: \(answer)").font(.caption2)
                    Button("Use answer") {
                        model.clarify(answer, for: job)
                        self.answer = nil
                    }.tint(ProvidencePalette.accent)
                    Button("Discard answer") { self.answer = nil }
                }
            }
            Text(job.send.message).font(.caption2)
                .foregroundStyle(job.send.status == "uncertain" ? ProvidencePalette.paper : Color.secondary)
            if model.sendNeedsRefresh {
                Text("Send outcome needs a status check. Refresh before continuing.").font(.caption2).foregroundStyle(ProvidencePalette.paper)
            }
        }
        .disabled(model.busy || dictation.isPresenting)
        .onAppear {
            if let question = VoiceContracts.followUp(job) { dictation.speak(question) }
        }
    }
}

private struct ContactMemoryReview: View {
    @ObservedObject var model: AssistantModel
    @ObservedObject var dictation: NativeDictation
    let job: AssistantJob
    @State private var candidate: ContactProposal?
    @State private var confirmationMessage: String?
    @State private var spokenConfirmation = false
    @Environment(\.scenePhase) private var scenePhase

    init(model: AssistantModel, dictation: NativeDictation, job: AssistantJob) {
        self.model = model
        self.dictation = dictation
        self.job = job
        // A backend proposal is a suggestion only; it never causes a write.
        _candidate = State(initialValue: job.contactProposal)
    }

    var body: some View {
        VStack(spacing: 8) {
            if let remembered = model.rememberedContact {
                Text("Remembered \(remembered.name) as \(remembered.email).").font(.caption2)
            } else if let candidate, candidate.email == job.draft?.recipientEmail {
                let question = "Remember \(candidate.name) as \(candidate.email)?"
                Text(question).font(.caption2)
                Button("Remember contact") { model.remember(candidate, for: job) }
                Button("Confirm by voice", systemImage: "mic") {
                    dictation.collect { answer in
                        if VoiceContracts.confirmsRemembering(answer) {
                            spokenConfirmation = true
                            rememberWhenReady()
                        }
                        else { confirmationMessage = "Not saved. Say yes to remember this exact name and address, or choose Skip." }
                    }
                }
                Button("Hear name and address") { dictation.speak(question) }
                Button("Skip") { self.candidate = nil; spokenConfirmation = false }
                if let confirmationMessage { Text(confirmationMessage).font(.caption2).foregroundStyle(ProvidencePalette.paper) }
            } else if let email = job.draft?.recipientEmail {
                Button("Remember recipient by name", systemImage: "person.crop.circle.badge.plus") {
                    dictation.speak("What name should I remember for this address?")
                    // The name is collected separately from confirmation. Saying a
                    // name cannot itself save a contact or approve an email.
                    confirmationMessage = "Tap Speak name, then confirm the exact name and address."
                }
                if confirmationMessage != nil {
                    Text(confirmationMessage ?? "").font(.caption2)
                    Button("Speak name", systemImage: "mic") {
                        dictation.collect { name in
                            candidate = ContactProposal(name: name.trimmingCharacters(in: .whitespacesAndNewlines), email: email)
                            confirmationMessage = nil
                        }
                    }
                }
            }
        }
        .onChange(of: candidate, initial: true) { _, value in
            if let value, value.email == job.draft?.recipientEmail {
                dictation.speak("Remember \(value.name) as \(value.email)? Say yes to confirm, or choose Skip.")
            }
        }
        .onChange(of: model.busy) { _, busy in if !busy { rememberWhenReady() } }
        .onChange(of: scenePhase) { _, phase in if phase == .active { rememberWhenReady() } }
    }

    private func rememberWhenReady() {
        guard spokenConfirmation, scenePhase == .active, !model.busy, let candidate else { return }
        spokenConfirmation = false
        model.remember(candidate, for: job)
    }
}
