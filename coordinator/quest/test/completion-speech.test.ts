import { test } from "node:test";
import assert from "node:assert/strict";
import { CompletionSpeechGate } from "../src/completion-speech";

test("default enabled preference remains inert on mount, history, and pending recovery", () => {
  const gate = new CompletionSpeechGate();
  for (const requestId of ["history-task", "restored-pending-task", "latest-completed-task"]) {
    assert.equal(gate.claim(requestId, "master", "reply"), false);
  }
  gate.setEnabled(true);
  assert.equal(gate.claim("restored-pending-task", "master", "reply"), false);
  gate.arm("deliberately-accepted-voice-task", "master");
  assert.equal(gate.claim("deliberately-accepted-voice-task", "master", "actual-reply"), true);
});

test("only the exact armed accepted request and chat can claim its completion", () => {
  const gate = new CompletionSpeechGate();
  gate.arm("voice-task", "device-chat");
  assert.equal(gate.claim("different-task", "device-chat", "reply"), false);
  assert.equal(gate.claim("voice-task", "master", "reply"), false);
  assert.equal(gate.claim("voice-task", "device-chat", ""), false);
  assert.equal(gate.claim("voice-task", "device-chat", " \n"), false);
  assert.equal(gate.claim("voice-task", "device-chat", "exact-child-reply"), true);
});

test("claim is synchronous and consumes automatic eligibility before any playback await", async () => {
  const gate = new CompletionSpeechGate();
  gate.arm("voice-task", "master");
  let finish!: () => void;
  const pendingPlayback = new Promise<void>((resolve) => { finish = resolve; });
  let starts = 0;
  const attempt = async () => {
    if (!gate.claim("voice-task", "master", "child-reply")) return;
    starts++;
    await pendingPlayback;
  };
  const first = attempt();
  await attempt();
  assert.equal(starts, 1);
  finish();
  await first;
  assert.equal(gate.claim("voice-task", "master", "child-reply"), false);
});

test("an unknown paid outcome keeps its single claim and never creates an automatic retry", async () => {
  const gate = new CompletionSpeechGate();
  gate.arm("voice-task", "master");
  let attempts = 0;
  const simulateUnknownOutcome = async () => {
    if (!gate.claim("voice-task", "master", "child-reply")) return;
    attempts++;
    throw new Error("Simulated unknown paid outcome; no real provider call");
  };
  await assert.rejects(simulateUnknownOutcome(), /unknown paid outcome/);
  await simulateUnknownOutcome();
  gate.arm("voice-task", "master");
  await simulateUnknownOutcome();
  assert.equal(attempts, 1);
});

test("mute then unmute cannot revive or rearm the old request", () => {
  const gate = new CompletionSpeechGate();
  gate.arm("old-voice-task", "master");
  gate.setEnabled(false);
  gate.setEnabled(true);
  assert.equal(gate.claim("old-voice-task", "master", "late-reply"), false);
  gate.arm("old-voice-task", "master");
  assert.equal(gate.claim("old-voice-task", "master", "late-reply"), false);
  gate.arm("new-voice-task", "master");
  assert.equal(gate.claim("new-voice-task", "master", "new-reply"), true);
});

test("a request accepted while muted does not become eligible when unmuted", () => {
  const gate = new CompletionSpeechGate();
  gate.setEnabled(false);
  gate.arm("accepted-while-muted", "master");
  assert.equal(gate.claim("accepted-while-muted", "master", "reply"), false);
  gate.setEnabled(true);
  gate.arm("accepted-while-muted", "master");
  assert.equal(gate.claim("accepted-while-muted", "master", "reply"), false);
});

test("stop, chat change, logout, configuration loss and reconnect retire the prior eligibility", () => {
  for (const event of ["stop", "chat-change", "logout", "configuration-loss", "reconnect"]) {
    const gate = new CompletionSpeechGate();
    gate.arm(`before-${event}`, "master");
    gate.invalidate();
    gate.setEnabled(true);
    gate.arm(`before-${event}`, "master");
    assert.equal(gate.claim(`before-${event}`, "master", "late-reply"), false, event);
    gate.arm(`after-${event}`, "master");
    assert.equal(gate.claim(`after-${event}`, "master", "fresh-reply"), true, event);
  }
});

test("manual playback or downloaded-audio retry suppresses subsequent automatic completion", () => {
  for (const action of ["manual-read", "downloaded-retry"]) {
    const gate = new CompletionSpeechGate();
    gate.arm(action, "master");
    // The controller invalidates before calling its existing player; this gate
    // neither clears downloaded audio nor attempts another provider request.
    gate.invalidate();
    assert.equal(gate.claim(action, "master", "reply"), false);
    gate.arm(action, "master");
    assert.equal(gate.claim(action, "master", "reply"), false);
  }
});

test("repeated arm calls do not restore a consumed request or allow later child autoplay", () => {
  const gate = new CompletionSpeechGate();
  gate.arm("voice-task", "master");
  gate.arm("voice-task", "master");
  assert.equal(gate.claim("voice-task", "master", "first-completion"), true);
  gate.arm("voice-task", "master");
  assert.equal(gate.claim("voice-task", "master", "first-completion"), false);
  assert.equal(gate.claim("voice-task", "master", "later-child-result"), false);
  gate.arm("voice-task", "different-chat");
  assert.equal(gate.claim("voice-task", "different-chat", "later-child-result"), false);
});

test("a newly accepted primary voice request replaces the prior armed request", () => {
  const gate = new CompletionSpeechGate();
  gate.arm("old-task", "old-chat");
  gate.arm("new-task", "new-chat");
  assert.equal(gate.claim("old-task", "old-chat", "old-reply"), false);
  assert.equal(gate.claim("new-task", "new-chat", "new-reply"), true);
  gate.arm("old-task", "old-chat");
  assert.equal(gate.claim("old-task", "old-chat", "old-reply"), false);
});

test("malformed identities cannot arm or accidentally retain prior eligibility", () => {
  for (const [requestId, chatId] of [["", "master"], ["request", ""], [" \n", "master"]]) {
    const gate = new CompletionSpeechGate();
    gate.arm("prior", "master");
    gate.arm(requestId, chatId);
    assert.equal(gate.claim("prior", "master", "reply"), false);
    assert.equal(gate.claim(requestId, chatId, "reply"), false);
  }
});
