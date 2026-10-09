# Quest client

## Hosted spatial preview

Open `https://providence.hani.so/meta` and sign in with the same Providence account. The view uses the account's HttpOnly session; it does not ask for an API key or a second access code. The existing `/quest/` URL remains available.

The floating sphere is the voice control. Select it once to enable the microphone, then select it to start recording and again to send. On Quest, aim and pinch or use the controller trigger. On a computer or phone, click or tap. Submitted work appears on the surrounding device and activity panels. Ending voice releases capture and playback; it does not cancel work already submitted.

Panels show connection status, task updates, questions, and returned files. **Live desktop screen streaming is not implemented.** Physical Quest microphone, speaker, hand tracking and comfort checks are still required before presenting the preview as headset-tested.


The Quest interface connects to the same authenticated coordinator as the web workspace. It supports desktop WebGL preview and WebXR on compatible hardware. Microphone, speech playback, controller/hand input and physical headset behavior require separate verification on the target device. A hosted account can issue a one-use client pairing code for this interface.

## Build and serve

```sh
cd coordinator/quest
npm ci
npm run check
npm test
npm run build
```

Serve `quest/dist` at `/quest/`, with any index fallback restricted to this prefix. Vite asset paths use `/quest/`. All runtime requests use same-origin `/v1/...` and `/client/exchange`, without a fixed tunnel hostname or client-side provider key. Development uses `npm run dev` at `http://127.0.0.1:5183/quest/`, proxying those API prefixes to port 8787. Do not expose the development server as the remote demo.

Require authenticated HTTPS on the real headset. Recommended response headers:

- `Permissions-Policy: microphone=(self), xr-spatial-tracking=(self)`
- CSP permits bundled same-origin scripts/styles/connections, canvas/data images, and `media-src 'self' blob:` for local microphone playback. No remote assets, models, fonts or iframe are required.
- HTML and private API responses use `Cache-Control: no-store`; hashed assets may be immutable.

For repeat testing, the default sign-in option accepts the existing private workspace owner key. No new credential is created. Uncheck the reusable-key option to use a one-use twelve-character client code displayed `XXXX-XXXX-XXXX`: `POST /client/exchange {code}` returns `{token,clientId,expiresAt}`. Tokens stay in memory and this tab's `sessionStorage`, never URLs, logs, Git, or localStorage. Sign out clears local session state and aborts in-flight fetches; coordinator-side revocation belongs to the workspace owner.

## Interaction and truthful state

- Enable microphone from the 2D page before entering XR, or explicitly choose text only. Permission denial leaves text controls available; it never triggers a retry/bypass.
- Feature-detect immersive VR/AR and only expose supported modes. Hand/controller counts come from actual session input sources. A desktop preview is explicitly labelled as such.
- Forward hand ray plus ordinary pinch uses standard XR selection events. Controllers use the same target ray. Palm-facing pinch remains a Quest system gesture. Either hand can select; two pointers cannot own the same hold action.
- **Arrange panels** pauses application actions and exposes a large header grab area on each panel. Hold the header, move the ray, then release to commit. A drag owns its release and cannot activate Send, Talk or an approval underneath it. Tracking loss, cancellation, system-menu visibility loss and mode changes discard the current drag preview. **Done arranging** returns to task controls.
- Arrangement keeps panels upright and bounds their angle to ±70 degrees, distance to 1.8–3.2 metres and vertical offset to −0.55–0.45 metres from the workspace anchor. **Recenter panels** resets all four positions around the current head pose. Polling never moves the panels. Arrangement permits overlap; Recenter restores the separated default positions. Labels wrap or ellipsize without squeezing their glyphs; physical readability still needs a headset check.
- Normal actions activate only after release on the same captured action ID. Approvals include their unique decision ID in that identity. Hovering cannot approve. Microphone hold is bounded to 30 seconds, muted outside holds, and discarded on hiding/teardown.
- The system keyboard is used only when `session.isSystemKeyboardSupported` is reported. Otherwise typing exits XR and focuses the visible 2D composer.
- Exact pending approval IDs/questions are submitted. Multi-question/free-text decisions use the complete 2D form. Task status and delegated `workStatus` are displayed separately. Stopping a parent does not imply its child tasks have stopped.
- A lost or mismatched submission acknowledgement is not automatically retried. The returned task must carry a usable ID and the exact submitted request/chat IDs before pending recovery is cleared. Resending unchanged pending text to the same chat reuses its request ID. GET snapshots refresh every 1.5 seconds. Stale/sign-out responses cannot restore signed-out state.
- Returned file bytes are checked against the artifact SHA-256 before displaying text or downloading. HTML/text is displayed as text, never executable markup.

## Minimal Superagent controller and voice

The prepared controller defaults to **Superagent** (`chatId: master`, `POST /v1/messages`) and offers the existing registered chats in a dropdown. Every typed or spoken request uses the same request-ID deduplication, chat, task, decision and result APIs as the main website. Device cards do not silently change the destination. Offline direct chats and conversations still working or awaiting input disable new sends.

Reload also stays on Superagent when a previous child-chat submission has an uncertain result. Its exact original chat, text and request ID remain in explicit recovery controls. Retrying never changes that identity or destination; dismissing clears only this tab's local retry record and does not cancel a submitted task. No recovery action runs automatically.

**Hold to talk** is an explicit single-request action, not continuous listening. Its final recognized text is visible and sent once to the captured chat without a second transcript confirmation. Changing chat, signing out, hiding/exiting the session or selecting Stop voice invalidates late capture/results. Stop voice cancels microphone/dictation/playback and any pending upload; an already-submitted computer task continues until its separate Stop task action is used.

Configure input and output independently using [voice configuration](ELEVENLABS_VOICE.md). Provider credentials stay on the server. Test capture and audible completion on the physical headset.
- If the authenticated transcription capability reports an online configured worker, Hold to talk records with the existing bounded MediaRecorder path, transcribes on release, and submits the final transcript once. The adapter refreshes capability before upload, keeps the same request identity for an uncertain explicit retry, and aborts before a pending capability check can progress to upload after Stop. No new backend route or voice worker is introduced.
- When no transcription host has yet been selected, `SpeechRecognition` or `webkitSpeechRecognition` is used only if actually present in the browser. A selected host becoming unavailable does not trigger this fallback. This is optional, never a dependency for text control. Recognition starts only on the explicit hold, uses a 25-second capture limit plus a bounded finish period, ignores interim/late duplicate results, and does not retry denial or network errors. The browser service may process audio online; constructor detection is not a physical speech proof. See [MDN SpeechRecognition](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition).
- If neither browser recognition nor configured transcription is available, voice input remains unavailable and text control stays usable. Configure provider accounts and keys privately on your server.
- **Completion speech** is enabled by default but is armed only after the primary Hold to talk path receives the exact accepted task/chat identity. It waits for that request and all explicitly linked work to finish. Loaded history, typed requests, diagnostic transcript sends, pending-request recovery, reconnect and page restoration cannot arm it. Arrangement defers an eligible completion; input capture, backgrounding and XR focus loss stop or block output.
- Output uses the configured server speech provider, or feature-detected browser `speechSynthesis` only when server speech is known to be unconfigured. The automatic claim is consumed before any asynchronous provider call, so a failed or unknown outcome cannot trigger a second paid request or a silent browser fallback. Playback is bounded to 4,000 characters, half-duplex and cancellable. Engine completion is not proof the headset speaker was audible.
- **Mute replies** stops playback and retires current automatic eligibility while device work continues. Unmuting applies to the next voice request; it cannot read a missed completion. **Read new reply** is an explicit action for the current accepted voice result. If audio downloaded but autoplay/playback failed, the explicit action can replay cached bytes without another synthesis or task submission. A failed or unknown synthesis is not retried. **Stop voice** additionally clears the current voice result's eligibility and cache.
- Provider capability/configuration refresh runs alongside periodic discovery. A changed or unavailable configuration stops capture/playback, discards cached audio and clears the old reply's playback eligibility. Recovery cannot request speech again for that old reply. Its task text, accepted task history and any unrelated pending-send recovery remain unchanged.
- The separate **mic test / recorded transcription** controls remain available for diagnostics. A local mic test does not upload or submit. Explicit Transcribe recording creates an editable transcript; its separate Send control remains manual. This diagnostic path is distinct from primary Hold to talk.

Existing service contract: GET `/v1/transcriptions` returns `{transcription:{available,devices:[{id,name,online,configured,provider?}],mimeTypes,maxAudioBytes,provider}}`. Provider labels are `OpenAI` or `ElevenLabs`; a configured legacy worker missing its own label remains OpenAI, regardless of the global default. POST JSON `{requestId,deviceId,base64,mimeType}` returns a job; GET `/v1/transcriptions/:id` polls `pending|completed|failed|interrupted`. MIME is normalized before `;`; accepted formats are webm/mp4/ogg/wav. Captures request 32 kbps, stop within 30 seconds, and are independently checked against 512 KiB. GET `/v1/voice` discovers independent input/output configuration; authenticated POST `/v1/speech` sends only `{requestId,text}` and returns bounded MPEG audio. Provider keys never enter the client. Legacy voice metadata without separate flags falls back to its existing `configured` value.
