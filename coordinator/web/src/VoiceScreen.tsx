import { Mic, Send, Square, Volume2, VolumeX, RotateCcw, Info, LoaderCircle } from "lucide-react";
import ReactMarkdown from "react-markdown";
import type { VoiceOutcome } from "./browser-voice";
import { activateVoiceCircle, voiceCircleAction, voiceJobStatus, voiceRequestFinished, voiceScreenGuidance, voiceSessionControl } from "./voice-screen";
import type { VoicePhase } from "./voice-screen";

/** Presentation only. BrowserVoice owns the one recorder, request guard and player. */
export default function VoiceScreen(props: {
  phase: VoicePhase; speaking: boolean; playing: boolean; recording: boolean;
  live?: boolean;
  backgroundReady?: boolean;
  jobs?: Array<{ id: string; requestId: string; chatId: string; transcript: string; status: string }>;
  selectedJobId?: string;
  selectJob?: (id: string) => void;
  playReply?: (outcome: VoiceOutcome) => void;
  uncertain?: boolean;
  canStart: boolean; captureAvailable: boolean; connected: boolean; captureBusy: boolean;
  transcript: string; replies: VoiceOutcome[]; note: string; error: string;
  requestStatus?: string;
  providerLabel: string; muted: boolean; canRetry: boolean;
  start: () => void; sendRecording: () => void;
  stop: () => void; stopPlayback: () => void; toggleMute: () => void; retry: () => void;
}) {
  const finished = voiceRequestFinished(props.requestStatus, props.replies.length > 0);
  const mayRecordAgain = finished || props.backgroundReady === true;
  const circle = voiceCircleAction(props.phase, props.speaking, props.recording, mayRecordAgain);
  const guidance = voiceScreenGuidance({ ...props, hasReply: props.replies.length > 0 });
  const sessionControl = voiceSessionControl(props.phase, props.captureBusy, props.speaking, finished);
  const circleDisabled = circle.action === "none" || (circle.action === "start" && !props.canStart);
  const CircleIcon = circle.action === "send_recording" ? Send : circle.action === "stop_playback" || circle.action === "discard" ? Square
    : ["requesting", "transcribing", "sending"].includes(props.phase) ? LoaderCircle : Mic;
  const onCircle = () => activateVoiceCircle(props.phase, props.speaking, props.recording, props.canStart, props, mayRecordAgain);
  return <section className="voice-screen-surface" aria-label="Voice for this conversation">
    <div className="voice-screen-stage" data-phase={props.phase}>
      <button type="button" className={`voice-circle${props.phase === "recording" || props.phase === "listening" ? " is-listening" : ""}${props.speaking && props.playing ? " is-speaking" : ""}`}
        aria-label={circle.label} aria-describedby="voice-circle-help"
        disabled={circleDisabled} onClick={onCircle}><CircleIcon className="voice-circle-symbol" size={34} strokeWidth={1.5} aria-hidden="true" /></button>
      <p className="voice-screen-status" role="status" aria-live="polite">{guidance.status}</p>
      <p id="voice-circle-help" className="voice-screen-help">{guidance.help}</p>
      {props.error && <p className="browser-voice-error voice-screen-alert" role="alert">{props.error}</p>}
      <div className="voice-screen-controls">
        {props.phase === "ready" && <button type="button" className="button primary" disabled={!props.connected} onClick={props.sendRecording}>
          <Send size={16} /> Send recording
        </button>}
        {sessionControl && <button type="button" className="button" aria-describedby={sessionControl === "end" ? "voice-session-stop-help" : undefined} onClick={props.stop}>{sessionControl === "end" ? "End voice session" : "Discard voice input"}</button>}
        {props.speaking && <button type="button" className="button" onClick={props.stopPlayback}><Square size={14} aria-hidden="true" /> Stop audio</button>}
        {props.canRetry && <button type="button" className="button" aria-label="Retry reply audio" title={props.muted ? "Unmute replies to retry audio" : "Retry reply audio"} disabled={!props.connected || props.speaking || props.captureBusy || props.muted} onClick={props.retry}>
          <RotateCcw size={15} aria-hidden="true" /> Retry audio
        </button>}
        <button type="button" className="button" aria-label={props.muted ? "Unmute replies" : "Mute replies"} title={props.muted ? "Unmute replies" : "Mute replies"} aria-pressed={props.muted} onClick={props.toggleMute}>
          {props.muted ? <VolumeX size={16} aria-hidden="true" /> : <Volume2 size={16} aria-hidden="true" />}{props.muted ? "Unmute replies" : "Mute replies"}
        </button>
        <span className="voice-info-icon" role="img" tabIndex={0} aria-label="AI-generated voice" title={`${props.providerLabel} · AI-generated voice`}><Info size={15} aria-hidden="true" /></span>
      </div>
      {sessionControl === "end" && <p id="voice-session-stop-help" className="voice-session-stop-help">Ending voice does not stop submitted work. Use Workspace to stop a task.</p>}
      {props.muted && <p className="voice-replies-muted">Replies are muted. Written responses still appear below.</p>}
      {props.note && props.connected && <p className="voice-screen-note voice-stage-note">{props.note}</p>}
    </div>
    <div className="voice-screen-content">
      {!!props.jobs?.length && <section className="voice-screen-transcript voice-job-history" aria-label="Acknowledged voice requests">
        <h2>Your requests</h2>
        {props.jobs.map(job => <button type="button" className="button" key={job.id}
          aria-pressed={props.selectedJobId === job.id} onClick={() => props.selectJob?.(job.id)}>
          <span>{job.transcript.slice(0, 100)}{job.transcript.length > 100 ? "…" : ""}
            <small>{voiceJobStatus(job.status)}</small></span>
        </button>)}
      </section>}
      <section className="voice-screen-transcript" aria-label="Your transcript">
        <h2>You said</h2>
        <p className={!props.transcript ? "voice-transcript-empty" : undefined} aria-live={props.live ? "polite" : undefined}>{props.transcript || (props.phase === "recording" ? props.live ? "Listening for your words…" : "Recording your voice…" : "No transcript yet. Your words will appear here.")}</p>
        {props.live && props.phase === "recording" && <small>Provisional transcript — not submitted</small>}
      </section>
      <section className="voice-screen-reply" aria-label="Providence reply">
        <h2>Providence</h2>
        {props.replies.length ? props.replies.map(reply => <div key={reply.id}><div className="markdown"><ReactMarkdown>{reply.text}</ReactMarkdown></div>
          {props.playReply && reply.text.trim() && ["completed", "failed", "interrupted", "cancelled"].includes(reply.status) && <button type="button" className="button"
            title={props.muted ? "Unmute replies to play audio" : "Play this reply"} disabled={props.captureBusy || props.speaking || props.muted || !props.connected} onClick={() => props.playReply?.(reply)}><Volume2 size={16} aria-hidden="true" /> Play this reply</button>}
        </div>)
          : <p className="voice-screen-placeholder">{props.phase === "waiting"
            ? props.requestStatus === "needs_input" ? "Review the decision in your workspace."
              : ["failed", "interrupted", "cancelled", "completed"].includes(props.requestStatus ?? "") ? "Check the workspace for this request’s outcome."
              : "Working on your request…"
            : "Your reply will appear here after you send a request."}</p>}
      </section>

    </div>
  </section>;
}
