import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { LiveSessionError } from '../../web/src/live-conversation-client.js';
import { deferred } from './browser-voice-component.js';
const source = ts.transpileModule(readFileSync(new URL('../../web/src/LiveConversation.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
export function liveStream() {
  const track = Object.assign(new EventTarget(), { enabled: true, readyState: 'live', stopped: 0,
    stop() { this.stopped++; this.enabled = false; this.readyState = 'ended'; } });
  return { track, getTracks: () => [track], getAudioTracks: () => [track] };
}
class Clock {
  now = 0; next = 1;
  timers = new Map<number, { at: number; callback: () => void; interval?: number }>();
  set = (callback: () => void, ms = 0) => { const id = this.next++; this.timers.set(id, { at: this.now + ms, callback }); return id; };
  interval = (callback: () => void, ms: number) => { const id = this.set(callback, ms); this.timers.get(id)!.interval = ms; return id; };
  clear = (id: number) => { this.timers.delete(id); };
  tick(ms: number) {
    const until = this.now + ms;
    for (let count = 0; ; count++) {
      if (count > 1000) throw new Error('Unbounded fake timer loop');
      const next = [...this.timers.entries()].filter(([, item]) => item.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [id, item] = next; this.now = item.at;
      if (item.interval) item.at += item.interval; else this.timers.delete(id);
      item.callback();
    }
    this.now = until;
  }
}
/** Actual component/effects, fake media/RTC/network only. No browser permissions or provider calls. */
export function liveComponent(patch: Record<string, unknown> = {}) {
  const window = new EventTarget(), document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const media: ReturnType<typeof deferred<ReturnType<typeof liveStream>>>[] = [];
  const navigator = { mediaDevices: { getUserMedia() { const result = deferred<ReturnType<typeof liveStream>>(); media.push(result); return result.promise; } } };
  const clock = new Clock(), peers: Peer[] = [], audios: Audio[] = [];
  class Channel {
    readyState = 'open'; closed = 0; sent: unknown[] = [];
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null; onerror: (() => void) | null = null;
    send(value: string) { this.sent.push(JSON.parse(value)); }
    message(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
    close() { this.readyState = 'closed'; this.closed++; this.onclose?.(); }
  }
  class Peer extends EventTarget {
    channel = new Channel(); connectionState = 'new'; iceGatheringState = 'complete'; closed = 0;
    localDescription?: { type: string; sdp: string }; remoteDescription?: unknown;
    ontrack: ((event: any) => void) | null = null; onconnectionstatechange: (() => void) | null = null;
    constructor() { super(); peers.push(this); }
    createDataChannel() { return this.channel; } addTrack() {}
    async createOffer() { return { type: 'offer', sdp: 'synthetic-offer' }; }
    async setLocalDescription(value: { type: string; sdp: string }) { this.localDescription = value; }
    async setRemoteDescription(value: unknown) { this.remoteDescription = value; }
    close() { this.closed++; this.connectionState = 'closed'; this.onconnectionstatechange?.(); }
  }
  class Audio {
    autoplay = false; srcObject: unknown = null; pauses = 0; plays = 0;
    constructor() { audios.push(this); } setAttribute() {}
    play() { this.plays++; return Promise.resolve(); } pause() { this.pauses++; }
  }
  const creates: { sdp: unknown; chatId: string; token: string; signal?: AbortSignal; result: ReturnType<typeof deferred<any>> }[] = [];
  const heartbeats: { path: string; token: string }[] = [], ends: { path: string; init: RequestInit }[] = [], active: boolean[] = [];
  let heartbeatError = false, fallbacks = 0;
  const createLiveSession = (token: string, sdp: unknown, chatId: string, signal: AbortSignal) => { const result = deferred<any>(); creates.push({ token, sdp, chatId, signal, result }); return result.promise; };
  const api = (token: string, path: string) => { heartbeats.push({ path, token }); return heartbeatError ? Promise.reject(new Error('synthetic authorization loss')) : Promise.resolve({}); };
  const fetch = (path: string, init: RequestInit) => { ends.push({ path, init }); return Promise.resolve(new Response('{}')); };
  let cursor = 0, dirty = true, disposed = false, view: any;
  const slots: any[] = [], effects: (() => void)[] = [], ref = { current: undefined as any };
  const hooks = {
    forwardRef: (component: any) => component,
    useRef(initial: unknown) { const index = cursor++; return slots[index] ??= { current: initial }; },
    useState(initial: unknown) {
      const index = cursor++; if (!(index in slots)) slots[index] = initial;
      return [slots[index], (value: any) => { const next = typeof value === 'function' ? value(slots[index]) : value; if (!Object.is(next, slots[index])) { slots[index] = next; dirty = true; } }];
    },
    useImperativeHandle(target: any, create: () => unknown) { cursor++; target.current = create(); },
    useEffect(callback: () => void | (() => void), dependencies: unknown[]) {
      const index = cursor++, previous = slots[index];
      if (previous?.dependencies?.length === dependencies.length && dependencies.every((value, i) => Object.is(value, previous.dependencies[i]))) return;
      slots[index] = { dependencies, callback, cleanup: previous?.cleanup };
      effects.push(() => { slots[index].cleanup?.(); slots[index].cleanup = callback(); });
    },
  };
  const jsx = (type: unknown, props: unknown) => ({ type, props });
  const modules: Record<string, unknown> = { react: hooks, 'react/jsx-runtime': { jsx, jsxs: jsx }, 'lucide-react': {},
    './api': { api, sessionCredentials: (token: string) => token === 'providence-account-session' ? 'same-origin' : 'omit' }, './live-conversation-client': { createLiveSession, LiveSessionError } };
  const exports: any = {};
  new Function('require', 'exports', 'window', 'document', 'navigator', 'RTCPeerConnection', 'Audio', 'MediaStream', 'fetch', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', source)(
    (name: string) => { if (!(name in modules)) throw new Error(`Unexpected import ${name}`); return modules[name]; }, exports,
    window, document, navigator, Peer, Audio, class {}, fetch, clock.set, clock.clear, clock.interval, clock.clear);
  let props: Record<string, any> = { token: 'fixture-old-token', chatId: 'master', connected: true,
    onActive: (value: boolean) => active.push(value), onFallback: () => fallbacks++, ...patch };
  function render() {
    if (disposed) return view;
    for (let attempts = 0; dirty; attempts++) {
      if (attempts > 40) throw new Error('Component did not settle');
      cursor = 0; dirty = false; view = exports.default(props, ref);
      for (const effect of effects.splice(0)) effect();
    }
    return view;
  }
  const text = (node: any): string => node == null || typeof node === 'boolean' ? '' : typeof node === 'string' ? node : Array.isArray(node) ? node.map(text).join('') : text(node.props?.children);
  function button(label: string) {
    const visit = (node: any): any => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { for (const child of node) { const found = visit(child); if (found) return found; } return; }
      if (node.type === 'button' && (text(node) === label || node.props['aria-label'] === label)) return node.props;
      return visit(node.props?.children);
    };
    const found = visit(render()); if (!found) throw new Error(`No button ${label}`); return found;
  }
  return {
    clock, window, document, media, peers, audios, creates, ends, heartbeats, active, ref, render, button,
    get phase() { return render()?.props['data-phase'] ?? 'closed'; }, get text() { return text(render()); },
    get fallbacks() { return fallbacks; }, failHeartbeats() { heartbeatError = true; },
    update(patch: Record<string, unknown>) { props = { ...props, ...patch }; dirty = true; return render(); },
    async settle() { for (let i = 0; i < 14; i++) await Promise.resolve(); return render(); },
    strictReplay() { for (const slot of slots) if (slot?.callback) { slot.cleanup?.(); slot.cleanup = slot.callback(); } return render(); },
    dispose() { if (disposed) return; for (const slot of slots) slot?.cleanup?.(); disposed = true; },
  };
}
