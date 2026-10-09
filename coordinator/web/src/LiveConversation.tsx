import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { AudioLines, LoaderCircle, Mic, MicOff, PhoneOff } from "lucide-react";
import { api, sessionCredentials } from "./api";
import { createLiveSession, LiveSessionError } from "./live-conversation-client";

export type LiveConversationHandle = { start(): void; end(): void };
type Connection = {
  peer: RTCPeerConnection; channel: RTCDataChannel; stream: MediaStream; audio: HTMLAudioElement;
  abort: AbortController; token: string; version: number; chatId: string;
  sessionId?: string; closed: boolean; ending: boolean; muted: boolean; endSent: boolean;
  started: boolean; heartbeat?: ReturnType<typeof setInterval>; drain?: ReturnType<typeof setTimeout>;
};
type StartAttempt = { version: number; abort: AbortController; timer?: ReturnType<typeof setTimeout> };
export const LIVE_STARTUP_MS = 45_000;
export const LIVE_CLOSE_GRACE_MS = 3_000;

/** Only media and captions live here. Authenticated server-side tools own all device work. */
export default forwardRef<LiveConversationHandle, {
  token: string; chatId: string; connected: boolean; onActive: (active: boolean) => void;
  onFallback: () => void;
}>(function LiveConversation(props, ref) {
  const [phase, setPhase] = useState<"closed" | "starting" | "live" | "ending" | "error">("closed");
  const [error, setError] = useState("");
  const [accountHelp, setAccountHelp] = useState(false);
  const [muted, setMuted] = useState(false);
  const [captions, setCaptions] = useState({ user: "", assistant: "" });
  const active = useRef<Connection | undefined>(undefined);
  const starting = useRef<StartAttempt | undefined>(undefined);
  const generation = useRef(0);
  const mounted = useRef(false);
  const current = useRef(props); current.current = props;

  function owns(connection: Connection) {
    return mounted.current && active.current === connection && generation.current === connection.version &&
      current.current.chatId === connection.chatId && current.current.token === connection.token;
  }
  function stopMicrophone(connection: Connection) {
    connection.stream.getTracks().forEach(track => { track.enabled = false; track.stop(); });
    connection.audio.pause(); connection.audio.srcObject = null;
  }
  function release(connection: Connection) {
    if (connection.closed) return;
    connection.closed = true;
    clearInterval(connection.heartbeat); clearTimeout(connection.drain);
    connection.abort.abort();
    stopMicrophone(connection);
    connection.channel.onmessage = null; connection.channel.onclose = null; connection.channel.onerror = null;
    connection.peer.ontrack = null; connection.peer.onconnectionstatechange = null;
    try { connection.channel.close(); } catch { /* Release the owned peer too. */ }
    try { connection.peer.close(); } catch { /* Already closed. */ }
    if (active.current === connection) active.current = undefined;
  }
  function endServer(connection: Connection) {
    if (!connection.sessionId || connection.endSent) return;
    connection.endSent = true;
    // Use this connection's identity, even if sign-in or chat changed while it was starting.
    void fetch(`/v1/live-voice/sessions/${encodeURIComponent(connection.sessionId)}/end`, {
      method: "POST", credentials: sessionCredentials(connection.token), mode: "same-origin", redirect: "error",
      referrerPolicy: "same-origin", headers: { "Content-Type": "application/json", Authorization: `Bearer ${connection.token}` },
      body: "{}", keepalive: true, signal: AbortSignal.timeout(5000),
    }).catch(() => {});
  }
  function clearStarting() {
    const attempt = starting.current;
    if (attempt) { clearTimeout(attempt.timer); attempt.abort.abort(); starting.current = undefined; }
  }
  function closed(connection: Connection, confirmed: boolean) {
    if (connection.closed) return;
    const update = owns(connection);
    endServer(connection); release(connection);
    if (update) {
      setMuted(false); current.current.onActive(false);
      setPhase(confirmed ? "closed" : "error");
      if (!confirmed) setError("Microphone is off. Voice finalization was not confirmed; your submitted work remains in this chat.");
    }
  }
  function finish(detach = false) {
    const connection = active.current;
    clearStarting();
    if (!connection || !connection.started || detach) {
      generation.current++;
      if (connection) {
        connection.ending = true; stopMicrophone(connection);
        if (connection.channel.readyState === "open") {
          try { connection.channel.send(JSON.stringify({ type: "session.close" })); } catch { /* Server cleanup below. */ }
        }
        endServer(connection); release(connection);
      }
      current.current.onActive(false);
      if (mounted.current) { setPhase("closed"); setMuted(false); }
      return;
    }
    if (connection.ending) return;
    connection.ending = true;
    clearInterval(connection.heartbeat);
    stopMicrophone(connection);
    if (mounted.current) { setPhase("ending"); setMuted(true); setError(""); }
    // The listener already exists. Keep WebRTC open for the terminal event, but
    // never keep recording while it drains. Silence is not a close/approval signal.
    connection.drain = setTimeout(() => closed(connection, false), LIVE_CLOSE_GRACE_MS);
    if (connection.channel.readyState !== "open") { closed(connection, false); return; }
    try { connection.channel.send(JSON.stringify({ type: "session.close" })); }
    catch { closed(connection, false); }
  }
  async function start() {
    if (!mounted.current || active.current || starting.current || !current.current.connected || document.visibilityState === "hidden") return;
    const version = ++generation.current, token = current.current.token, chatId = current.current.chatId;
    const attempt: StartAttempt = { version, abort: new AbortController() };
    starting.current = attempt;
    const valid = () => mounted.current && version === generation.current && current.current.connected &&
      current.current.chatId === chatId && current.current.token === token && document.visibilityState !== "hidden";
    setPhase("starting"); setError(""); setAccountHelp(false); setMuted(false); setCaptions({ user: "", assistant: "" }); current.current.onActive(true);
    let stream: MediaStream | undefined, connection: Connection | undefined, preparedPeer: RTCPeerConnection | undefined;
    const fail = (message: string, help = false) => {
      if (connection?.closed || connection?.ending || !valid()) return;
      generation.current++;
      if (starting.current === attempt) clearStarting();
      if (connection) { endServer(connection); release(connection); }
      else { stream?.getTracks().forEach(track => track.stop()); preparedPeer?.close(); }
      setError(message); setAccountHelp(help); setPhase("error"); current.current.onActive(false);
    };
    // Includes a permission dialog left unanswered, SDP setup, and session.started.
    attempt.timer = setTimeout(() => fail("Voice took too long to connect. Try again or send a voice message."), LIVE_STARTUP_MS);
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === "undefined") throw new Error("unavailable");
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      stream.getTracks().forEach(track => { track.enabled = false; });
      if (!valid() || starting.current !== attempt) { stream.getTracks().forEach(track => track.stop()); return; }
      const peer = new RTCPeerConnection();
      preparedPeer = peer;
      const audio = new Audio(); audio.autoplay = true; audio.setAttribute("playsinline", "");
      const channel = peer.createDataChannel("oai-events");
      connection = { peer, channel, stream, audio, abort: attempt.abort, token, chatId, version,
        closed: false, ending: false, started: false, muted: false, endSent: false };
      active.current = connection;
      const owned = connection;
      stream.getTracks().forEach(track => {
        track.addEventListener("ended", () => { if (!owned.ending) fail("Microphone disconnected. Reconnect when ready."); }, { once: true });
        peer.addTrack(track, stream!);
      });
      peer.ontrack = event => {
        if (owned.closed || owned.ending || !valid()) { event.track.stop(); return; }
        audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
        void audio.play().catch(() => { if (valid() && !owned.closed && !owned.ending) setError("Tap Resume audio to hear Providence."); });
      };
      channel.onmessage = event => {
        if (owned.closed) return;
        let message: any; try { message = JSON.parse(event.data); } catch { return; }
        if (!message || typeof message !== "object") return;
        if (message.type === "session.closed") { clearStarting(); closed(owned, true); return; }
        if (!valid() || owned.ending) return;
        if (message.type === "session.started") {
          // The gateway's session ID is an application control handle. The
          // provider's session.started ID is different; the owned channel binds it.
          owned.started = true; clearTimeout(attempt.timer);
          if (starting.current === attempt) starting.current = undefined;
          owned.stream.getAudioTracks().forEach(track => { track.enabled = !owned.muted; });
          setPhase("live");
        } else if (message.type === "session.input_transcript.delta" || message.type === "session.output_transcript.delta") {
          if (typeof message.delta !== "string") return;
          const speaker = message.type === "session.input_transcript.delta" ? "user" : "assistant";
          setCaptions(previous => ({ ...previous, [speaker]: (previous[speaker] + message.delta).slice(-1400) }));
        } else if (message.type === "error") fail("Live voice stopped unexpectedly. Your submitted work is still in this chat.");
      };
      channel.onclose = () => { if (owned.ending) closed(owned, false); else fail("Voice connection ended. You can reconnect when ready."); };
      channel.onerror = () => { if (owned.ending) closed(owned, false); else fail("Voice connection was interrupted. Reconnect to continue speaking."); };
      peer.onconnectionstatechange = () => {
        if (["failed", "disconnected", "closed"].includes(peer.connectionState)) {
          if (owned.ending) closed(owned, false);
          else fail("Voice connection was interrupted. Reconnect to continue speaking.");
        }
      };
      const offer = await peer.createOffer();
      if (!valid() || owned.closed) return;
      await peer.setLocalDescription(offer);
      if (!valid() || owned.closed) return;
      if (peer.iceGatheringState !== "complete") await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { cleanup(); reject(new Error("ice_timeout")); }, 8000);
        const cleanup = () => { clearTimeout(timer); peer.removeEventListener("icegatheringstatechange", ready); owned.abort.signal.removeEventListener("abort", cancelled); };
        const ready = () => { if (peer.iceGatheringState === "complete") { cleanup(); resolve(); } };
        const cancelled = () => { cleanup(); reject(new DOMException("Voice ended", "AbortError")); };
        peer.addEventListener("icegatheringstatechange", ready); owned.abort.signal.addEventListener("abort", cancelled, { once: true });
        if (owned.abort.signal.aborted) cancelled(); else ready();
      });
      if (!valid() || owned.closed) return;
      const result = await createLiveSession(token, peer.localDescription?.sdp, chatId, owned.abort.signal);
      if (typeof result.session?.id !== "string" || !result.session.id) throw new Error("invalid_session");
      owned.sessionId = result.session.id;
      if (!valid() || owned.closed) { endServer(owned); return; }
      if (result.transport?.type !== "webrtc" || typeof result.transport.sdp !== "string") throw new Error("invalid_transport");
      await peer.setRemoteDescription({ type: "answer", sdp: result.transport.sdp });
      if (!valid() || owned.closed || owned.ending) return;
      owned.heartbeat = setInterval(() => {
        if (owned.closed || owned.ending || !valid()) return;
        void api(token, `/live-voice/sessions/${encodeURIComponent(result.session.id)}/heartbeat`, {}, undefined, owned.abort.signal)
          .catch(() => fail("Voice authorization could not be refreshed. Reconnect to continue."));
      }, 10000);
    } catch (cause) {
      if (!valid()) {
        if (connection) { endServer(connection); release(connection); }
        else { stream?.getTracks().forEach(track => track.stop()); preparedPeer?.close(); }
        return;
      }
      const denied = cause instanceof DOMException && ["NotAllowedError", "SecurityError"].includes(cause.name);
      fail(denied ? "Allow microphone access in your browser or iPhone Settings to talk to Providence."
        : cause instanceof LiveSessionError ? cause.message : "Live voice could not connect. Try again or send a voice message.",
        cause instanceof LiveSessionError && cause.accountHelp);
    }
  }
  function toggleMute() {
    const connection = active.current;
    if (!connection || connection.closed || connection.ending || !connection.started) return;
    connection.muted = !connection.muted;
    connection.stream.getAudioTracks().forEach(track => { track.enabled = !connection.muted; });
    setMuted(connection.muted);
    if (connection.channel.readyState === "open") {
      try { connection.channel.send(JSON.stringify({ type: connection.muted ? "session.input_audio.mute" : "session.input_audio.unmute" })); }
      catch { finish(); }
    }
  }
  useImperativeHandle(ref, () => ({ start: () => { void start(); }, end: () => finish() }));
  useEffect(() => {
    mounted.current = true; setPhase("closed"); setMuted(false); setError("");
    const leave = () => finish(true);
    const hidden = () => { if (document.visibilityState === "hidden") leave(); };
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", leave); window.addEventListener("offline", leave);
    return () => { mounted.current = false; finish(true); document.removeEventListener("visibilitychange", hidden); window.removeEventListener("pagehide", leave); window.removeEventListener("offline", leave); };
  }, [props.chatId, props.token]);
  useEffect(() => { if (!props.connected) finish(true); }, [props.connected]);
  if (phase === "closed") return null;
  return <section className="live-conversation" aria-label="Live voice conversation" data-phase={phase}>
    <div className="live-conversation-top"><span className={`live-voice-orb ${phase === "live" && !muted ? "is-live" : ""}`} aria-hidden="true">{phase === "starting" || phase === "ending" ? <LoaderCircle className="spin" size={21} /> : <AudioLines size={23} />}</span>
      <div><strong role="status">{phase === "starting" ? "Connecting voice…" : phase === "ending" ? "Ending voice… Microphone is off." : phase === "error" ? "Voice is off" : muted ? "Microphone muted" : "Listening. Go ahead."}</strong><small>AI voice · Your work continues in this chat</small></div>
      <button type="button" className="icon-button" aria-label="End voice conversation" onClick={() => finish()}><PhoneOff size={18} /></button>
    </div>
    {phase === "live" && <div className="live-conversation-actions"><button type="button" className="button" aria-pressed={muted} onClick={toggleMute}>{muted ? <Mic size={16} /> : <MicOff size={16} />}{muted ? "Unmute" : "Mute"}</button><span>Ask for an update any time.</span></div>}
    {error && <div className="live-conversation-error" role="alert"><p>{error}</p>{accountHelp && <a className="button" href="/account#account-key">Account &amp; API billing</a>}{phase === "live" ? <button className="button" onClick={() => {
      const connection = active.current;
      if (connection) void connection.audio.play().then(() => { if (owns(connection) && !connection.ending) setError(""); }, () => {});
    }}>Resume audio</button> : <div><button className="button" onClick={() => void start()}>Try again</button><button className="button" onClick={() => { finish(true); current.current.onFallback(); }}>Send a voice message</button></div>}</div>}
    {(captions.user || captions.assistant) && <details className="live-captions"><summary>Live captions</summary>{captions.user && <p><b>You</b>{captions.user}</p>}{captions.assistant && <p><b>Providence</b>{captions.assistant}</p>}</details>}
  </section>;
});
