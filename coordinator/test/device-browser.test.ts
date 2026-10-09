import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDeviceConfig, runtimeMetadata } from "../src/device-config.js";

const fixture = { deviceId: "mac-test", token: "0".repeat(64), url: "wss://providence.hani.so/worker", workspace: "/tmp/providence-demo" };

test("browser declaration stays disabled unless this host explicitly opts into verified Chrome", () => {
  const legacy = parseDeviceConfig(JSON.stringify(fixture));
  assert.equal(legacy.browserControl, undefined);
  assert.equal(runtimeMetadata(fixture.workspace).capabilities.browser, false);
  const configured = parseDeviceConfig(JSON.stringify({ ...fixture, browserControl: "chrome" }));
  const metadata = runtimeMetadata(configured.workspace, true, undefined, undefined, configured.browserControl);
  assert.equal(metadata.capabilities.browser, true);
  assert.equal(metadata.capabilities.transcription, true);
  assert.equal(metadata.capabilities.desktop, false);
  assert.equal(metadata.capabilities.phoneMirroring, false);
  assert.equal(runtimeMetadata(fixture.workspace).capabilities.browser, false);
});

test("browser declarations reject broad or unknown control modes", () => {
  for (const browserControl of [true, "all", "desktop", "safari"]) {
    assert.throws(() => parseDeviceConfig(JSON.stringify({ ...fixture, browserControl })));
  }
});

test("private device enrollment may select a bounded worker model profile", () => {
  const configured = parseDeviceConfig(JSON.stringify({
    ...fixture,
    workerModel: "  gpt-5.6-sol  ",
    workerReasoningEffort: "  low  ",
  }));
  assert.equal(configured.workerModel, "gpt-5.6-sol");
  assert.equal(configured.workerReasoningEffort, "low");
  assert.throws(() => parseDeviceConfig(JSON.stringify({ ...fixture, workerReasoningEffort: " " })));
});
