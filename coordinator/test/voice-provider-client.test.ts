import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  parseVoiceConfig,
  voiceProviderLabel,
  voiceConfigurationIdentity,
  noVoiceConfig,
  voiceConfigAfterLookup,
  voiceConfigAfterFailedLookup,
} from "../web/src/voice-config.js";
import {
  ServerSpeechPlayer,
  SpeechPlaybackError,
  readSpeechAudio,
  MAX_SPEECH_BYTES,
} from "../web/src/server-audio.js";
import type {
  PlaybackAudio,
  SpeechPlaybackEnvironment,
} from "../web/src/server-audio.js";
import {
  createVoiceSpeechPlayer,
  loadVoiceConfig,
} from "../web/src/voice-api.js";
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const config = {
  configured: true,
  provider: "OpenAI",
  voice: "marin",
  deviceId: "mac",
  maxSpeechChars: 4000,
  maxAudioBytes: 524288,
};
const audioBlob = () => new Blob(["fake audio"], { type: "audio/mpeg" });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function flush() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
class FakeAudio implements PlaybackAudio {
  onended: ((...args: any[]) => void) | null = null;
  onerror: ((...args: any[]) => void) | null = null;
  pauses = 0;
  removed = false;
  constructor(readonly rejectPlay: boolean) {}
  play() {
    return this.rejectPlay
      ? Promise.reject(new Error("blocked"))
      : Promise.resolve();
  }
  pause() {
    this.pauses++;
  }
  removeAttribute() {
    this.removed = true;
  }
}
function media() {
  let blocked = false,
    failConstruction = false,
    nextTimer = 0;
  const instances: FakeAudio[] = [],
    revoked: string[] = [],
    timers = new Map<number, () => void>();
  const environment: SpeechPlaybackEnvironment = {
    createUrl: () => `blob:fixture-${instances.length}`,
    revokeUrl: (url) => {
      revoked.push(url);
    },
    createAudio: () => {
      if (failConstruction) throw new Error("no audio element");
      const audio = new FakeAudio(blocked);
      instances.push(audio);
      return audio;
    },
    setTimer: (callback) => {
      const id = ++nextTimer;
      timers.set(id, callback);
      return id;
    },
    clearTimer: (id) => {
      timers.delete(id as number);
    },
  };
  return {
    environment,
    instances,
    revoked,
    timers,
    block: (value: boolean) => {
      blocked = value;
    },
    failConstruction: (value: boolean) => {
      failConstruction = value;
    },
  };
}

test("voice metadata preserves independent input/output providers, legacy flags and nullable voice IDs", () => {
  const legacy = parseVoiceConfig(config);
  assert.equal(legacy.speechConfigured, true);
  assert.equal(legacy.transcriptionConfigured, true);
  assert.equal(legacy.transcriptionProvider, "OpenAI");
  assert.equal(voiceProviderLabel(legacy), "OpenAI voice");
  const mixed = parseVoiceConfig({
    ...config,
    provider: "ElevenLabs",
    voice: "fixture-account-voice",
    speechConfigured: true,
    transcriptionConfigured: true,
    transcriptionProvider: "OpenAI",
  });
  assert.equal(
    voiceProviderLabel(mixed),
    "OpenAI transcription · ElevenLabs replies",
  );
  const inputOnly = parseVoiceConfig({
    ...config,
    configured: false,
    provider: "ElevenLabs",
    voice: null,
    speechConfigured: false,
    transcriptionConfigured: true,
    transcriptionProvider: "ElevenLabs",
    reason: "voice_id_required",
  });
  assert.equal(inputOnly.voice, null);
  assert.equal(inputOnly.transcriptionConfigured, true);
  assert.equal(
    voiceProviderLabel(inputOnly),
    "ElevenLabs transcription · Browser replies",
  );
  const outputOnly = parseVoiceConfig({
    ...config,
    provider: "ElevenLabs",
    voice: "fixture-voice",
    speechConfigured: true,
    transcriptionConfigured: false,
    transcriptionProvider: "ElevenLabs",
  });
  assert.equal(
    voiceProviderLabel(outputOnly),
    "Browser transcription · ElevenLabs replies",
  );
  assert.throws(() =>
    parseVoiceConfig({ ...config, provider: "Unrecognized" }),
  );
  assert.throws(() => parseVoiceConfig({ ...config, speechConfigured: "yes" }));
  assert.notEqual(
    voiceConfigurationIdentity(mixed),
    voiceConfigurationIdentity({ ...mixed, voice: "other-voice" }),
  );
  assert.notEqual(
    voiceConfigurationIdentity(mixed),
    voiceConfigurationIdentity({
      ...mixed,
      transcriptionProvider: "ElevenLabs",
    }),
  );
  assert.ok(
    !JSON.stringify(
      parseVoiceConfig({ ...config, apiKey: "must-never-be-retained" }),
    ).includes("must-never"),
  );
});

test("voice discovery and speech use only authenticated same-origin contracted request fields", async () => {
  const calls: { path: string; body: any }[] = [];
  globalThis.fetch = async (path, init) => {
    assert.equal(
      new Headers(init?.headers).get("Authorization"),
      "Bearer test-only",
    );
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.mode, "same-origin");
    assert.equal(init?.redirect, "error");
    calls.push({
      path: String(path),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return String(path).endsWith("/voice")
      ? new Response(
          JSON.stringify({
            ...config,
            provider: "ElevenLabs",
            voice: "fixture-voice",
            speechConfigured: true,
            transcriptionConfigured: true,
            transcriptionProvider: "ElevenLabs",
          }),
          { headers: { "Content-Type": "application/json" } },
        )
      : new Response("fake audio", {
          headers: { "Content-Type": "audio/mpeg" },
        });
  };
  const controller = new AbortController();
  assert.equal(
    (await loadVoiceConfig("test-only", controller.signal)).provider,
    "ElevenLabs",
  );
  const m = media();
  const player = createVoiceSpeechPlayer("test-only", m.environment);
  const playing = player.play(
    "accepted-task",
    "Actual fresh reply",
    controller.signal,
  );
  await flush();
  m.instances[0].onended!();
  await playing;
  assert.deepEqual(Object.keys(calls[1].body).sort(), ["requestId", "text"]);
  assert.equal(calls[1].body.text, "Actual fresh reply");
  assert.deepEqual(
    calls.map((call) => call.path),
    ["/v1/voice", "/v1/speech"],
  );
  player.clear();
});

test("server speech downloads once and explicit playback retry reuses the same bytes", async () => {
  const m = media();
  m.block(true);
  let downloads = 0;
  const player = new ServerSpeechPlayer(
    async () => {
      downloads++;
      return audioBlob();
    },
    m.environment,
    () => "stable-speech-request",
  );
  const controller = new AbortController();
  await assert.rejects(
    player.play("context:task", "Original reply", controller.signal),
    (error) => error instanceof SpeechPlaybackError && error.canReplay,
  );
  assert.equal(downloads, 1);
  assert.equal(player.hasAudio("context:task", "Original reply"), true);
  assert.equal(player.canPlay("context:task", "Original reply"), true);
  assert.equal(m.revoked.length, 1);
  m.block(false);
  const retry = player.play(
    "context:task",
    "Original reply",
    controller.signal,
  );
  await flush();
  m.instances[1].onended!();
  await retry;
  assert.equal(downloads, 1);
  assert.equal(m.revoked.length, 2);
  assert.equal(m.timers.size, 0);
  assert.ok(m.instances.every((instance) => instance.removed));
  await assert.rejects(
    player.play("context:task", "Changed reply", controller.signal),
    /identity has changed/,
  );
  assert.equal(downloads, 1);
  player.clear();
});

test("unknown provider failure is not retried or silently replaced with browser playback", async () => {
  const m = media();
  let downloads = 0;
  const player = new ServerSpeechPlayer(async () => {
    downloads++;
    throw new Error("network outcome unknown");
  }, m.environment);
  const signal = new AbortController().signal;
  await assert.rejects(
    player.play("task", "Reply", signal),
    (error) => error instanceof SpeechPlaybackError && !error.canReplay,
  );
  await assert.rejects(player.play("task", "Reply", signal), /not sent again/);
  assert.equal(downloads, 1);
  assert.equal(m.instances.length, 0);
  assert.equal(player.canPlay("task", "Reply"), false);
  player.clear();
});

test("a refused speech request stays replayable under a fresh identity while an unknown outcome stays poisoned", async () => {
  const m = media();
  const requestIds: string[] = [];
  let status = 409;
  globalThis.fetch = async (_path, init) => {
    requestIds.push(JSON.parse(String(init!.body)).requestId);
    return status === 200
      ? new Response("fake audio", { headers: { "Content-Type": "audio/mpeg" } })
      : new Response(
          JSON.stringify({ error: "A voice reply is already being generated." }),
          { status, headers: { "Content-Type": "application/json" } },
        );
  };
  const signal = new AbortController().signal;
  const player = createVoiceSpeechPlayer("test-only", m.environment);
  await assert.rejects(
    player.play("context:task", "Fresh reply", signal),
    (error) => error instanceof SpeechPlaybackError && error.canReplay,
  );
  assert.equal(player.hasAudio("context:task", "Fresh reply"), false);
  assert.equal(player.canPlay("context:task", "Fresh reply"), true);
  status = 200;
  const retry = player.play("context:task", "Fresh reply", signal);
  await flush();
  m.instances[0].onended!();
  await retry;
  assert.equal(requestIds.length, 2);
  assert.notEqual(requestIds[0], requestIds[1]);
  player.clear();
  status = 502;
  const poisoned = createVoiceSpeechPlayer("test-only", m.environment);
  await assert.rejects(
    poisoned.play("context:task", "Fresh reply", signal),
    (error) => error instanceof SpeechPlaybackError && !error.canReplay,
  );
  assert.equal(poisoned.canPlay("context:task", "Fresh reply"), false);
  await assert.rejects(
    poisoned.play("context:task", "Fresh reply", signal),
    /not sent again/,
  );
  assert.equal(requestIds.length, 3);
  poisoned.clear();
});

test("stop/context/logout invalidation suppresses late audio without losing a server task or posting another request", async () => {
  const m = media(),
    pending = deferred<Blob>();
  let downloads = 0;
  const player = new ServerSpeechPlayer(async () => {
    downloads++;
    return pending.promise;
  }, m.environment);
  const controller = new AbortController();
  const playing = player.play("old-chat:task", "Old reply", controller.signal);
  const rejection = assert.rejects(playing, { name: "AbortError" });
  player.clear();
  pending.resolve(audioBlob());
  await rejection;
  assert.equal(m.instances.length, 0);
  assert.equal(player.hasAudio("old-chat:task", "Old reply"), false);
  assert.equal(downloads, 1);
});

test("cancelling cached playback pauses audio, revokes its URL and never reloads provider audio", async () => {
  const m = media();
  let downloads = 0;
  const player = new ServerSpeechPlayer(async () => {
    downloads++;
    return audioBlob();
  }, m.environment);
  const controller = new AbortController();
  const playing = player.play("task", "Reply", controller.signal);
  await flush();
  const rejection = assert.rejects(playing, { name: "AbortError" });
  controller.abort();
  await rejection;
  assert.equal(downloads, 1);
  assert.ok(m.instances[0].pauses > 0);
  assert.equal(m.revoked.length, 1);
  assert.equal(m.timers.size, 0);
  player.clear();
});

test("audio construction failure still permits replay from cached bytes", async () => {
  const m = media();
  m.failConstruction(true);
  let downloads = 0;
  const player = new ServerSpeechPlayer(async () => {
    downloads++;
    return audioBlob();
  }, m.environment);
  await assert.rejects(
    player.play("task", "Reply", new AbortController().signal),
    (error) => error instanceof SpeechPlaybackError && error.canReplay,
  );
  assert.equal(player.hasAudio("task", "Reply"), true);
  m.failConstruction(false);
  const replay = player.play("task", "Reply", new AbortController().signal);
  await flush();
  m.instances[0].onended!();
  await replay;
  assert.equal(downloads, 1);
  player.clear();
});

test("audio MIME and streamed byte bounds reject invalid responses before playback", async () => {
  await assert.rejects(
    readSpeechAudio(
      new Response("<html>bad</html>", {
        headers: { "Content-Type": "text/html" },
      }),
    ),
    /invalid/,
  );
  await assert.rejects(
    readSpeechAudio(
      new Response("audio", {
        headers: {
          "Content-Type": "audio/mpeg",
          "Content-Length": String(MAX_SPEECH_BYTES + 1),
        },
      }),
    ),
    /oversized/,
  );
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(MAX_SPEECH_BYTES));
      controller.enqueue(new Uint8Array(1));
      controller.close();
    },
  });
  await assert.rejects(
    readSpeechAudio(
      new Response(stream, { headers: { "Content-Type": "audio/mpeg" } }),
    ),
    /oversized/,
  );
  const valid = await readSpeechAudio(
    new Response("audio", { headers: { "Content-Type": "audio/mpeg" } }),
  );
  assert.equal(valid.type, "audio/mpeg");
  assert.equal(valid.size, 5);
});

test("an active reply rejects parallel playback before another paid request", async () => {
  const m = media(),
    pending = deferred<Blob>();
  let downloads = 0;
  const player = new ServerSpeechPlayer(async () => {
    downloads++;
    return pending.promise;
  }, m.environment);
  const first = player.play("first", "First", new AbortController().signal);
  await assert.rejects(
    player.play("second", "Second", new AbortController().signal),
    /already/,
  );
  assert.equal(downloads, 1);
  pending.resolve(audioBlob());
  await flush();
  m.instances[0].onended!();
  await first;
  player.clear();
});


test("speech output ceiling is independent of input readiness and legacy input size", () => {
  const outputOnly = parseVoiceConfig({ ...config, provider: "ElevenLabs", configured: true, maxSpeechAudioBytes: 4194304 });
  assert.equal(outputOnly.speechConfigured, true);
  assert.equal(outputOnly.transcriptionConfigured, false);
  assert.equal(outputOnly.maxAudioBytes, 524288);
  assert.equal(outputOnly.maxSpeechAudioBytes, 4194304);
  assert.equal(parseVoiceConfig({ ...config, provider: "ElevenLabs", transcriptionConfigured: true }).transcriptionConfigured, true);
  assert.equal(parseVoiceConfig(config).maxSpeechAudioBytes, undefined);
  for (const maxSpeechAudioBytes of [0, -1, 4194305, 1.5, "4194304", null])
    assert.throws(() => parseVoiceConfig({ ...config, maxSpeechAudioBytes }));
  assert.notEqual(voiceConfigurationIdentity(outputOnly), voiceConfigurationIdentity({ ...outputOnly, maxSpeechAudioBytes: 1000 }));
});

test("a flaked voice lookup keeps the last configuration but stops arming paid replies", () => {
  const payload = {
    configured: true,
    deviceId: "mac",
    provider: "ElevenLabs",
    voice: "fixture-voice",
    speechConfigured: true,
    transcriptionConfigured: true,
    transcriptionProvider: "ElevenLabs",
    maxAudioBytes: 1000,
    maxSpeechChars: 100,
  };
  const config = parseVoiceConfig(payload);
  const live = voiceConfigAfterLookup(noVoiceConfig, config);
  assert.equal(live.config, config);
  assert.equal(live.stale, false);
  let state = voiceConfigAfterFailedLookup(live, false);
  assert.equal(state.config, config, "one failure must not restart the session");
  assert.equal(state.stale, true);
  state = voiceConfigAfterFailedLookup(state, false);
  assert.equal(state.config, config);
  state = voiceConfigAfterFailedLookup(state, false);
  assert.equal(state.config, null, "a sustained outage does drop the session");
  const recovered = voiceConfigAfterLookup(state, config);
  assert.equal(recovered.stale, false);
  assert.equal(recovered.failures, 0);
  assert.equal(
    voiceConfigAfterLookup(recovered, parseVoiceConfig(payload)).config,
    config,
    "an unchanged configuration must not restart the session",
  );
  assert.equal(voiceConfigAfterFailedLookup(live, true).config, null);
});
