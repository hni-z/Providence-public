import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import {
  MAX_AUDIO_BYTES,
  MAX_TRANSCRIPT_CHARS,
  TRANSCRIPTION_TIMEOUT_MS,
  TranscriptionError,
  TranscriptionJobs,
  transcribeAudio,
  validateAudio,
  type AudioMimeType,
  type TranscriptionErrorCode,
  type TranscriptionResult,
} from "../src/transcription.js";

const key = "test-only-device-private-key";
const recording = {
  base64: Buffer.from("synthetic unit-test bytes, not physical audio").toString(
    "base64",
  ),
  mimeType: "audio/webm" as const,
};
function errorCode(code: TranscriptionErrorCode) {
  return (error: unknown) =>
    error instanceof TranscriptionError && error.code === code;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture(
  workerTranscribe: ConstructorParameters<
    typeof TranscriptionJobs
  >[0]["workerTranscribe"],
  maxJobs?: number,
) {
  const directory = mkdtempSync(join(tmpdir(), "providence-transcription-"));
  const file = join(directory, "private", "transcriptions.json");
  const jobs = new TranscriptionJobs({ file, workerTranscribe, maxJobs });
  return {
    file,
    jobs,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

test("audio limits reject malformed/noncanonical base64, unsupported MIME, empty audio and oversized bytes", () => {
  for (const base64 of [
    "",
    "Zg",
    "Zh==",
    "Zg==\n",
    "not-base64!",
    "data:audio/webm;base64,Zg==",
    "====",
  ])
    assert.throws(
      () => validateAudio({ ...recording, base64 }),
      errorCode("invalid_audio"),
    );
  assert.throws(
    () => validateAudio({ ...recording, mimeType: "text/plain" }),
    errorCode("invalid_audio"),
  );
  assert.throws(() => validateAudio(null), errorCode("invalid_audio"));
  const maximum = Buffer.alloc(MAX_AUDIO_BYTES, 7).toString("base64");
  assert.equal(
    validateAudio({ ...recording, base64: maximum }).bytes.length,
    MAX_AUDIO_BYTES,
  );
  assert.throws(
    () =>
      validateAudio({
        ...recording,
        base64: Buffer.alloc(MAX_AUDIO_BYTES + 1).toString("base64"),
      }),
    errorCode("audio_too_large"),
  );
  assert.throws(
    () =>
      validateAudio({ ...recording, base64: "A".repeat(maximum.length + 4) }),
    errorCode("audio_too_large"),
  );
});

test("provider sends one multipart request with correct filename/MIME and returns only bounded text", async () => {
  const formats: [AudioMimeType, string][] = [
    ["audio/webm", "webm"],
    ["audio/mp4", "mp4"],
    ["audio/ogg", "ogg"],
    ["audio/wav", "wav"],
  ];
  for (const [mimeType, extension] of formats) {
    let attempts = 0;
    const fetcher: typeof fetch = async (url, init) => {
      attempts++;
      assert.equal(url, "https://api.openai.com/v1/audio/transcriptions");
      assert.equal(init!.method, "POST");
      assert.equal(init!.redirect, "error");
      assert.deepEqual(init!.headers, { Authorization: `Bearer ${key}` });
      assert.ok(init!.signal instanceof AbortSignal);
      const form = init!.body as FormData;
      assert.equal(form.get("model"), "gpt-transcribe");
      assert.equal(form.get("response_format"), "json");
      const file = form.get("file") as File;
      assert.equal(file.name, `recording.${extension}`);
      assert.equal(file.type, mimeType);
      assert.equal(
        Buffer.from(await file.arrayBuffer()).toString("base64"),
        recording.base64,
      );
      return Response.json({
        text: "  Turn this into a draft.  ",
        ignoredProviderField: key,
      });
    };
    assert.deepEqual(
      await transcribeAudio(
        { ...recording, mimeType },
        key,
        "gpt-transcribe",
        fetcher,
      ),
      { text: "Turn this into a draft." },
    );
    assert.equal(attempts, 1);
  }
});

test("invalid audio/configuration makes zero provider attempts", async () => {
  let attempts = 0;
  const fetcher: typeof fetch = async () => {
    attempts++;
    throw new Error("must not fetch");
  };
  await assert.rejects(
    transcribeAudio(
      { ...recording, base64: "bad" },
      key,
      "gpt-transcribe",
      fetcher,
    ),
    errorCode("invalid_audio"),
  );
  await assert.rejects(
    transcribeAudio(recording, "", "gpt-transcribe", fetcher),
    errorCode("provider_not_configured"),
  );
  await assert.rejects(
    transcribeAudio(recording, key, "gpt-transcribe\r\n", fetcher),
    errorCode("provider_not_configured"),
  );
  assert.equal(attempts, 0);
});

test("provider status and network errors are mapped without echoing response diagnostics or retrying", async () => {
  const cases: [number, TranscriptionErrorCode, number][] = [
    [400, "provider_rejected", 422],
    [401, "provider_authentication", 503],
    [403, "provider_authentication", 503],
    [429, "provider_rate_limited", 429],
    [503, "provider_unavailable", 503],
  ];
  for (const [status, code, expectedStatus] of cases) {
    let attempts = 0;
    const fetcher: typeof fetch = async () => {
      attempts++;
      return new Response(`secret=${key}`, { status });
    };
    await assert.rejects(
      transcribeAudio(recording, key, "gpt-transcribe", fetcher),
      (error) => {
        assert.ok(error instanceof TranscriptionError);
        assert.equal(error.code, code);
        assert.equal(error.status, expectedStatus);
        assert.equal(error.message.includes(key), false);
        return true;
      },
    );
    assert.equal(attempts, 1);
  }
  await assert.rejects(
    transcribeAudio(recording, key, "gpt-transcribe", async () => {
      throw new Error(`Bearer ${key}`);
    }),
    (error) => {
      assert.ok(error instanceof TranscriptionError);
      assert.equal(error.code, "provider_network");
      assert.equal(error.message.includes(key), false);
      return true;
    },
  );
});

test("provider response must contain speech within text and response byte limits", async () => {
  for (const [value, code] of [
    [{ text: "" }, "no_speech"],
    [{ text: 42 }, "invalid_response"],
    [{ text: "x".repeat(MAX_TRANSCRIPT_CHARS + 1) }, "transcript_too_long"],
  ] as [unknown, TranscriptionErrorCode][])
    await assert.rejects(
      transcribeAudio(recording, key, "gpt-transcribe", async () =>
        Response.json(value),
      ),
      errorCode(code),
    );
  await assert.rejects(
    transcribeAudio(
      recording,
      key,
      "gpt-transcribe",
      async () => new Response("not json"),
    ),
    errorCode("invalid_response"),
  );
  await assert.rejects(
    transcribeAudio(
      recording,
      key,
      "gpt-transcribe",
      async () => new Response("x".repeat(64 * 1024 + 1)),
    ),
    errorCode("invalid_response"),
  );
  const text = "x".repeat(MAX_TRANSCRIPT_CHARS);
  assert.deepEqual(
    await transcribeAudio(recording, key, "gpt-transcribe", async () =>
      Response.json({ text }),
    ),
    { text },
  );
});

test("provider aborts at sixty seconds without another billable attempt", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let attempts = 0;
  let signal: AbortSignal | undefined;
  const fetcher: typeof fetch = async (_url, init) => {
    attempts++;
    signal = init!.signal!;
    return new Promise((_resolve, reject) =>
      signal!.addEventListener(
        "abort",
        () => reject(new Error(`secret ${key}`)),
        { once: true },
      ),
    );
  };
  const pending = transcribeAudio(recording, key, "gpt-transcribe", fetcher);
  const rejected = assert.rejects(pending, errorCode("provider_timeout"));
  t.mock.timers.tick(TRANSCRIPTION_TIMEOUT_MS - 1);
  assert.equal(signal!.aborted, false);
  t.mock.timers.tick(1);
  await rejected;
  assert.equal(attempts, 1);
  t.mock.timers.reset();
});

test("coordinator reserves once, deduplicates client retries, isolates active work and stores neither audio nor keys", async () => {
  const result = deferred<TranscriptionResult>();
  const calls: unknown[] = [];
  const f = fixture(async (deviceId, audio, requestId) => {
    calls.push({ deviceId, audio, requestId });
    return result.promise;
  });
  try {
    const request = {
      requestId: "recording-one",
      deviceId: "demoPC",
      ...recording,
    };
    const first = f.jobs.submit(request);
    assert.equal(first.status, "pending");
    assert.equal(f.jobs.submit(request).id, first.id);
    assert.equal(calls.length, 1);
    assert.throws(
      () => f.jobs.submit({ ...request, requestId: "another-recording" }),
      errorCode("transcription_busy"),
    );
    assert.throws(
      () => f.jobs.submit({ ...request, deviceId: "mac" }),
      errorCode("request_conflict"),
    );
    assert.throws(
      () =>
        f.jobs.submit({
          ...request,
          base64: Buffer.from("other bytes").toString("base64"),
        }),
      errorCode("request_conflict"),
    );
    assert.throws(
      () => f.jobs.submit({ ...request, mimeType: "audio/ogg" }),
      errorCode("request_conflict"),
    );
    result.resolve({ text: "Draft a checklist" });
    await setImmediate();
    const completed = f.jobs.get(first.id);
    assert.equal(completed.status, "completed");
    assert.equal(completed.text, "Draft a checklist");
    assert.equal(f.jobs.submit(request).id, first.id);
    assert.equal(calls.length, 1);
    completed.text = "client cannot mutate stored results";
    assert.equal(f.jobs.get(first.id).text, "Draft a checklist");
    const disk = readFileSync(f.file, "utf8");
    assert.equal(disk.includes(recording.base64), false);
    assert.equal(disk.includes(key), false);
    assert.equal(disk.includes("fingerprint"), true);
    if (process.platform !== "win32")
      assert.equal(statSync(f.file).mode & 0o777, 0o600);
  } finally {
    f.cleanup();
  }
});

test("two devices transcribe at once while one device still refuses a second recording", async () => {
  const pending = new Map<string, ReturnType<typeof deferred<TranscriptionResult>>>();
  const f = fixture(async (deviceId) => {
    const slot = deferred<TranscriptionResult>();
    pending.set(deviceId, slot);
    return slot.promise;
  });
  try {
    const laptop = { requestId: "laptop-one", deviceId: "demoPC", ...recording };
    const desk = { requestId: "desk-one", deviceId: "mac", ...recording };
    const first = f.jobs.submit(laptop);
    const second = f.jobs.submit(desk);
    assert.equal(first.status, "pending");
    assert.equal(second.status, "pending");
    assert.equal(pending.size, 2);
    assert.throws(
      () => f.jobs.submit({ ...laptop, requestId: "laptop-two" }),
      errorCode("transcription_busy"),
    );
    assert.throws(
      () => f.jobs.submit({ ...desk, requestId: "desk-two" }),
      errorCode("transcription_busy"),
    );
    pending.get("demoPC")!.resolve({ text: "Laptop recording" });
    pending.get("mac")!.resolve({ text: "Desk recording" });
    await setImmediate();
    assert.equal(f.jobs.get(first.id).text, "Laptop recording");
    assert.equal(f.jobs.get(second.id).text, "Desk recording");
  } finally {
    f.cleanup();
  }
});

test("failed jobs retain their request identity, sanitize worker errors and never retry automatically", async () => {
  let calls = 0;
  const f = fixture(async () => {
    calls++;
    throw new Error(`Device transport exposed ${key}`);
  });
  try {
    const request = {
      requestId: "failed-recording",
      deviceId: "demoPC",
      ...recording,
    };
    const job = f.jobs.submit(request);
    await setImmediate();
    assert.equal(f.jobs.get(job.id).status, "failed");
    assert.equal(f.jobs.get(job.id).errorCode, "worker_failed");
    assert.equal(f.jobs.submit(request).id, job.id);
    assert.equal(calls, 1);
    assert.equal(readFileSync(f.file, "utf8").includes(key), false);
  } finally {
    f.cleanup();
  }
});

test("restart marks pending transcription interrupted and does not dispatch identical retries", () => {
  const f = fixture(() => new Promise(() => {}));
  try {
    const request = {
      requestId: "interrupted-recording",
      deviceId: "demoPC",
      ...recording,
    };
    const original = f.jobs.submit(request);
    let calls = 0;
    const restarted = new TranscriptionJobs({
      file: f.file,
      workerTranscribe: async () => {
        calls++;
        return { text: "must not run" };
      },
    });
    assert.equal(restarted.get(original.id).status, "interrupted");
    assert.equal(restarted.get(original.id).errorCode, "restart_interrupted");
    assert.equal(restarted.submit(request).id, original.id);
    assert.equal(calls, 0);
  } finally {
    f.cleanup();
  }
});

test("a full history evicts old transcripts to identity stubs instead of refusing new recordings", async () => {
  let calls = 0;
  const f = fixture(async () => {
    calls++;
    return { text: "Recognized text" };
  }, 200);
  try {
    const submit = async (requestId: string) => {
      const job = f.jobs.submit({ requestId, deviceId: "demoPC", ...recording });
      await setImmediate();
      return job;
    };
    const first = await submit("request-0");
    for (let index = 1; index < 205; index++) await submit(`request-${index}`);
    assert.equal(calls, 205);
    const stubs = f.jobs.list().filter((job) => job.errorCode === "history_full");
    assert.equal(stubs.length, 5, "only the overflow above the ceiling is evicted");
    assert.equal(
      f.jobs.list().filter((job) => job.text === "Recognized text").length,
      200,
      "the configured history of transcripts survives",
    );
    const stub = f.jobs.get(first.id);
    assert.equal(stub.requestId, "request-0");
    assert.equal(stub.text, "");
    assert.equal(stub.errorCode, "history_full");
    assert.equal(stub.fingerprint.length, 64);
    assert.equal((await submit("request-0")).id, first.id);
    assert.equal((await submit("request-204")).text, "Recognized text");
    assert.equal(calls, 205, "a replayed request ID must never reach the provider again");
  } finally {
    f.cleanup();
  }
});

test("a history under the job ceiling keeps every transcript", async () => {
  const f = fixture(async () => ({ text: "Recognized text" }), 200);
  try {
    for (let index = 0; index < 150; index++) {
      f.jobs.submit({
        requestId: `request-${index}`,
        deviceId: "demoPC",
        ...recording,
      });
      await setImmediate();
    }
    const jobs = f.jobs.list();
    assert.equal(jobs.filter((job) => job.errorCode === "history_full").length, 0);
    assert.equal(jobs.filter((job) => job.text === "Recognized text").length, 150);
  } finally {
    f.cleanup();
  }
});
