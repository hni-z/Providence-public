import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Coordinator } from "../src/coordinator.js";
import { createHttpServer } from "../src/server.js";
import { Store } from "../src/store.js";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "providence-optional-voice-"));
  const input = join(directory, "input.env");
  const output = join(directory, "output.env");
  const alternate = join(directory, "alternate-output.env");
  writeFileSync(input, "OPENAI_API_KEY=fixture-only-openai-credential\n", { mode: 0o600 });
  writeFileSync(output, "ELEVENLABS_API_KEY=fixture-only-elevenlabs-credential\n", { mode: 0o600 });
  writeFileSync(alternate, "ELEVENLABS_API_KEY=fixture-only-alternate-credential\n", { mode: 0o600 });
  return { directory, input, output, alternate,
    missingInput: join(directory, "missing-input.env"),
    missingOutput: join(directory, "missing-output.env"),
    cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test("unreadable output disables speech without borrowing valid alternate files or ambient keys", () => {
  const f = fixture();
  try {
    // The child receives only synthetic keys; no real ambient provider key is read or changed.
    const script = `
      import assert from 'node:assert/strict';
      import {Speech, SpeechError, MAX_SPEECH_AUDIO_BYTES} from ${JSON.stringify(new URL("../src/speech.ts", import.meta.url).href)};
      const diagnostics=[]; console.error=message=>diagnostics.push(String(message));
      const shared=${JSON.stringify({ speechEnvFile: f.missingOutput, transcriptionEnvFile: f.input,
        elevenLabsEnvFile: f.alternate, elevenLabsVoiceId: "fixtureVoice" })};
      let providerCalls=0;
      for(const selected of ['openai','elevenlabs']) {
        const speech=new Speech({...shared,speechProvider:selected},async()=>{providerCalls++;throw new Error('Provider must not run');});
        assert.equal(speech.configured,false);
        assert.equal(speech.provider,selected==='openai'?'OpenAI':'ElevenLabs');
        assert.equal(speech.voice,selected==='openai'?'marin':'fixtureVoice');
        assert.equal(speech.unavailableReason,'provider_not_configured');
        await assert.rejects(speech.synthesize({requestId:selected,text:'Fixture reply'}),e=>e instanceof SpeechError&&e.status===503);
      }
      assert.equal(providerCalls,0);assert.equal(MAX_SPEECH_AUDIO_BYTES,4194304);
      assert.equal(diagnostics.length,2);
      assert.equal(diagnostics.some(value=>value.includes('fixture-only')||value.includes(${JSON.stringify(f.directory)})),false);
      console.log(JSON.stringify({providerCalls,disabledProviders:2}));
    `;
    const result = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
        OPENAI_API_KEY: "fixture-only-ambient-openai-key", ELEVENLABS_API_KEY: "fixture-only-ambient-elevenlabs-key" },
      encoding: "utf8", timeout: 10_000,
    });
    assert.deepEqual(JSON.parse(result), { providerCalls: 0, disabledProviders: 2 });
  } finally { f.cleanup(); }
});

for (const broken of ["input", "output", "both"] as const) {
  test(`unreadable ${broken} voice files preserve authenticated existing-chat dispatch and dedupe`, async (t) => {
    const f = fixture();
    let server: ReturnType<typeof createHttpServer> | undefined;
    try {
      // Persist an existing chat before constructing the coordinator under test.
      const saved = new Store(join(f.directory, "state.json"));
      const chat = saved.addChat("Fixture Watch", "mac", "fixture-existing-provider-thread");
      chat.history.push({ role: "assistant", text: "Prior fixture result", taskId: "fixture-prior-task" });
      saved.save();
      saved.stop();
      const priorChat = structuredClone(chat);
      const config = {
        clientToken: "c".repeat(64), localDeviceId: "mac", localDeviceName: "Fixture Mac",
        workspace: f.directory, devices: [],
        transcriptionProvider: "openai" as const, speechProvider: "elevenlabs" as const,
        transcriptionEnvFile: broken === "output" ? f.input : f.missingInput,
        transcriptionModel: "gpt-4o-mini-transcribe",
        speechEnvFile: broken === "input" ? f.output : f.missingOutput,
        elevenLabsEnvFile: f.alternate, elevenLabsVoiceId: "fixtureVoice",
      };
      const warnings: string[] = [];
      t.mock.method(console, "error", (message: unknown) => warnings.push(String(message)));
      const app = new Coordinator(config, f.directory);
      assert.deepEqual(app.chat(chat.id), priorChat);
      const hasInput = app.devices.local.hasTranscription;
      assert.equal(hasInput, broken === "output");
      let dispatches = 0;
      app.devices.local.rpc.call = async () => { throw new Error("Native runtime must not start in this fixture"); };
      app.master.rpc.call = async () => { throw new Error("Master runtime must not start in this fixture"); };
      app.devices.online = id => id === "mac";
      app.devices.list = () => [{ id: "mac", name: "Fixture Mac", local: true, online: true,
        connectionStatus: { state: "online", reasonCode: "ready" },
        connectionState: "online", capabilities: { files: true, shell: true, browser: false,
          desktop: false, phoneMirroring: false, transcription: hasInput },
        ...(hasInput ? { transcriptionProvider: "OpenAI" as const } : {}) }];
      app.devices.call = async (deviceId, method, params) => {
        assert.equal(deviceId, "mac"); assert.equal(method, "task.start");
        assert.equal(params.threadId, priorChat.threadId);
        dispatches++;
        return { turnId: "fixture-turn" };
      };
      server = createHttpServer(app, config.clientToken, { publicOrigin: "https://fixture.example" });
      await new Promise<void>(done => server!.listen(0, "127.0.0.1", done));
      const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const realFetch = globalThis.fetch;
      let providerCalls = 0;
      t.mock.method(globalThis, "fetch", async (url: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1]) => {
        if (!String(url).startsWith(origin + "/")) {
          providerCalls++;
          throw new Error("External requests are forbidden in this fixture");
        }
        return realFetch(url, options);
      });
      const headers = { Authorization: `Bearer ${config.clientToken}`, "Content-Type": "application/json" };
      assert.equal((await fetch(origin + "/health")).status, 200);
      assert.equal((await fetch(origin + "/v1/voice")).status, 401);
      const route = origin + `/v1/chats/${chat.id}/messages`;
      const body = JSON.stringify({ requestId: "fixture-text-once", text: "Inspect fixture" });
      assert.equal((await fetch(route, { method: "POST", body })).status, 401);
      assert.equal((await fetch(route, { method: "POST", body, headers: { ...headers, Origin: "https://untrusted.example" } })).status, 403);
      assert.equal(dispatches, 0);
      const voice = await (await fetch(origin + "/v1/voice", { headers })).json();
      assert.equal(voice.provider, "ElevenLabs");
      assert.equal(voice.speechConfigured, broken === "input");
      assert.equal(voice.configured, broken === "input");
      assert.equal(voice.transcriptionConfigured, broken === "output");
      assert.equal(voice.maxSpeechAudioBytes, 4 * 1024 * 1024);
      assert.equal(voice.maxAudioBytes, 512 * 1024);
      assert.equal(JSON.stringify(voice).includes(f.directory), false);
      assert.equal(JSON.stringify(voice).includes("fixture-only"), false);
      if (broken !== "input") {
        const unavailable = await fetch(origin + "/v1/speech", { method: "POST", headers,
          body: JSON.stringify({ requestId: "disabled-speech", text: "Fixture reply" }) });
        assert.equal(unavailable.status, 503);
        assert.equal((await unavailable.text()).includes(f.directory), false);
      }
      if (!hasInput) {
        const unavailable = await fetch(origin + "/v1/transcriptions", { method: "POST", headers,
          body: JSON.stringify({ requestId: "disabled-input", deviceId: "mac", mimeType: "audio/wav", base64: "YQ==" }) });
        assert.equal(unavailable.status, 503);
      }
      const accepted = await fetch(route, { method: "POST", headers, body });
      assert.equal(accepted.status, 202);
      const task = await accepted.json();
      app.event("mac", { type: "task.completed", taskId: task.id, text: "Fixture action completed" });
      const repeated = await (await fetch(route, { method: "POST", headers, body })).json();
      assert.equal(repeated.id, task.id);
      assert.equal(repeated.status, "completed");
      assert.equal(repeated.deviceId, "mac");
      assert.equal(dispatches, 1);
      assert.equal(app.chat(chat.id).threadId, priorChat.threadId);
      assert.deepEqual(app.chat(chat.id).history.slice(0, priorChat.history.length), priorChat.history);
      assert.equal(app.chat(chat.id).history.length, priorChat.history.length + 2);
      assert.equal(Object.keys(app.store.state.chats).length, 1);
      assert.equal(Object.keys(app.store.state.tasks).length, 1);
      assert.equal(providerCalls, 0);
      assert.equal(warnings.some(value => value.includes("fixture-only") || value.includes(f.directory)), false);
    } finally {
      if (server?.listening) await new Promise<void>(done => server!.close(() => done()));
      f.cleanup();
    }
  });
}
