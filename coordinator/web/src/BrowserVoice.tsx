import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Mic, Volume2, VolumeX, Send, RotateCcw, Info } from "lucide-react";
import {
  MAX_VOICE_RECORDING_BYTES,
  MAX_VOICE_RECORDING_MS,
  VoiceSessionGuard,
  browserTranscript,
  recognitionConstructor,
  recognitionErrorMessage,
  recordingMimeType,
  voiceCaptureMethod,
  recordingTimeslice,
  transcriptionRefused,
} from "./browser-voice";
import type {
  RecognitionLike,
  VoiceCaptureToken,
  VoiceOutcome,
  AcceptedVoiceTask,
} from "./browser-voice";
import { SpeechPlaybackError } from "./server-audio";
import { VoicePageLifecycle, playBrowserSpeech } from "./voice-lifecycle";
import type { SpeechReplyIdentity, SpeechAudioState } from "./server-audio";
import VoiceScreen from "./VoiceScreen";
import { voiceScreenReplies } from "./voice-screen";
import type { VoicePhase } from "./voice-screen";
import { livePcmSupported, prepareLivePcmCapture } from "./live-voice-capture";
import type { LivePcmCapture } from "./live-voice-capture";
import { LiveVoiceInput } from "./live-voice-session";
import type { LiveVoiceAdapter } from "./live-voice-session";
import { VoiceJobLedger } from "./live-voice-ledger";
export type { VoiceOutcome } from "./browser-voice";

export type BrowserVoiceProps = {
  contextKey: string;
  configurationKey?: string;
  disabled?: boolean;
  connected?: boolean;
  outcomes: VoiceOutcome[];
  onTranscript: (text: string) => Promise<AcceptedVoiceTask>;
  transcribe?: (blob: Blob, signal: AbortSignal) => Promise<string>;
  /** Present only after the server explicitly advertises the matching live capability. */
  liveInput?: LiveVoiceAdapter;
  allowBrowserRecognition?: boolean;
  allowBrowserSpeech?: boolean;
  speak?: (
    text: string,
    signal: AbortSignal,
    reply?: SpeechReplyIdentity,
  ) => Promise<void>;
  providerLabel?: string;
  presentation?: "compact" | "screen";
  onCaptureBusyChange?: (busy: boolean) => void;
  requests?: Array<{ id: string; status: string; error?: string }>;
  backgroundMode?: boolean;
  acknowledgedJobs?: Array<{ task: AcceptedVoiceTask; transcript: string }>;
  uncertainRequest?: { requestId: string; chatId: string; text: string };
};
const useVoiceLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;
type Phase = VoicePhase;
type Capture = {
  token: VoiceCaptureToken;
  contextKey: string;
  recorder: MediaRecorder;
  stream: MediaStream;
  chunks: Blob[];
  size: number;
  discarded: boolean;
  send: boolean;
  timer?: ReturnType<typeof setTimeout>;
};
type Recorded = { blob: Blob; token: VoiceCaptureToken; contextKey: string };
type LiveCapture = { token: VoiceCaptureToken; contextKey: string; capture?: LivePcmCapture; input?: LiveVoiceInput; finishing?: Promise<void> };
const statusText: Record<Phase, string> = {
  idle: "Ready",
  requesting: "Waiting for microphone permission",
  recording: "Recording, up to 25 seconds",
  ready: "Recording ready to send",
  listening: "Listening through your browser",
  transcribing: "Transcribing recording",
  sending: "Sending transcript to this conversation",
  waiting: "Request sent; waiting for a fresh reply",
};

/** Voice is another input/output surface for the existing selected conversation.
 * No provider credential, agent conversation, recording, or network call is created on mount.
 */
export default function BrowserVoice(props: BrowserVoiceProps) {
  const {
    contextKey,
    disabled = false,
    connected = true,
    outcomes,
    transcribe,
    speak,
    providerLabel,
  } = props;
  const current = useRef(props);
  current.current = props;
  const mounted = useRef(false);
  const guard = useRef(new VoiceSessionGuard());
  const ledger = useRef(new VoiceJobLedger());
  const [, refreshLedger] = useState(0);
  const [selectedJobId, setSelectedJobId] = useState<string | undefined>();
  const pageLifecycle = useRef<VoicePageLifecycle | undefined>(undefined);
  const capturedConfiguration = useRef<string | undefined>(undefined);
  const recognition = useRef<RecognitionLike | undefined>(undefined);
  const capture = useRef<Capture | undefined>(undefined);
  const liveCapture = useRef<LiveCapture | undefined>(undefined);
  const recorded = useRef<Recorded | undefined>(undefined);
  const inputAbort = useRef<AbortController | undefined>(undefined);
  const playbackAbort = useRef<AbortController | undefined>(undefined);
  const recognitionTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const speechActive = useRef(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const changePhase = (next: Phase) => {
    phaseRef.current = next;
    setPhase(next);
  };
  const [transcript, setTranscript] = useState("");
  const [acceptedTask, setAcceptedTask] = useState<AcceptedVoiceTask | undefined>();
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [muted, setMuted] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [audioState, setAudioState] = useState<SpeechAudioState>("preparing");
  const [retryOutcome, setRetryOutcome] = useState<VoiceOutcome | undefined>(
    undefined,
  );
  const [interacted, setInteracted] = useState(false);
  const [support, setSupport] = useState({
    recording: false,
    recognition: false,
    synthesis: false,
    live: false,
  });
  const label =
    providerLabel ??
    (transcribe || speak ? "Server / browser voice" : "Browser voice");

  function valid(token: VoiceCaptureToken, context: string) {
    return (
      mounted.current &&
      pageLifecycle.current?.active === true &&
      current.current.contextKey === context &&
      capturedConfiguration.current ===
        (current.current.configurationKey ?? "") &&
      current.current.connected !== false &&
      guard.current.isCurrent(token, context)
    );
  }
  function stopRecognition() {
    clearTimeout(recognitionTimer.current);
    const active = recognition.current;
    recognition.current = undefined;
    if (active) {
      active.onend = null;
      active.onerror = null;
      active.onresult = null;
      try {
        active.abort();
      } catch {}
    }
  }
  function stopPlayback() {
    playbackAbort.current?.abort();
    playbackAbort.current = undefined;
    speechActive.current = false;
    if (mounted.current) setSpeaking(false);
  }
  function discardCapture() {
    const active = capture.current;
    capture.current = undefined;
    recorded.current = undefined;
    if (!active) return;
    active.discarded = true;
    active.chunks.length = 0;
    clearTimeout(active.timer);
    if (active.recorder.state !== "inactive") {
      try {
        active.recorder.stop();
      } catch {}
    }
    active.stream.getTracks().forEach((track) => track.stop());
  }
  function clearVoice() {
    pageLifecycle.current?.stop();
    guard.current.reset(current.current.contextKey);
    capturedConfiguration.current = undefined;
    inputAbort.current?.abort();
    inputAbort.current = undefined;
    stopRecognition();
    discardCapture();
    const live = liveCapture.current;
    liveCapture.current = undefined;
    live?.capture?.cancel();
    live?.input?.cancel();
    stopPlayback();
    if (mounted.current) setRetryOutcome(undefined);
  }
  function fail(token: VoiceCaptureToken, context: string, message: string) {
    if (!valid(token, context)) return;
    clearVoice();
    changePhase("idle");
    setError(message.slice(0, 400));
  }
  useEffect(() => {
    mounted.current = true;
    const page = new VoicePageLifecycle(document, window, () => {
      clearVoice();
      changePhase("idle");
      setTranscript("");
      setNote("Voice stopped when this page was hidden. Start voice again to resume. Submitted requests continue.");
    });
    pageLifecycle.current = page;
    setSupport({
      recording:
        globalThis.isSecureContext !== false &&
        typeof navigator !== "undefined" &&
        typeof navigator.mediaDevices?.getUserMedia === "function" &&
        typeof MediaRecorder !== "undefined",
      recognition: Boolean(recognitionConstructor(window)),
      synthesis:
        typeof window.speechSynthesis?.speak === "function" &&
        typeof SpeechSynthesisUtterance !== "undefined",
      live: livePcmSupported(),
    });
    const offline = () => {
      clearVoice();
      changePhase("idle");
      setNote("Connection lost. Start voice again after reconnecting.");
    };
    window.addEventListener("offline", offline);
    return () => {
      mounted.current = false;
      page.dispose();
      clearVoice();
      if (pageLifecycle.current === page) pageLifecycle.current = undefined;
      window.removeEventListener("offline", offline);
    };
  }, []);
  useVoiceLayoutEffect(() => {
    clearVoice();
    changePhase("idle");
    setTranscript("");
    setAcceptedTask(undefined);
    setError("");
    setNote("");
    setInteracted(false);
    return () => {
      clearVoice();
    };
  }, [contextKey, props.configurationKey]);
  useEffect(() => {
    if (!connected) {
      clearVoice();
      changePhase("idle");
      setNote("Disconnected. Start voice again after reconnecting.");
    }
  }, [connected]);
  useEffect(() => {
    for (const receipt of props.acknowledgedJobs ?? []) ledger.current.accept(receipt.task, receipt.transcript);
    ledger.current.observe(outcomes);
    refreshLedger(version => version + 1);
  }, [outcomes, props.acknowledgedJobs]);

  async function sendTranscript(
    text: string,
    token: VoiceCaptureToken,
    context: string,
  ) {
    if (!valid(token, context)) return;
    try {
      const final = guard.current.claimTranscript(token, context, text);
      if (!final) return;
      setTranscript(final);
      changePhase("sending");
      const accepted = await current.current.onTranscript(final);
      if (accepted.chatId !== context) throw new Error("The voice acknowledgement identified another conversation.");
      ledger.current.accept(accepted, final);
      ledger.current.observe(current.current.outcomes);
      if (mounted.current) { setSelectedJobId(accepted.id); refreshLedger(version => version + 1); }
      if (!valid(token, context)) return;
      if (guard.current.acceptTranscript(token, context, accepted)) {
        setAcceptedTask(accepted);
        changePhase("waiting");
      }
    } catch (cause) {
      fail(
        token,
        context,
        cause instanceof Error
          ? cause.message
          : "The transcript could not be sent. Nothing was retried.",
      );
    }
  }
  async function sendBlob(value: Recorded) {
    if (!valid(value.token, value.contextKey)) return;
    if (!guard.current.claimRecording(value.token, value.contextKey)) return;
    const adapter = current.current.transcribe;
    if (!adapter) {
      fail(
        value.token,
        value.contextKey,
        "The transcription service is no longer available.",
      );
      return;
    }
    const controller = new AbortController();
    inputAbort.current = controller;
    changePhase("transcribing");
    try {
      const text = await adapter(value.blob, controller.signal);
      if (!valid(value.token, value.contextKey) || controller.signal.aborted) {
        return;
      }
      await sendTranscript(text, value.token, value.contextKey);
    } catch (cause) {
      if (controller.signal.aborted) return;
      if (transcriptionRefused(cause) && valid(value.token, value.contextKey) &&
          guard.current.releaseRefusedRecording(value.token, value.contextKey)) {
        recorded.current = value;
        changePhase("ready");
        setError(cause instanceof Error ? cause.message.slice(0, 400) : "");
        setNote("The recording was kept. Send it again in a moment.");
        return;
      }
      fail(
        value.token,
        value.contextKey,
        cause instanceof Error
          ? cause.message
          : "Transcription failed. Nothing was retried.",
      );
    } finally {
      if (inputAbort.current === controller) inputAbort.current = undefined;
    }
  }
  async function startLiveRecording(token: VoiceCaptureToken, context: string) {
    changePhase("requesting");
    const adapter = current.current.liveInput;
    if (!adapter) return;
    const controller = new AbortController(); inputAbort.current = controller;
    const active: LiveCapture = { token, contextKey: context };
    liveCapture.current = active;
    try {
      const microphone = await prepareLivePcmCapture({ signal: controller.signal,
        onChunk: (pcm, sequence) => active.input?.write(pcm, sequence),
        onError: message => fail(token, context, message) });
      if (!valid(token, context) || controller.signal.aborted || liveCapture.current !== active) { microphone.cancel(); return; }
      active.capture = microphone;
      setNote("Connecting live transcription. Nothing has been submitted.");
      const session = await adapter({ signal: controller.signal, onPartial: text => {
        if (!valid(token, context) || controller.signal.aborted || liveCapture.current !== active) return;
        if (text.length > 8000) { fail(token, context, "The live transcript is too long. Nothing was submitted."); return; }
        setTranscript(text); // Display only: no task is created from a partial transcript.
      } });
      if (!valid(token, context) || controller.signal.aborted || liveCapture.current !== active) { session.cancel(); microphone.cancel(); return; }
      active.input = new LiveVoiceInput(session, message => fail(token, context, message), controller.signal);
      setNote("Live transcript is provisional. Stop and send when your request is complete.");
      changePhase("recording"); microphone.start();
    } catch (cause) {
      if (!controller.signal.aborted) fail(token, context, cause instanceof Error ? cause.message : "Live voice could not start. Nothing was submitted.");
    }
  }
  function finishLiveRecording(active: LiveCapture) {
    if (active.finishing || !active.capture || !active.input || !valid(active.token, active.contextKey)) return;
    if (!guard.current.claimRecording(active.token, active.contextKey)) return;
    changePhase("transcribing");
    const controller = inputAbort.current;
    active.finishing = (async () => {
      try {
        await active.capture!.finish();
        if (!valid(active.token, active.contextKey) || controller?.signal.aborted) return;
        const final = await active.input!.finish();
        if (!valid(active.token, active.contextKey) || controller?.signal.aborted) return;
        setNote("");
        await sendTranscript(final, active.token, active.contextKey);
      } catch (cause) {
        if (!controller?.signal.aborted) fail(active.token, active.contextKey, cause instanceof Error ? cause.message : "Live transcription failed. Nothing was retried.");
      } finally {
        if (inputAbort.current === controller) inputAbort.current = undefined;
        if (liveCapture.current === active) liveCapture.current = undefined;
      }
    })();
  }
  function finishRecording(send: boolean) {
    if (liveCapture.current) {
      if (send) finishLiveRecording(liveCapture.current);
      return;
    }
    const active = capture.current;
    if (!active) {
      const value = recorded.current;
      if (send && value) {
        recorded.current = undefined;
        void sendBlob(value);
      }
      return;
    }
    active.send ||= send;
    clearTimeout(active.timer);
    if (active.recorder.state !== "inactive") {
      try {
        active.recorder.stop();
      } catch {
        fail(
          active.token,
          active.contextKey,
          "The browser could not finish this recording.",
        );
      }
    }
    active.stream.getTracks().forEach((track) => track.stop());
  }
  async function startRecording(token: VoiceCaptureToken, context: string) {
    changePhase("requesting");
    let stream: MediaStream | undefined;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!valid(token, context)) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const mime = recordingMimeType(MediaRecorder);
      const recorder = new MediaRecorder(stream, {
        audioBitsPerSecond: 32_000,
        ...(mime ? { mimeType: mime } : {}),
      });
      const active: Capture = {
        token,
        contextKey: context,
        recorder,
        stream,
        chunks: [],
        size: 0,
        discarded: false,
        send: false,
      };
      capture.current = active;
      recorder.ondataavailable = (event) => {
        if (active.discarded || !valid(token, context)) return;
        active.size += event.data.size;
        if (active.size > MAX_VOICE_RECORDING_BYTES) {
          fail(
            token,
            context,
            "Recording exceeded 512 KiB and was discarded. Record a shorter request.",
          );
          return;
        }
        if (event.data.size) active.chunks.push(event.data);
      };
      recorder.onerror = () =>
        fail(token, context, "Microphone recording failed and was discarded.");
      recorder.onstop = () => {
        clearTimeout(active.timer);
        active.stream.getTracks().forEach((track) => track.stop());
        if (capture.current === active) capture.current = undefined;
        if (active.discarded || !valid(token, context)) return;
        const blob = new Blob(active.chunks, {
          type: recorder.mimeType || active.chunks[0]?.type || "",
        });
        active.chunks.length = 0;
        if (!blob.size || blob.size > MAX_VOICE_RECORDING_BYTES) {
          fail(
            token,
            context,
            "No usable recording was captured. Nothing was sent.",
          );
          return;
        }
        const value = { blob, token, contextKey: context };
        if (active.send) void sendBlob(value);
        else {
          recorded.current = value;
          changePhase("ready");
          setNote("Microphone stopped. Send this recording or discard it.");
        }
      };
      recorder.start(recordingTimeslice(recorder.mimeType || mime));
      changePhase("recording");
      active.timer = setTimeout(() => {
        if (capture.current === active) finishRecording(false);
      }, MAX_VOICE_RECORDING_MS);
    } catch (cause) {
      stream?.getTracks().forEach((track) => track.stop());
      const denied =
        cause instanceof DOMException &&
        ["NotAllowedError", "SecurityError"].includes(cause.name);
      fail(
        token,
        context,
        denied
          ? "Microphone permission was denied. Voice stopped; use text or change browser permission."
          : "The browser could not start microphone recording.",
      );
    }
  }
  function startRecognition(token: VoiceCaptureToken, context: string) {
    const Constructor = recognitionConstructor(window);
    if (!Constructor) {
      fail(
        token,
        context,
        "Browser speech recognition is unavailable. Use text input.",
      );
      return;
    }
    try {
      const active = new Constructor();
      recognition.current = active;
      active.continuous = false;
      active.interimResults = true;
      active.lang = navigator.language || "en-US";
      let finalText = "";
      active.onresult = (event) => {
        if (!valid(token, context)) return;
        try {
          const text = browserTranscript(event);
          finalText = text.finalText;
          setTranscript(
            [text.finalText, text.interimText].filter(Boolean).join(" "),
          );
        } catch (cause) {
          fail(
            token,
            context,
            cause instanceof Error ? cause.message : "Recognition failed.",
          );
        }
      };
      active.onerror = (event) =>
        fail(token, context, recognitionErrorMessage(event.error));
      active.onend = () => {
        clearTimeout(recognitionTimer.current);
        if (recognition.current === active) recognition.current = undefined;
        if (!valid(token, context)) return;
        if (!finalText.trim()) {
          fail(
            token,
            context,
            "No final speech was recognized. Nothing was sent.",
          );
          return;
        }
        void sendTranscript(finalText, token, context);
      };
      changePhase("listening");
      active.start();
      recognitionTimer.current = setTimeout(
        () =>
          fail(
            token,
            context,
            "The browser listening limit was reached. Nothing was sent.",
          ),
        MAX_VOICE_RECORDING_MS,
      );
    } catch {
      fail(
        token,
        context,
        "The browser could not start speech recognition. Check its speech permission or use text.",
      );
    }
  }
  function start() {
    if (
      !pageLifecycle.current?.canStart ||
      current.current.disabled ||
      !(current.current.liveInput || voiceCaptureMethod(!!current.current.transcribe, current.current.allowBrowserRecognition !== false)) ||
      current.current.connected === false ||
      !["idle", "waiting"].includes(phaseRef.current)
    )
      return;
    setInteracted(true);
    clearVoice();
    if (!pageLifecycle.current?.begin()) return;
    setError("");
    setNote("");
    setTranscript("");
    setAcceptedTask(undefined);
    const context = current.current.contextKey;
    capturedConfiguration.current = current.current.configurationKey ?? "";
    const token = guard.current.begin(context, current.current.outcomes);
    if (current.current.liveInput) void startLiveRecording(token, context);
    else if (current.current.transcribe) void startRecording(token, context);
    else startRecognition(token, context);
  }
  function stop() {
    const prior = phaseRef.current;
    clearVoice();
    changePhase("idle");
    if (
      [
        "requesting",
        "recording",
        "ready",
        "listening",
        "transcribing",
      ].includes(prior)
    ) {
      setTranscript("");
      setNote("Voice input discarded. Nothing further will be sent.");
    } else
      setNote(
        "Voice stopped. Any submitted request continues in the conversation.",
      );
  }
  function toggleMute() {
    guard.current.ignoreOutcomes(contextKey, current.current.outcomes);
    if (!muted) stopPlayback();
    setRetryOutcome(undefined);
    setMuted(!muted);
  }
  function playOutcome(outcome: VoiceOutcome) {
    const context = outcome.contextKey;
    if (
      pageLifecycle.current?.active !== true ||
      current.current.connected === false ||
      current.current.contextKey !== context ||
      capturedConfiguration.current !==
        (current.current.configurationKey ?? "") ||
      (!guard.current.allowsPlayback(context, outcome) && !ledger.current.allows(context, outcome)) ||
      speechActive.current
    )
      return;
    const adapter = current.current.speak;
    if (!adapter && (!support.synthesis || current.current.allowBrowserSpeech === false)) {
      setNote(
        "The new reply is available as text; voice playback is unavailable.",
      );
      return;
    }
    setRetryOutcome(undefined);
    setError("");
    stopRecognition();
    const controller = new AbortController();
    playbackAbort.current = controller;
    speechActive.current = true;
    setSpeaking(true);
    setAudioState("preparing");
    const playback = adapter
      ? adapter(outcome.text, controller.signal, {
          id: outcome.id,
          contextKey: context,
          updatedAt: outcome.updatedAt,
          onAudioState: (state) => {
            if (
              !controller.signal.aborted &&
              mounted.current &&
              current.current.contextKey === context
            )
              setAudioState(state);
          },
        })
      : playBrowserSpeech(outcome.text, controller.signal, () => {
          if (!controller.signal.aborted && mounted.current && current.current.contextKey === context)
            setAudioState("playing");
        });
    void Promise.resolve(playback)
      .catch((cause) => {
        if (
          !controller.signal.aborted &&
          mounted.current &&
          current.current.contextKey === context
        ) {
          setError(
            cause instanceof Error
              ? cause.message.slice(0, 400)
              : "Voice playback failed. The text remains available.",
          );
          if (
            !adapter ||
            (cause instanceof SpeechPlaybackError && cause.canReplay)
          )
            setRetryOutcome(outcome);
        }
      })
      .finally(() => {
        if (playbackAbort.current === controller) {
          playbackAbort.current = undefined;
          speechActive.current = false;
          if (mounted.current) setSpeaking(false);
        }
      });
  }
  useEffect(() => {
    if (props.backgroundMode) return; // Multiple accepted jobs use explicit playback selection only.
    if (muted) {
      guard.current.ignoreOutcomes(contextKey, outcomes);
      return;
    }
    if (
      pageLifecycle.current?.active !== true ||
      !connected ||
      speechActive.current ||
      retryOutcome ||
      [
        "requesting",
        "recording",
        "ready",
        "listening",
        "transcribing",
        "sending",
      ].includes(phase)
    )
      return;
    const outcome = guard.current.claimFreshOutcome(contextKey, outcomes);
    if (outcome) playOutcome(outcome);
  }, [
    outcomes,
    contextKey,
    connected,
    phase,
    muted,
    speaking,
    support.synthesis,
    retryOutcome,
    props.backgroundMode,
  ]);

  const method = voiceCaptureMethod(!!transcribe, props.allowBrowserRecognition !== false);
  const canCapture = props.liveInput ? support.live : method === "recording" ? support.recording : method === "recognition" && support.recognition;
  const captureBusy = !["idle", "waiting"].includes(phase);
  useVoiceLayoutEffect(() => {
    props.onCaptureBusyChange?.(captureBusy);
  }, [captureBusy, props.onCaptureBusyChange]);
  useEffect(() => () => current.current.onCaptureBusyChange?.(false), []);
  const active = phase !== "idle" || speaking;
  const detailsVisible = active || interacted || Boolean(error || transcript);
  const acceptedRequest = props.requests?.find(request => request.id === acceptedTask?.id);
  const jobs = ledger.current.list(contextKey);
  const selectedJob = jobs.find(job => job.id === selectedJobId) ?? jobs.at(-1);
  const ledgerReplies = selectedJob ? ledger.current.replies(selectedJob.id, contextKey) : [];
  const visibleReplies = props.backgroundMode ? ledgerReplies : voiceScreenReplies(acceptedTask, contextKey, outcomes);
  function playLedgerReply(outcome: VoiceOutcome) {
    if (captureBusy || speaking || muted || !connected || !ledger.current.allows(contextKey, outcome)) return;
    if (!pageLifecycle.current?.begin()) return;
    capturedConfiguration.current = current.current.configurationKey ?? "";
    playOutcome(outcome);
  }
  if (props.presentation === "screen") return <VoiceScreen
    phase={phase} speaking={speaking} playing={audioState === "playing"} recording={!!transcribe || !!props.liveInput} live={!!props.liveInput}
    canStart={!disabled && connected && !!canCapture && !captureBusy} captureAvailable={!!canCapture} connected={connected} captureBusy={captureBusy}
    transcript={props.backgroundMode && !captureBusy && !props.uncertainRequest && selectedJob ? selectedJob.transcript : transcript}
    replies={visibleReplies} note={note} error={error || (props.backgroundMode && selectedJob ? props.requests?.find(request => request.id === selectedJob.id)?.error : acceptedRequest?.error) || ""}
    requestStatus={props.backgroundMode && selectedJob ? props.requests?.find(request => request.id === selectedJob.id)?.status : acceptedRequest?.status}
    providerLabel={label} muted={muted} canRetry={!!retryOutcome}
    backgroundReady={props.backgroundMode && !!acceptedTask && !props.uncertainRequest}
    jobs={props.backgroundMode ? jobs.map(job => ({ ...job, status: props.requests?.find(request => request.id === job.id)?.status ?? "accepted" })) : undefined}
    selectedJobId={selectedJob?.id} selectJob={setSelectedJobId}
    playReply={props.backgroundMode ? playLedgerReply : undefined}
    uncertain={!!props.uncertainRequest}
    start={start} sendRecording={() => finishRecording(true)}
    stop={stop} stopPlayback={stopPlayback} toggleMute={toggleMute} retry={() => { if (retryOutcome) playOutcome(retryOutcome); }}
  />;
  return (
    <section
      className={`browser-voice${!detailsVisible ? " is-idle" : ""}${phase === "recording" || phase === "listening" ? " is-recording" : ""}${speaking ? " is-speaking" : ""}`}
      aria-label="Voice for this conversation"
    >
      <div className="browser-voice-controls">
        {(transcribe || props.liveInput) && ["recording", "ready"].includes(phase) ? (
          <button type="button" className="button primary" disabled={!connected} onClick={() => finishRecording(true)}>
            <Send size={14} /> {phase === "recording" ? "Stop & send" : "Send recording"}
          </button>
        ) : (
          <button type="button" className="button" disabled={disabled || !connected || !canCapture || captureBusy} onClick={start}>
            <Mic size={14} /> Record
          </button>
        )}
        {active && <button type="button" className="button" onClick={stop}>
          {captureBusy ? "Cancel" : "Stop"}
        </button>}
        {active && <button type="button" className="button voice-mute" aria-pressed={muted}
          aria-label={muted ? "Unmute replies" : "Mute replies"} title={muted ? "Unmute replies" : "Mute replies"} onClick={toggleMute}>
          {muted ? <VolumeX size={15} /> : <Volume2 size={15} />}
        </button>}
        {retryOutcome && <button type="button" className="button" aria-label="Retry audio" title="Retry audio" disabled={!connected || speaking || captureBusy} onClick={() => playOutcome(retryOutcome)}>
          <RotateCcw size={14} />
        </button>}
        <span className="voice-info-icon" role="img" tabIndex={0} aria-label="AI-generated voice" title="AI-generated voice"><Info size={14} aria-hidden="true" /></span>
        <span className="browser-voice-state" role="status">
          {!connected ? "Offline" : !canCapture ? "Voice unavailable" : speaking
            ? audioState === "preparing" ? "Preparing audio" : "Speaking"
            : props.liveInput && phase === "recording" ? "Live transcription" : props.liveInput && phase === "transcribing" ? "Finalizing transcript" : phase === "idle" ? "" : statusText[phase]}
        </span>
      </div>
      {detailsVisible && note && <p className="browser-voice-note">{note}</p>}
      {transcript && <details className="compact-transcript">
        <summary>Transcript</summary>
        <p className="browser-voice-transcript">{transcript}</p>
      </details>}

      {error && (
        <p className="browser-voice-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
