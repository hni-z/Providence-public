import test from "node:test";
import assert from "node:assert/strict";
import { api, ApiError } from "../web/src/api.js";
import { validateWorkspaceResponse } from "../web/src/workspace-response.js";

test("a truncated successful HTTP response fails before a fabricated error object can become task state", async () => {
  const previous = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('{"tasks":[', {status:200, headers:{"Content-Type":"application/json"}});
    await assert.rejects(api("synthetic-test-token", "/tasks"), error => error instanceof ApiError && error.status === 502 && /unreadable/.test(error.message));
    globalThis.fetch = async () => new Response("private broken body", {status:401});
    await assert.rejects(api("synthetic-test-token", "/tasks"), error => error instanceof ApiError && error.status === 401 && !error.message.includes("private broken body"));
  } finally { globalThis.fetch = previous; }
});

test("workspace polls reject malformed collections and task rows before replacing a usable snapshot", () => {
  const briefing = {devices:[{id:"device",name:"PC",online:true}],approvals:[]};
  const chats = {chats:[{id:"chat",name:"Work",deviceId:"device",threadId:"thread"}]};
  const tasks = {tasks:[{id:"task",chatId:"chat",deviceId:"device",prompt:"hello",text:"ready",status:"completed",createdAt:"2026-09-26T00:00:00Z",updatedAt:"2026-09-26T00:00:00Z"}]};
  const activity = {events:[{type:"task.completed",at:"2026-09-26T00:00:00Z",sequence:1}],latestSequence:1};
  assert.doesNotThrow(() => validateWorkspaceResponse(briefing,chats,tasks,activity));
  for (const invalid of [undefined,null,{}, {error:"unreadable"}, {tasks:null}, {tasks:[null]}, {tasks:[{...tasks.tasks[0],createdAt:undefined}]}])
    assert.throws(() => validateWorkspaceResponse(briefing,chats,invalid,activity), /workspace update/);
  assert.throws(() => validateWorkspaceResponse({...briefing,devices:undefined},chats,tasks,activity));
  assert.throws(() => validateWorkspaceResponse(briefing,{chats:[null]},tasks,activity));
  assert.throws(() => validateWorkspaceResponse(briefing,chats,tasks,{events:[],latestSequence:undefined}));
  assert.doesNotThrow(() => validateWorkspaceResponse({devices:[],approvals:[]},{chats:[]},{tasks:[]},{events:[],latestSequence:0}));
});
