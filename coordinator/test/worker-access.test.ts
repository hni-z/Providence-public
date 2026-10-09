import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runtime } from "../src/runtime.js";
import { parseDeviceConfig, workerAccessForProvidence } from "../src/device-config.js";
import { Coordinator } from "../src/coordinator.js";

test("legacy companion config remains readable and preserves identity and model settings", () => {
 const input = {
  deviceId: "registered-worker", token: "private-credential-".repeat(3),
  url: "wss://example.com/worker", workspace: "/workspace",
  workerModel: "gpt-5.6-sol", workerReasoningEffort: "low",
 };
 const legacy = parseDeviceConfig(JSON.stringify(input));
 assert.equal(legacy.workerAccess, undefined);
 assert.deepEqual(legacy, input);
 for (const workerAccess of ["workspace", "full-access"] as const) {
  const parsed = parseDeviceConfig(JSON.stringify({ ...input, workerAccess }));
  assert.deepEqual(parsed, { ...input, workerAccess });
 }
});

test("invalid companion access fails with a safe hint and cannot become full access", () => {
 const privateToken = "private-device-token-".repeat(3);
 const input = { deviceId: "registered-worker", token: privateToken, url: "wss://example.com/worker", workspace: "/workspace" };
 for (const workerAccess of [true, false, null, 1, "", "FullAccess", "danger-full-access", ":danger-full-access", "full-access ", ["full-access"], { access: "full-access" }, "private-invalid-access"]) {
  assert.throws(() => parseDeviceConfig(JSON.stringify({ ...input, workerAccess })), (error: any) => {
   assert.match(error.message, /workerAccess \(workspace or full-access\)/);
   assert.equal(error.message.includes(privateToken), false);
   assert.equal(error.message.includes("private-invalid-access"), false);
   return true;
  });
 }
});

test("Providence product factories default omitted access to workspace and preserve explicit modes", () => {
 const root = mkdtempSync(join(tmpdir(), "providence-product-access-"));
 try {
  for (const [configured, expected] of [[undefined, "workspace"], ["workspace", "workspace"], ["full-access", "full-access"]] as const) {
   assert.equal(workerAccessForProvidence(configured), expected);
   const app = new Coordinator({ clientToken: "x".repeat(64), localDeviceId: "mac", localDeviceName: "Mac", workspace: root, localWorkerAccess: configured, devices: [] }, root);
   assert.equal(app.devices.local.options.workerAccess, expected);
   assert.equal(app.master.options.master, true);
   assert.equal(app.master.options.workerAccess, undefined);
   app.stop();
  }
 } finally { rmSync(root, { recursive: true, force: true }); }
});

test("explicit worker full access is checked at discovery, creation and resume; master keeps routing sandbox", async () => {
 const directory=mkdtempSync(join(tmpdir(),"providence-access-")); const root=realpathSync(directory);
 try {
  const calls: {method:string;params:any}[]=[];
  const config=parseDeviceConfig(JSON.stringify({deviceId:'registered-worker',token:'private-token-'.repeat(4),url:'wss://example.com/worker',workspace:root,workerAccess:'full-access'}));
  const worker=new Runtime({root:config.workspace,workerAccess:config.workerAccess});
  worker.rpc.start=async()=>{};
  worker.rpc.call=async(method,params)=>{calls.push({method,params});
   if(method==='account/read')return {account:{type:'chatgpt'}};
   if(method==='permissionProfile/list')return {data:[{id:':danger-full-access',allowed:true}]};
   if(method==='model/list')return {data:[{model:'gpt-6-sol',supportedReasoningEfforts:[{reasoningEffort:'low'}],serviceTiers:[{id:'priority'}]}],nextCursor:null};
   if(method==='thread/read')return {thread:{cwd:root}};
   return {thread:{id:'worker'},approvalPolicy:'never',sandbox:{type:'dangerFullAccess'},model:'gpt-6-sol',reasoningEffort:'low',serviceTier:'priority'};
  };
  await worker.start(); await worker.create(); await worker.importThread('worker');
  for(const call of calls.filter(c=>['thread/start','thread/resume'].includes(c.method))){
   assert.equal(call.params.permissions,':danger-full-access');assert.equal(call.params.approvalPolicy,'never');assert.equal(call.params.sandbox,undefined);
  }
  const master=new Runtime({root,master:true,workerAccess:'full-access'});
  master.rpc.call=async(_method,params)=>{assert.equal(params.approvalPolicy,'on-request');assert.equal(params.sandbox,'read-only');assert.equal(params.permissions,undefined);return {thread:{id:'master'},model:'gpt-6-sol',reasoningEffort:'low',serviceTier:'priority'};};
  await master.create();
 }finally{rmSync(directory,{recursive:true,force:true});}
});
test("unavailable or unconfirmed full access fails before turn execution instead of silently widening or falling back",async()=>{
 const root=mkdtempSync(join(tmpdir(),'providence-access-'));
 try{
  const worker=new Runtime({root,workerAccess:'full-access'});worker.rpc.start=async()=>{};
  worker.rpc.call=async method=>method==='account/read'?{account:{type:'chatgpt'}}:{data:[{id:':danger-full-access',allowed:false}]};
  await assert.rejects(worker.start(),/not permitted/);
  worker.rpc.call=async()=>({thread:{id:'worker'},approvalPolicy:'on-request',sandbox:{type:'workspaceWrite'}});
  await assert.rejects(worker.create(),/did not confirm/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
