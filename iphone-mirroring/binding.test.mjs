import assert from "node:assert/strict";
import test from "node:test";
import { deriveMirroringBinding } from "./binding.mjs";

const now = 1_000;
const binding = (overrides = {}) => ({
  verification: "owner_confirmed_pairing", enabled: true, deviceId: "demo-mac", chatId: "chat_1",
  phoneId: "demo-phone", phoneName: "Demo iPhone", epoch: "epoch_1",
  allowedActions: ["browser", "messaging"], confirmedAt: 990, ...overrides,
});

test("publishes only stable routing configuration", () => {
  const result = deriveMirroringBinding(binding(), "demo-mac", now);
  assert.deepEqual(result, {
    schemaVersion: 1, transport: "apple-iphone-mirroring", appBundleId: "com.apple.ScreenContinuity",
    status: "configured", deviceId: "demo-mac", chatId: "chat_1", phoneId: "demo-phone",
    phoneName: "Demo iPhone", bindingEpoch: "epoch_1", allowedActions: ["browser", "messaging"],
    requiresLivePreflight: true, grantsPermission: false,
  });
  assert.equal("ready" in result, false);
  assert.equal("executable" in result, false);
});

test("rejects revoked, wrong-device, future, unsafe, and malformed bindings", () => {
  for (const value of [
    binding({ enabled: false }), binding({ deviceId: "other-mac" }), binding({ confirmedAt: now + 6 }),
    binding({ epoch: "bad/epoch" }), binding({ allowedActions: [] }), binding({ allowedActions: ["browser", "browser"] }),
    binding({ allowedActions: ["browser", "messaging", "email", "general", "browser"] }), binding({ phoneName: "   " }),
  ]) assert.equal(deriveMirroringBinding(value, "demo-mac", now), undefined);
});

test("keeps a valid Unicode binding stable without refreshing confirmation time", () => {
  const value = binding({ phoneName: "  Demo’s iPhone 📱  ", allowedActions: ["general"], confirmedAt: 990 });
  assert.equal(deriveMirroringBinding(value, "demo-mac", now)?.confirmedAt, undefined);
  assert.equal(deriveMirroringBinding(value, "demo-mac", now + 30)?.bindingEpoch, "epoch_1");
  assert.equal(deriveMirroringBinding(value, "other-mac", now), undefined);
});
