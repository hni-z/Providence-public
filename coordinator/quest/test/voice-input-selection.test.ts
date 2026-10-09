import { test } from "node:test";
import assert from "node:assert/strict";
import { selectVoiceInput, type VoiceInputCapability } from "../src/voice-input-selection";
const mac = { id: "mac-input", name: "Mac", online: true, configured: true, provider: "OpenAI" };
const other = { id: "other-input", name: "Other", online: true, configured: true, provider: "ElevenLabs" };
const capability = (devices = [other, mac], available = true): VoiceInputCapability => ({ available, devices });
const route = { deviceId: mac.id, transcriptionConfigured: true, transcriptionProvider: "OpenAI" };

test("approved route wins over list order and never depends on the execution target", () => {
  const result = selectVoiceInput(capability(), route);
  assert.equal(result.hostId, mac.id); assert.equal(result.ready, true);
  assert.equal(result.provider, "OpenAI"); assert.equal(result.browserFallbackAllowed, false);
  assert.equal(result.label, "Cloud transcription ready");
  assert.equal("chatId" in result, false);
});
test("missing configuration never chooses another eligible host or browser speech", () => {
  for (const config of [undefined, { ...route, deviceId: "" }, { ...route, transcriptionConfigured: false }]) {
    const result = selectVoiceInput(capability(), config);
    assert.equal(result.ready, false); assert.equal(result.browserFallbackAllowed, false);
    assert.notEqual(result.hostId, other.id);
  }
});
test("an offline or omitted approved route stays unavailable even when another host is ready", () => {
  for (const devices of [[other], [other, { ...mac, online: false }], [other, { ...mac, configured: false }]]) {
    const result = selectVoiceInput(capability(devices), route);
    assert.equal(result.hostId, mac.id); assert.equal(result.ready, false);
    assert.equal(result.browserFallbackAllowed, false);
  }
  assert.equal(selectVoiceInput(capability(), route).ready, true);
});
test("capability service loss is not bypassed by an online approved host", () => {
  assert.equal(selectVoiceInput(capability([mac], false), route).ready, false);
  assert.equal(selectVoiceInput(undefined, route).ready, false);
});
test("captured route cannot migrate when the approved route changes", () => {
  const result = selectVoiceInput(capability(), { ...route, deviceId: other.id, transcriptionProvider: "ElevenLabs" }, mac.id);
  assert.equal(result.hostId, mac.id); assert.equal(result.reason, "route-changed");
  assert.equal(result.ready, false);
});
test("mismatched providers fail closed; legacy unlabeled workers remain OpenAI", () => {
  assert.equal(selectVoiceInput(capability(), { ...route, transcriptionProvider: "ElevenLabs" }).reason, "provider-mismatch");
  const legacy = { ...mac, provider: undefined };
  assert.equal(selectVoiceInput({ available: true, devices: [legacy], provider: "ElevenLabs" }, route).provider, "OpenAI");
});
test("projection preserves source metadata and does not expose a processing computer in its label", () => {
  const input = capability(), before = structuredClone(input);
  const result = selectVoiceInput(input, route);
  assert.deepEqual(input, before);
  assert.ok(!result.label.includes(mac.name)); assert.ok(!result.label.includes(mac.id));
});
