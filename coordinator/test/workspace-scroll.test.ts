import test from "node:test";
import assert from "node:assert/strict";
import { WorkspaceScrollLanding, workspaceScrollBehavior } from "../web/src/workspace-scroll.js";

test("initial empty loading waits for content and lands at latest only once", () => {
  const policy = new WorkspaceScrollLanding();
  assert.equal(policy.update("master", true, false), false);
  assert.equal(policy.update("master", true, true), true);
  assert.equal(policy.update("master", true, true), false);
  assert.equal(policy.update("master", true, true), false, "updates must not force a reader back down");
});

test("entering Workspace after hidden Voice lands at latest even without a task update", () => {
  const policy = new WorkspaceScrollLanding();
  assert.equal(policy.update("master", false, true), false);
  assert.equal(policy.update("master", true, true), true);
  assert.equal(policy.update("master", false, true), false);
  assert.equal(policy.update("master", true, true), true);
  assert.equal(policy.update("master", true, true), false);
});

test("chat changes get their own initial landing and hidden contexts cannot consume it", () => {
  const policy = new WorkspaceScrollLanding();
  assert.equal(policy.update("first", true, true), true);
  assert.equal(policy.update("second", true, false), false);
  assert.equal(policy.update("second", true, true), true);
  assert.equal(policy.update("third", false, true), false);
  assert.equal(policy.update("third", false, true), false);
  assert.equal(policy.update("third", true, true), true);
});

test("first landing and reduced-motion scrolling are immediate", () => {
  assert.equal(workspaceScrollBehavior(true, false), "auto");
  assert.equal(workspaceScrollBehavior(true, true), "auto");
  assert.equal(workspaceScrollBehavior(false, true), "auto");
  assert.equal(workspaceScrollBehavior(false, false), "smooth");
});
