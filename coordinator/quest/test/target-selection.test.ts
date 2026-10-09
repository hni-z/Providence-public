import assert from "node:assert/strict";
import test from "node:test";
import { actionTarget, deviceConnection, targetOptions } from "../src/target-selection";
import type { Snapshot } from "../src/types";

function state(): Snapshot {
  return {
    devices: [
      { id: "mac", name: "Demo Mac", online: true },
      { id: "review", name: "Review Mac Pro", online: false, connectionState: "online" },
      { id: "demoPC", name: "DemoPC", online: true },
    ],
    chats: [
      { id: "demo-chat", name: "Workspace", deviceId: "mac" },
      { id: "review-chat", name: "Workspace", deviceId: "review", online: true },
      { id: "demoPC-chat", name: "Workspace", deviceId: "demoPC" },
    ], tasks: [], approvals: [],
  };
}

test("target names identify all three computers and use authoritative Providence online state", () => {
  const snapshot = state();
  assert.equal(actionTarget(snapshot, "review-chat"), "Review Mac Pro · Workspace");
  assert.equal(deviceConnection(snapshot.devices[1]), "Offline in Providence");
  const choices = targetOptions(snapshot, "review-chat");
  assert.deepEqual(choices.map((choice) => choice.id), ["master", "demo-chat", "review-chat", "demoPC-chat"]);
  assert.match(choices[2].label, /Review Mac Pro.*Offline in Providence/);
  assert.match(choices[3].label, /DemoPC.*Connected to Providence/);
  assert.equal(choices[0].label, "All computers · Providence chooses");
});

test("rename and reconnect refresh labels without replacing selected chat or mutating snapshots", () => {
  const snapshot = state(), old = targetOptions(snapshot, "review-chat");
  snapshot.devices[1] = { ...snapshot.devices[1], name: "Review renamed", online: true };
  const before = structuredClone(snapshot), choices = targetOptions(snapshot, "review-chat");
  assert.notDeepEqual(choices, old);
  assert.equal(choices[2].id, "review-chat");
  assert.match(choices[2].label, /Review renamed.*Connected to Providence/);
  assert.deepEqual(snapshot, before);
});

test("removed chats and devices stay explicitly unavailable, never turn into a Mac or Superagent choice", () => {
  const snapshot = state();
  snapshot.chats = snapshot.chats.filter((chat) => chat.id !== "review-chat");
  const missing = targetOptions(snapshot, "review-chat").find((option) => option.id === "review-chat");
  assert.equal(missing?.label, "Unavailable conversation");
  snapshot.devices = snapshot.devices.filter((device) => device.id !== "demoPC");
  assert.equal(actionTarget(snapshot, "demoPC-chat"), "Disconnected computer · Workspace");
  assert.match(targetOptions(snapshot, "demoPC-chat").find((option) => option.id === "demoPC-chat")!.label, /Disconnected computer/);
});


test("stale snapshots retain identity without claiming the last online state is current", () => {
  const snapshot = state();
  assert.equal(deviceConnection(snapshot.devices[0], false), "Providence status unavailable");
  const choices = targetOptions(snapshot, "review-chat", false);
  assert.equal(choices[2].id, "review-chat");
  assert.match(choices[1].label, /Demo Mac.*Providence status unavailable/);
  assert.match(choices[2].label, /Review Mac Pro.*Providence status unavailable/);
  assert.ok(!choices[1].label.includes("Connected to Providence"));
});
