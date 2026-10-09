import type { AcceptedVoiceTask, VoiceOutcome } from "./browser-voice.js";
export type WorkspaceView = "voice" | "workspace";
export type VoicePhase = "idle" | "requesting" | "recording" | "ready" | "listening" | "transcribing" | "sending" | "waiting";
export function initialWorkspaceView(search: string): WorkspaceView {
  return new URLSearchParams(search).get("view") === "voice" ? "voice" : "workspace";
}
export function workspaceViewUrl(current: string, view: WorkspaceView): string {
  const url = new URL(current);
  if (view === "workspace") url.searchParams.delete("view");
  else url.searchParams.set("view", view);
  return url.pathname + url.search + url.hash;
}
/** Text follows the acknowledged voice task, never another recent conversation result. */
export function voiceScreenReplies(accepted: AcceptedVoiceTask | undefined, contextKey: string, outcomes: VoiceOutcome[]) {
  if (!accepted || accepted.chatId !== contextKey) return [];
  return outcomes.filter(outcome => outcome.contextKey === contextKey &&
    (outcome.id === accepted.id || (contextKey === "master" && outcome.parentTaskId === accepted.id)));
}
export function voiceScreenState(phase: VoicePhase, speaking: boolean, playing: boolean, hasReply: boolean, requestStatus?: string): string {
  if (speaking) return playing ? "Speaking" : "Preparing reply audio";
  if (phase === "waiting") {
    if (requestStatus === "needs_input") return "Your decision is needed";
    if (requestStatus === "failed") return "Request failed";
    if (requestStatus === "interrupted") return "Request interrupted";
    if (requestStatus === "cancelled") return "Request cancelled";
    if (requestStatus === "completed") return hasReply ? "Reply received" : "Request completed";
    if (requestStatus === "queued") return "Request queued";
    if (!requestStatus && hasReply) return "Reply received";
  }
  return {
    idle: "Ready to listen", requesting: "Allow microphone access", recording: "Recording",
    ready: "Recording ready", listening: "Listening", transcribing: "Transcribing",
    sending: "Sending your request", waiting: "Working",
  }[phase];
}
export type VoiceScreenContext = {
  phase: VoicePhase; speaking: boolean; playing: boolean; recording: boolean; hasReply: boolean;
  requestStatus?: string; live?: boolean; backgroundReady?: boolean; uncertain?: boolean;
  connected: boolean; captureAvailable: boolean; canStart: boolean;
};

/** A working microphone and an available destination are required before we say ready. */
export function voiceScreenGuidance(context: VoiceScreenContext): { status: string; help: string } {
  const { phase, speaking, playing, recording, hasReply, requestStatus } = context;
  const status = voiceScreenState(phase, speaking, playing, hasReply, requestStatus);
  if (speaking) return { status, help: "Tap to stop playback. This stops audio, not the task." };
  if (phase === "recording") return { status: context.live ? "Live transcription" : status,
    help: context.live ? "Your words appear live. Tap to stop and send. Up to 25 seconds." : "Tap to stop and send. Up to 25 seconds." };
  if (phase === "listening") return { status, help: "Your browser sends the final phrase. Tap to cancel listening." };
  if (phase === "requesting") return { status, help: "Approve the microphone prompt in your browser, or discard to cancel." };
  if (phase === "sending" && context.connected) return { status, help: "Waiting for confirmation. Ending voice does not cancel a request that was received." };
  if (context.uncertain) return { status: "Delivery is unconfirmed", help: "Check this request in Workspace before recording again. Nothing was sent again." };
  if (!context.connected) return { status: "Connection lost", help: "Reconnect before recording or playing a reply. Work already sent may still be running." };
  if (phase === "transcribing") return { status: context.live ? "Finalizing transcript" : status,
    help: context.live ? "Waiting for the final transcript. Nothing is submitted from partial text." : "Your transcript appears when transcription finishes." };
  if (phase === "ready") return { status, help: "Your recording is ready. Send it below, or discard it." };
  if (phase === "waiting") {
    if (requestStatus === "needs_input") return { status, help: "Open Workspace to review the decision and continue." };
    if (!voiceRequestFinished(requestStatus, hasReply)) {
      if (context.backgroundReady && context.canStart) return { status: "Ready for another request", help: "Your earlier requests continue below. Tap to record another request." };
      return { status, help: requestStatus === "queued" ? "This request is waiting for earlier work. Follow its progress in Workspace." : "Your request continues in this conversation. You can follow it in Workspace." };
    }
    return { status, help: context.canStart ? "Tap for another request, or review this result in Workspace." : "Review this result in Workspace. Voice is not ready for another request yet." };
  }
  if (!context.captureAvailable) return { status: "Voice input unavailable", help: "You can still send typed messages in Workspace. Check your browser microphone and voice setup." };
  if (!context.canStart) return { status: "Voice is not ready", help: "Check the selected conversation above, or open Workspace to continue." };
  return { status, help: recording ? "Tap the microphone to record. Tap again to stop and send." : "Tap the microphone to speak. Your browser sends the final phrase." };
}

export function voiceSessionControl(phase: VoicePhase, captureBusy: boolean, speaking: boolean, finished: boolean) {
  if (phase === "sending" || (phase === "waiting" && !speaking && !finished)) return "end";
  if (captureBusy) return "discard";
  return undefined;
}

export function voiceJobStatus(status: string): string {
  return ({ accepted: "Received", queued: "Queued: waiting for earlier work", pending: "Pending", running: "Working",
    completed: "Completed", failed: "Failed", interrupted: "Interrupted", cancelled: "Cancelled", needs_input: "Needs your decision" } as Record<string, string>)[status] ?? "Status unavailable";
}
export function voiceRequestFinished(status?: string, hasReply = false): boolean {
  return ["completed", "failed", "interrupted", "cancelled"].includes(status ?? "") || (status === undefined && hasReply);
}
export function voiceCircleAction(phase: VoicePhase, speaking: boolean, recording: boolean, requestFinished = false) {
  if (speaking) return { action: "stop_playback", label: "Stop reply audio" } as const;
  if (phase === "recording") return { action: "send_recording", label: "Stop and send recording" } as const;
  if (phase === "listening") return { action: "discard", label: "Cancel listening" } as const;
  if (phase === "idle" || (phase === "waiting" && requestFinished))
    return { action: "start", label: recording ? "Start recording" : "Start listening" } as const;
  return { action: "none", label: phase === "ready" ? "Recording ready to send" : "Voice is busy" } as const;
}
export function activateVoiceCircle(phase: VoicePhase, speaking: boolean, recording: boolean, canStart: boolean,
  actions: { start: () => void; sendRecording: () => void; stopPlayback: () => void; stop: () => void }, requestFinished = false) {
  const action = voiceCircleAction(phase, speaking, recording, requestFinished).action;
  if (action === "start" && canStart) actions.start();
  else if (action === "send_recording") actions.sendRecording();
  else if (action === "stop_playback") actions.stopPlayback();
  else if (action === "discard") actions.stop();
}
