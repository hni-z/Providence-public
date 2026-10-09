# Providence on Apple Watch

The Watch is a voice input and reply device for Providence. It does not host a computer-control runtime. The native experience uses a black surface, white origami mark and neutral actions, with a readable current phase and next step.

- Tap the origami mark to record. Tap again to stop and send through the existing voice pipeline. Pairing, request identities, interruption recovery and target authorization are unchanged.
- The default target is labelled **All computers**; Providence uses the existing routing rules. A deliberately bound computer retains its actual displayed name. The label does not broadcast a request to every device.
- A verified completed reply exposes **Hear reply**, **Pause reply** or **Resume reply**. Nothing starts recording or playing merely because the screen appears.
- A new Watch receives one-use-code instructions on a scrollable connection screen. Obtain the code in the Providence account page's Apple Watch section. The native app must be signed and loaded separately.
- VoiceOver labels and actions, reduced-motion handling, saved-request review and one-request-at-a-time controls remain in place. The microphone permission text describes the actual tap/tap interaction.

Use the **WatchStarter** scheme for a direct watchOS build, or **ProvidenceDistribution** for the existing distribution container. Build artifacts and evidence for this UI pass are kept under ignored `outputs/apple-ui-release`. Development signing can use already-installed identities/profiles; physical installation still depends on the intended Watch being covered by a valid profile and reachable in Xcode.

The Watch bundles a privacy manifest declaring its app-local UserDefaults use. [Native distribution readiness](../iPhone/DISTRIBUTION.md) distinguishes these development builds from TestFlight/App Store submission and lists the remaining disclosure/signing/review requirements.

Simulator presentation fixtures do not record, transcribe, submit tasks or prove physical speaker/microphone behavior. Final acceptance still requires the intended Watch: pairing, a real recording, exact target routing, returned reply, playback and interruption handling. This UI change does not add native Watch WebRTC voice.
