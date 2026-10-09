import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import {
  deviceMetadataSchema,
  loadDeviceTranscription,
  parseDeviceConfig,
  runtimeMetadata,
} from "../src/device-config.js";
import { Runtime } from "../src/runtime.js";
import { Devices, runtimeRequest } from "../src/devices.js";
import { TranscriptionError } from "../src/transcription.js";

const privateKey = "fixture-only-private-provider-key";
const audio = {
  base64: Buffer.from("synthetic test audio").toString("base64"),
  mimeType: "audio/webm",
};
function temporary() {
  const directory = mkdtempSync(join(tmpdir(), "providence-device-audio-"));
  return {
    directory,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

test("private companion configuration supports only a local env-file reference and optional transcription model", () => {
  const f = temporary();
  try {
    const file = join(f.directory, "provider.env");
    writeFileSync(
      file,
      `# Existing provider configuration\nOPENAI_API_KEY='${privateKey}'\nUNRELATED_EMAIL_SETTING=not-used\n`,
      { mode: 0o600 },
    );
    const config = parseDeviceConfig(
      JSON.stringify({
        deviceId: "demoPC",
        token: "t".repeat(64),
        url: "wss://example.com/worker",
        workspace: f.directory,
        transcriptionEnvFile: file,
        transcriptionModel: "gpt-transcribe",
        apiKey: "public-json-field-is-not-accepted",
      }),
    );
    assert.equal(config.transcriptionEnvFile, file);
    assert.equal("apiKey" in config, false);
    assert.deepEqual(loadDeviceTranscription(config, {}), {
      apiKey: privateKey,
      model: "gpt-transcribe",
    });
    assert.deepEqual(
      loadDeviceTranscription({ transcriptionEnvFile: file }, {}),
      { apiKey: privateKey, model: "gpt-transcribe" },
    );
    assert.deepEqual(
      loadDeviceTranscription(
        { transcriptionModel: "gpt-4o-mini-transcribe" },
        { OPENAI_API_KEY: privateKey },
      ),
      { apiKey: privateKey, model: "gpt-4o-mini-transcribe" },
    );
    assert.equal(loadDeviceTranscription({}, {}), undefined);
  } finally {
    f.cleanup();
  }
});

test("configured env file takes precedence without shell evaluation or a silent fallback credential", () => {
  const f = temporary();
  try {
    const file = join(f.directory, "provider.env");
    writeFileSync(file, `OPENAI_API_KEY=${privateKey}\nIGNORED=$(exit 42)\n`, {
      mode: 0o600,
    });
    assert.equal(
      loadDeviceTranscription(
        { transcriptionEnvFile: file },
        { OPENAI_API_KEY: "different-fixture-provider-key" },
      )!.apiKey,
      privateKey,
    );
    writeFileSync(file, "UNRELATED_SETTING=value\n", { mode: 0o600 });
    assert.equal(
      loadDeviceTranscription(
        { transcriptionEnvFile: file },
        { OPENAI_API_KEY: privateKey },
      ),
      undefined,
    );
    for (const path of [
      "relative.env",
      "//network/provider.env",
      "\\\\network\\provider.env",
      join(f.directory, "missing.env"),
      f.directory,
    ])
      assert.throws(
        () =>
          loadDeviceTranscription(
            { transcriptionEnvFile: path },
            { OPENAI_API_KEY: privateKey },
          ),
        (error) => {
          assert.ok(error instanceof Error);
          assert.equal(error.message.includes(privateKey), false);
          return true;
        },
      );
    writeFileSync(file, "X".repeat(64 * 1024 + 1));
    assert.throws(
      () => loadDeviceTranscription({ transcriptionEnvFile: file }, {}),
      /private transcription environment/,
    );
  } finally {
    f.cleanup();
  }
});

test("runtime has no implicit provider access; audio RPC cannot configure a key or file remotely", async (t) => {
  const f = temporary();
  try {
    let attempts = 0;
    t.mock.method(globalThis, "fetch", async () => {
      attempts++;
      throw new Error("Unexpected network request");
    });
    const runtime = new Runtime({ root: f.directory });
    assert.equal(runtime.hasTranscription, false);
    await assert.rejects(
      runtimeRequest(runtime, "audio.transcribe", {
        ...audio,
        apiKey: privateKey,
        transcriptionEnvFile: join(f.directory, "must-not-read.env"),
        model: "gpt-transcribe",
      }),
      (error) =>
        error instanceof TranscriptionError &&
        error.code === "provider_not_configured",
    );
    assert.equal(attempts, 0);
    const devices = new Devices("mac", "Mac", runtime, []);
    assert.equal(devices.list()[0].capabilities.transcription, false);
    assert.equal(devices.list()[0].capabilities.files, true);
    assert.equal(devices.list()[0].capabilities.shell, true);
  } finally {
    f.cleanup();
  }
});

test("configured runtime transcribes through its device-local provider without exposing credentials or using Codex RPC", async (t) => {
  const f = temporary();
  try {
    const runtime = new Runtime(
      { root: f.directory },
      { apiKey: privateKey, model: "gpt-transcribe" },
    );
    runtime.rpc.call = async () => {
      throw new Error(
        "Audio must not send provider credentials through Codex RPC",
      );
    };
    let attempts = 0;
    t.mock.method(
      globalThis,
      "fetch",
      async (url: unknown, init: RequestInit) => {
        attempts++;
        assert.equal(url, "https://api.openai.com/v1/audio/transcriptions");
        assert.deepEqual(init.headers, {
          Authorization: `Bearer ${privateKey}`,
        });
        assert.equal((init.body as FormData).get("model"), "gpt-transcribe");
        return Response.json({ text: "Create a checklist" });
      },
    );
    const output = await runtimeRequest(runtime, "audio.transcribe", {
      ...audio,
      apiKey: "remote-override",
      model: "remote-model",
    });
    assert.deepEqual(output, { text: "Create a checklist" });
    assert.equal(attempts, 1);
    assert.equal(runtime.hasTranscription, true);
    assert.equal(JSON.stringify(runtime).includes(privateKey), false);
    assert.equal(JSON.stringify(runtime.options).includes(privateKey), false);
    const metadata = runtimeMetadata(f.directory, runtime.hasTranscription);
    assert.equal(metadata.capabilities.transcription, true);
    assert.equal(JSON.stringify(metadata).includes(privateKey), false);
    assert.equal(
      JSON.stringify(metadata).includes("transcriptionEnvFile"),
      false,
    );
  } finally {
    f.cleanup();
  }
});

test("legacy device readiness defaults transcription false and a legacy reconnect clears a stale claim", async () => {
  const f = temporary();
  const runtime = new Runtime({ root: f.directory });
  const devices = new Devices("mac", "Mac", runtime, [
    { id: "demoPC", name: "DemoPC" },
  ]);
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  server.on("connection", (socket) => devices.attach("demoPC", socket));
  const url = `ws://127.0.0.1:${(server.address() as { port: number }).port}`;
  let client: WebSocket | undefined;
  try {
    const legacy: any = runtimeMetadata(f.directory);
    delete legacy.capabilities.transcription;
    assert.equal(
      deviceMetadataSchema.parse(legacy).capabilities.transcription,
      false,
    );
    client = new WebSocket(url);
    await once(client, "open");
    const online = once(devices, "online");
    client.send(
      JSON.stringify({
        kind: "ready",
        metadata: {
          ...runtimeMetadata(f.directory, true),
          hostname: "DemoPC",
          platform: "win32",
        },
      }),
    );
    await online;
    assert.equal(
      devices.list().find((device) => device.id === "demoPC")!.capabilities
        .transcription,
      true,
    );
    const offline = once(devices, "offline");
    client.close();
    await offline;
    client = new WebSocket(url);
    await once(client, "open");
    const reconnected = once(devices, "online");
    client.send(JSON.stringify({ kind: "ready" }));
    await reconnected;
    const device = devices.list().find((value) => value.id === "demoPC")!;
    assert.equal(device.capabilities.transcription, false);
    assert.equal(device.hostname, "DemoPC");
    assert.equal(device.capabilities.files, true);
  } finally {
    client?.terminate();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    f.cleanup();
  }
});
