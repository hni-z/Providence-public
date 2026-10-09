import { readFileSync } from "node:fs";
import ts from "typescript";
import * as voice from "../../web/src/browser-voice.js";
import * as lifecycle from "../../web/src/voice-lifecycle.js";
import * as audio from "../../web/src/server-audio.js";
import * as screen from "../../web/src/voice-screen.js";
import * as ledger from "../../web/src/live-voice-ledger.js";

// Exercise the actual component and its effects without a browser, microphone,
// provider or added DOM dependency. Presentation is a plain element/props object.
const componentSource = ts.transpileModule(readFileSync(new URL("../../web/src/BrowserVoice.tsx", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
export function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export function fakeStream() {
  let stopped = 0;
  return { getTracks: () => [{ stop: () => { stopped++; } }], stopped: () => stopped };
}
export function voiceComponent(patch: Record<string, unknown> = {}) {
  const window = new EventTarget();
  const document = Object.assign(new EventTarget(), { visibilityState: "visible" });
  const media: ReturnType<typeof deferred<ReturnType<typeof fakeStream>>>[] = [];
  const navigator = { language: "en", mediaDevices: { getUserMedia() { const pending = deferred<ReturnType<typeof fakeStream>>(); media.push(pending); return pending.promise; } } };
  class Recorder {
    static isTypeSupported(type: string) { return type === "audio/webm"; }
    mimeType = "audio/webm"; state = "inactive";
    ondataavailable?: (event: { data: Blob }) => void;
    onstop?: () => void; onerror?: () => void;
    start() { this.state = "recording"; }
    stop() { this.state = "inactive"; this.ondataavailable?.({ data: new Blob(["fake recording"], { type: this.mimeType }) }); this.onstop?.(); }
  }
  let cursor = 0, dirty = true, disposed = false;
  let view!: { props: any };
  const slots: any[] = [], effects: (() => void)[] = [];
  const hooks = {
    useRef(initial: unknown) { const index = cursor++; return slots[index] ??= { current: initial }; },
    useState(initial: unknown) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
      return [slots[index], (value: any) => {
        const next = typeof value === "function" ? value(slots[index]) : value;
        if (!Object.is(next, slots[index])) { slots[index] = next; dirty = true; }
      }];
    },
    useEffect(callback: () => void | (() => void), dependencies?: unknown[]) {
      const index = cursor++, previous = slots[index];
      if (previous && dependencies && dependencies.length === previous.dependencies?.length &&
          dependencies.every((value, i) => Object.is(value, previous.dependencies[i]))) return;
      slots[index] = { dependencies, cleanup: previous?.cleanup };
      effects.push(() => { slots[index].cleanup?.(); slots[index].cleanup = callback(); });
    },
    useLayoutEffect(callback: () => void | (() => void), dependencies?: unknown[]) { hooks.useEffect(callback, dependencies); },
  };
  const jsx = (type: unknown, props: unknown) => ({ type, props });
  const modules: Record<string, unknown> = {
    react: hooks, "react/jsx-runtime": { jsx, jsxs: jsx }, "lucide-react": {},
    "./browser-voice": voice, "./voice-lifecycle": lifecycle, "./server-audio": audio,
    "./VoiceScreen": { default: "voice-screen" }, "./voice-screen": screen,
    "./live-voice-capture": { livePcmSupported: () => false }, "./live-voice-session": {}, "./live-voice-ledger": ledger,
  };
  const exports: any = {};
  new Function("require", "exports", "window", "document", "navigator", "MediaRecorder", "globalThis", componentSource)(
    (name: string) => { if (!(name in modules)) throw new Error(`Unexpected component import: ${name}`); return modules[name]; },
    exports, window, document, navigator, Recorder, { isSecureContext: true },
  );
  let props: Record<string, any> = { presentation: "screen", contextKey: "master", configurationKey: "fixture", connected: true,
    outcomes: [], transcribe: async () => "hello", onTranscript: async () => ({ id: "task", requestId: "request", chatId: "master" }), ...patch };
  function render() {
    if (disposed) throw new Error("Component was disposed");
    for (let attempts = 0; dirty; attempts++) {
      if (attempts > 30) throw new Error("Component did not settle");
      cursor = 0; dirty = false; view = exports.default(props);
      for (const effect of effects.splice(0)) effect();
    }
    return view.props;
  }
  return {
    window, document, media, render,
    update(patch: Record<string, unknown>) { props = { ...props, ...patch }; dirty = true; return render(); },
    async settle() { for (let n = 0; n < 8; n++) await Promise.resolve(); return render(); },
    dispose() { disposed = true; for (const slot of slots) slot?.cleanup?.(); },
  };
}
