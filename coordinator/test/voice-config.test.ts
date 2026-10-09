import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { loadSpeechConfig, loadTranscriptionConfig, providerLabel, voiceConfigFields } from "../src/voice-config.js";

const openai = "fixture-only-openai-key-value";
const elevenlabs = "fixture-only-elevenlabs-key-value";
const environment = { OPENAI_API_KEY: openai, ELEVENLABS_API_KEY: elevenlabs };
const schema = z.object(voiceConfigFields);

test("legacy configuration stays unchanged and implicitly selects only OpenAI", () => {
  assert.deepEqual(schema.parse({}), {});
  assert.deepEqual(schema.parse({ speechVoice: "cedar", apiKey: "must-be-stripped" }), { speechVoice: "cedar" });
  assert.deepEqual(loadTranscriptionConfig({}, environment), { apiKey: openai, model: "gpt-transcribe" });
  assert.deepEqual(loadSpeechConfig({}, environment), { provider: "openai", apiKey: openai, model: "gpt-4o-mini-tts", voice: "marin" });
  assert.equal(loadTranscriptionConfig({}, { ELEVENLABS_API_KEY: elevenlabs }), undefined);
  assert.deepEqual(loadSpeechConfig({}, { ELEVENLABS_API_KEY: elevenlabs }), { provider: "openai", model: "gpt-4o-mini-tts", voice: "marin" });
  assert.equal(providerLabel("openai"), "OpenAI");
  assert.equal(providerLabel("elevenlabs"), "ElevenLabs");
});

test("input and output independently select provider-specific models, keys and voice", () => {
  const config = schema.parse({ transcriptionProvider: "elevenlabs", speechProvider: "openai", speechVoice: "cedar", transcriptionModel: "existing-openai-model" });
  assert.deepEqual(loadTranscriptionConfig(config, environment), { provider: "elevenlabs", apiKey: elevenlabs, model: "scribe_v2" });
  assert.deepEqual(loadSpeechConfig(config, environment), { provider: "openai", apiKey: openai, model: "gpt-4o-mini-tts", voice: "cedar" });
  assert.deepEqual(loadTranscriptionConfig({ transcriptionProvider: "openai", transcriptionModel: "gpt-4o-mini-transcribe" }, environment), { provider: "openai", apiKey: openai, model: "gpt-4o-mini-transcribe" });
  assert.deepEqual(loadSpeechConfig({ transcriptionProvider: "openai", speechProvider: "elevenlabs", speechVoice: "cedar" }, environment), { provider: "elevenlabs", apiKey: elevenlabs, model: "eleven_flash_v2_5" });
  assert.deepEqual(loadSpeechConfig({ speechProvider: "elevenlabs", elevenLabsVoiceId: "Selected_Voice-1", elevenLabsSpeechModel: "eleven_multilingual_v2" }, environment), { provider: "elevenlabs", apiKey: elevenlabs, model: "eleven_multilingual_v2", voice: "Selected_Voice-1" });
  assert.deepEqual(loadTranscriptionConfig({ transcriptionProvider: "elevenlabs", elevenLabsTranscriptionModel: "scribe_v1" }, environment), { provider: "elevenlabs", apiKey: elevenlabs, model: "scribe_v1" });
});

test("ElevenLabs never borrows OpenAI credentials or assumes a voice", () => {
  assert.equal(loadTranscriptionConfig({ transcriptionProvider: "elevenlabs" }, { OPENAI_API_KEY: openai }), undefined);
  assert.deepEqual(loadSpeechConfig({ speechProvider: "elevenlabs" }, {}), { provider: "elevenlabs", model: "eleven_flash_v2_5" });
  assert.equal("voice" in loadSpeechConfig({ speechProvider: "elevenlabs" }, environment), false);
  for (const key of ["", "short", "long-but contains-whitespace"]) {
    assert.equal(loadTranscriptionConfig({ transcriptionProvider: "elevenlabs" }, { ELEVENLABS_API_KEY: key }), undefined);
    assert.equal(loadSpeechConfig({ speechProvider: "elevenlabs" }, { ELEVENLABS_API_KEY: key }).apiKey, undefined);
  }
});

test("explicit files isolate keys and suppress environment and other-provider fallback", () => {
  const dir = mkdtempSync(join(tmpdir(), "providence-voice-config-"));
  const file = join(dir, "voice.env");
  try {
    writeFileSync(file, `OPENAI_API_KEY='${openai}'\nELEVENLABS_API_KEY=\"${elevenlabs}\"\nIGNORED=$(never-execute-this)\n`, { mode: 0o600 });
    const config = { transcriptionEnvFile: file, elevenLabsEnvFile: file };
    assert.deepEqual(loadTranscriptionConfig(config, {}), { apiKey: openai, model: "gpt-transcribe" });
    assert.equal(loadSpeechConfig({ ...config, speechProvider: "elevenlabs" }, {}).apiKey, elevenlabs);
    writeFileSync(file, `OPENAI_API_KEY=${openai}\n`);
    assert.equal(loadTranscriptionConfig({ ...config, transcriptionProvider: "elevenlabs" }, environment), undefined);
    assert.equal(loadSpeechConfig({ ...config, speechProvider: "elevenlabs" }, environment).apiKey, undefined);
    writeFileSync(file, `ELEVENLABS_API_KEY=${elevenlabs}\n`);
    assert.equal(loadTranscriptionConfig(config, environment), undefined);
    assert.equal(loadSpeechConfig(config, environment).apiKey, undefined);
    // An unselected provider's unusable file cannot disable the selected one.
    assert.equal(loadTranscriptionConfig({ elevenLabsEnvFile: join(dir, "missing") }, environment)?.apiKey, openai);
    assert.equal(loadSpeechConfig({ speechProvider: "elevenlabs", transcriptionEnvFile: join(dir, "missing") }, environment).apiKey, elevenlabs);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("unsafe files fail with sanitized compatible errors and never fall back", () => {
  const dir = mkdtempSync(join(tmpdir(), "providence-voice-config-path-"));
  const file = join(dir, "voice.env");
  try {
    writeFileSync(file, `ELEVENLABS_API_KEY=${elevenlabs}\n`, { mode: 0o600 });
    const paths = ["relative.env", "//server/share/voice.env", "\\\\server\\share\\voice.env", dir, join(dir, "missing.env")];
    if (process.platform !== "win32") {
      const link = join(dir, "link.env");
      symlinkSync(file, link);
      paths.push(link);
    }
    const oversized = join(dir, "oversized.env");
    writeFileSync(oversized, "X".repeat(64 * 1024 + 1));
    paths.push(oversized);
    for (const path of paths) {
      for (const load of [
        () => loadTranscriptionConfig({ transcriptionProvider: "elevenlabs", elevenLabsEnvFile: path }, environment),
        () => loadSpeechConfig({ speechProvider: "elevenlabs", elevenLabsEnvFile: path }, environment),
        () => loadTranscriptionConfig({ transcriptionEnvFile: path }, environment),
      ]) assert.throws(load, (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /(?:private transcription environment|explicitly configured absolute local path)/);
        assert.equal(error.message.includes(openai) || error.message.includes(elevenlabs) || error.message.includes(path), false);
        return true;
      });
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("configuration accepts bounded selectors and rejects arbitrary voice/model/provider values", () => {
  for (const input of [
    { speechProvider: "another-provider" }, { transcriptionProvider: "" },
    { speechVoice: "arbitrary" }, { elevenLabsVoiceId: "../voice" },
    { elevenLabsVoiceId: "voice?token=secret" }, { elevenLabsVoiceId: "" },
    { elevenLabsVoiceId: "a".repeat(201) }, { elevenLabsSpeechModel: "bad model" },
    { elevenLabsTranscriptionModel: "../model" }, { transcriptionModel: "" },
    { elevenLabsEnvFile: "" },
  ]) assert.equal(schema.safeParse(input).success, false);
  assert.equal(schema.safeParse({ elevenLabsVoiceId: "a".repeat(200), elevenLabsSpeechModel: "provider_model.v2:fast" }).success, true);
  assert.throws(() => loadSpeechConfig({ speechProvider: "invalid" as any }, environment), /Invalid private voice provider configuration/);
});


test("explicit speech file overrides output only and preserves OpenAI transcription", () => {
  const dir = mkdtempSync(join(tmpdir(), "providence-output-file-"));
  const input = join(dir, "input.env"), output = join(dir, "output.env");
  try {
    writeFileSync(input, `OPENAI_API_KEY=${openai}\nELEVENLABS_API_KEY=fixture-unselected-elevenlabs-key\n`, { mode: 0o600 });
    writeFileSync(output, `ELEVENLABS_API_KEY=${elevenlabs}\nOPENAI_API_KEY=fixture-separate-openai-output-key\n`, { mode: 0o600 });
    const config = schema.parse({ transcriptionProvider: "openai", transcriptionEnvFile: input,
      transcriptionModel: "gpt-4o-mini-transcribe", speechProvider: "elevenlabs",
      speechEnvFile: output, elevenLabsEnvFile: input, elevenLabsVoiceId: "SelectedVoice" });
    assert.equal(config.speechEnvFile, output);
    assert.deepEqual(loadTranscriptionConfig(config, environment), { provider: "openai", apiKey: openai, model: "gpt-4o-mini-transcribe" });
    assert.equal(loadSpeechConfig(config, environment).apiKey, elevenlabs);
    assert.equal(loadSpeechConfig({ ...config, speechProvider: "openai" }, environment).apiKey, "fixture-separate-openai-output-key");
    writeFileSync(output, "IGNORED=no-provider-key\n");
    assert.equal(loadSpeechConfig(config, environment).apiKey, undefined, "explicit output never falls back to other file or environment");
    assert.equal(loadTranscriptionConfig(config, environment)?.apiKey, openai);
    const missing = { ...config, speechEnvFile: join(dir, "absent.env") };
    assert.throws(() => loadSpeechConfig(missing, environment), /Unable to read/);
    assert.equal(loadTranscriptionConfig(missing, environment)?.apiKey, openai);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
