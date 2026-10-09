import { fixtureStepUp } from "./fixtures/step-up.js";
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, generateKeyPairSync, createHash, sign } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { encodeCBOR } from "@levischuck/tiny-cbor";
import { Accounts } from "../src/hosted/accounts.js";
import { createHostedServer } from "../src/hosted/server.js";
import { ApiRuntime } from "../src/hosted/api-runtime.js";
import { Workspaces } from "../src/hosted/workspaces.js";

const hash = (s: string | Buffer) => createHash("sha256").update(s).digest();
function authenticator() {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = pair.publicKey.export({ format: "jwk" });
  const credentialID = randomBytes(32);
  const publicKey = encodeCBOR(new Map<number, any>([[1,2],[3,-7],[-1,1],[-2,new Uint8Array(Buffer.from(jwk.x!,"base64url"))],[-3,new Uint8Array(Buffer.from(jwk.y!,"base64url"))]]));
  return {
    credentialID, publicKey,
    register(challenge: string, origin: string) {
      const client = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge, origin, crossOrigin: false }));
      const length = Buffer.alloc(2); length.writeUInt16BE(credentialID.length);
      const authData = Buffer.concat([hash("localhost"), Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), length, credentialID, publicKey]);
      const attestation = encodeCBOR(new Map<string, any>([["fmt","none"],["attStmt",new Map()],["authData",new Uint8Array(authData)]]));
      return { id: credentialID.toString("base64url"), rawId: credentialID.toString("base64url"), type: "public-key", response: { clientDataJSON: client.toString("base64url"), attestationObject: Buffer.from(attestation).toString("base64url"), transports: ["internal"] }, clientExtensionResults: {} };
    },
    login(challenge: string, origin: string) {
      const client = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin, crossOrigin: false }));
      const authData = Buffer.concat([hash("localhost"), Buffer.from([0x05]), Buffer.from([0,0,0,1])]);
      return { id: credentialID.toString("base64url"), rawId: credentialID.toString("base64url"), type: "public-key", response: { clientDataJSON: client.toString("base64url"), authenticatorData: authData.toString("base64url"), signature: sign("sha256",Buffer.concat([authData,hash(client)]),pair.privateKey).toString("base64url") }, clientExtensionResults: {} };
    },
  };
}

test("account keys are encrypted, bound to the account, and never stored as plaintext", () => {
  const dir = mkdtempSync(join(tmpdir(),"providence-accounts-")); const db = new Accounts(join(dir,"accounts.sqlite"),randomBytes(32));
  try {
    const a=db.create("A"),b=db.create("B"),key="sk-"+"synthetic".repeat(8); db.setKey(a.id,key);
    assert.equal(db.readKey(a.id),key); assert.ok(!db.get(a.id)!.key!.includes(key));
    db.db.prepare("UPDATE accounts SET key=? WHERE id=?").run(db.get(a.id)!.key!,b.id);
    assert.throws(()=>db.readKey(b.id));
    assert.ok(!readFileSync(join(dir,"accounts.sqlite")).includes(Buffer.from(key)));
  } finally {db.close();rmSync(dir,{recursive:true,force:true});}
});

test("sessions and pairing codes are one-account, hashed, expiring and revocable",()=>{
  let now=100;const db=new Accounts(":memory:",randomBytes(32),()=>now);
  try {const a=db.create("A"),b=db.create("B"); const sa=db.session(a.id,"owner",10);const sb=db.session(b.id);
    assert.equal(db.authenticate(sa)?.account,a.id);assert.equal(db.authenticate(sb)?.account,b.id);
    assert.equal(db.authenticate("bad"),undefined);now=111;assert.equal(db.authenticate(sa),undefined);
    db.logout(sb);assert.equal(db.authenticate(sb),undefined);
    db.code(a.id,"client","ABCD-EFGH-JKLM");assert.throws(()=>db.consumeCode("ABCD-EFGH-JKLM","device"));
    assert.equal(db.consumeCode("abcd efgh jklm","client"),a.id);assert.throws(()=>db.consumeCode("ABCD-EFGH-JKLM","client"));
    const c=db.challenge({x:1});assert.deepEqual(db.consumeChallenge(c),{x:1});assert.throws(()=>db.consumeChallenge(c));
  } finally {db.close();}
});

test("real passkey registration and sign-in verify origin, challenge and signature",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"providence-passkeys-"));
  // Reserve a port first so the configured relying-party origin is exact.
  const {createServer}=await import("node:http");const reservation=createServer();reservation.listen(0,"127.0.0.1");await once(reservation,"listening");
  const port=(reservation.address() as any).port;await new Promise<void>(r=>reservation.close(()=>r()));
  const origin=`http://localhost:${port}`;const app=createHostedServer({directory:dir,origin,encryptionKey:randomBytes(32)});
  app.server.listen(port,"127.0.0.1");await once(app.server,"listening");
  const jar=new Map<string,string>();
  const send=async(path:string,body?:unknown,customOrigin=origin)=>{
    const r=await fetch(`http://127.0.0.1:${port}${path}`,{method:body===undefined?"GET":"POST",headers:{Origin:customOrigin,"Content-Type":"application/json",Cookie:[...jar].map(([k,v])=>`${k}=${v}`).join("; ")},...(body===undefined?{}:{body:JSON.stringify(body)})});
    for(const c of r.headers.getSetCookie()){const [k,v]=c.split(";")[0].split("=");jar.set(k,v);}
    return {status:r.status,body:await r.json()};
  };
  try {
    const authenticatorA=authenticator();let r=await send("/auth/registration/options",{name:"A"});assert.equal(r.status,200);
    const registration=authenticatorA.register(r.body.challenge,origin);
    r=await send("/auth/registration/verify",registration);assert.equal(r.status,200);
    r=await send("/auth/session");assert.equal(r.body.name,"A");assert.equal(r.body.keyConfigured,false);assert.equal(r.body.key,undefined);
    assert.equal((await send("/auth/registration/verify",registration)).status,400);
    assert.equal((await send("/v1/devices")).status,409);
    await send("/auth/logout",{});assert.equal((await send("/v1/devices")).status,401);
    r=await send("/auth/login/options",{});const login=authenticatorA.login(r.body.challenge,origin);
    assert.equal((await send("/auth/login/verify",login,"https://attacker.example")).status,403);
    assert.equal((await send("/auth/login/verify",login)).status,200);
    assert.equal((await send("/auth/session")).body.name,"A");
    await send("/auth/logout",{});r=await send("/auth/login/options",{});
    const forged=authenticatorA.login(r.body.challenge,origin);forged.response.signature=Buffer.alloc(70).toString("base64url");
    assert.equal((await send("/auth/login/verify",forged)).status,400);
    assert.equal((await send("/auth/session")).body.authenticated,false);
  }finally{await app.close();rmSync(dir,{recursive:true,force:true});}
});

test("hosted workspaces isolate devices and never start a local execution runtime",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"providence-tenants-"));const app=createHostedServer({directory:dir,origin:"http://localhost",encryptionKey:randomBytes(32)});
  try {const a=app.accounts.create("A"),b=app.accounts.create("B");for(const account of [a,b])app.accounts.setKey(account.id,"sk-"+"synthetic".repeat(8));
    const wa=await app.workspaces.get(a.id),wb=await app.workspaces.get(b.id);
    assert.notEqual(wa.port,wb.port);assert.notEqual(wa.token,wb.token);assert.notEqual(wa.app.directory,wb.app.directory);
    assert.deepEqual(wa.app.devices.list(),[]);assert.equal(wa.app.devices.local.connected,false);
    await assert.rejects(()=>wa.app.devices.call("hosted-server","chat.create"));
    const own=await fetch(`http://127.0.0.1:${wa.port}/v1/devices`,{headers:{Authorization:`Bearer ${wa.token}`}});assert.equal(own.status,200);
    const cross=await fetch(`http://127.0.0.1:${wa.port}/v1/devices`,{headers:{Authorization:`Bearer ${wb.token}`}});assert.equal(cross.status,401);
    wa.app.devices.registered.push({id:"only-a",name:"A computer"});assert.equal(wb.app.devices.list().some(d=>d.id==="only-a"),false);
  }finally{await app.close();rmSync(dir,{recursive:true,force:true});}
});

test("API coordination only calls its explicit tools and does not retry a failed provider request",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"providence-api-"));let calls=0,tools=0;
  const fetcher:typeof fetch=async(_url,init)=>{calls++;const body=JSON.parse(String(init!.body));assert.equal(body.store,false);assert.equal(body.tools.length,1);
    assert.equal(body.model,"test-model");assert.deepEqual(body.reasoning,{effort:"low"});assert.equal(body.service_tier,"fast");
    if(calls===1)return Response.json({status:"completed",output:[{type:"function_call",name:"list",call_id:"call",arguments:"{}"}]});
    assert.equal(body.input.at(-1).type,"function_call_output");return Response.json({status:"completed",output:[{type:"message",id:"m",content:[{type:"output_text",text:"One device."}]}]});};
  const runtime=new ApiRuntime({root:dir,tools:[{name:"list",inputSchema:{type:"object",properties:{}}}],toolHandler:async()=>{tools++;return {devices:[]};}},join(dir,"thread.json"),()=>"synthetic", "test-model",fetcher);
  try {await runtime.start();const chat=await runtime.create();const done=new Promise<any>(resolve=>runtime.on("event",e=>{if(e.type==="task.completed")resolve(e);}));
    await runtime.execute(chat.threadId,"task","List devices");assert.equal((await done).text,"One device.");assert.equal(tools,1);assert.equal(calls,2);
    let failedCalls=0;const failed=new ApiRuntime({root:dir},join(dir,"failed.json"),()=>"synthetic","test-model",async()=>{failedCalls++;return new Response("private error",{status:401});});
    await failed.start();const c=await failed.create();const failure=new Promise<any>(resolve=>failed.on("event",e=>{if(e.type==="task.failed")resolve(e);}));
    await failed.execute(c.threadId,"fail","Go");assert.match((await failure).error,/API key/);assert.equal(failedCalls,1);failed.stop();
  }finally{runtime.stop();rmSync(dir,{recursive:true,force:true});}
});

test("hosted coordination defaults to GPT-6 Sol Low Fast and preserves an explicit model override", async () => {
  for (const model of [undefined, "gpt-5.6-sol"]) {
    const directory = mkdtempSync(join(tmpdir(), "providence-hosted-model-"));
    const accounts = new Accounts(join(directory, "accounts.sqlite"), randomBytes(32));
    const account = accounts.create("Synthetic model profile");
    accounts.setKey(account.id, "synthetic-fixture-key-only"); accounts.acceptAIConsent(account.id, "2026-10-02");
    const payloads: any[] = [];
    const provider: typeof fetch = async (url, init) => {
      assert.equal(url, "https://api.openai.com/v1/responses");
      assert.equal(init?.redirect, "error");
      payloads.push(JSON.parse(String(init?.body)));
      return Response.json({ status: "completed", output: [{ type: "message", id: "fixture-message", content: [{ type: "output_text", text: "Synthetic response." }] }] });
    };
    const workspaces = new Workspaces(directory, "https://providence.example", accounts, model, provider);
    try {
      const workspace = await workspaces.get(account.id);
      const thread = await workspace.app.master.create();
      const completed = new Promise<void>((accept, reject) => workspace.app.master.on("event", event => {
        if (event.type === "task.completed") accept();
        else if (event.type === "task.failed") reject(new Error(event.error));
      }));
      await workspace.app.master.execute(thread.threadId, "fixture-task", "Return a synthetic response.");
      await completed;
      assert.equal(payloads.length, 1);
      assert.equal(payloads[0].model, model ?? "gpt-6-sol");
      assert.deepEqual(payloads[0].reasoning, { effort: "low" });
      assert.equal(payloads[0].service_tier, "fast");
      assert.equal(payloads[0].store, false);
    } finally { await workspaces.stop(); accounts.close(); rmSync(directory, { recursive: true, force: true }); }
  }
});

test("gateway rejects cross-origin writes, revoked sessions and forged WebSocket device tokens",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"providence-gateway-"));const origin="https://providence.example";
  const app=createHostedServer({directory:dir,origin,encryptionKey:randomBytes(32)});
  app.server.listen(0,"127.0.0.1");await once(app.server,"listening");const port=(app.server.address() as any).port;
  const base=`http://127.0.0.1:${port}`;
  try {
    const a=app.accounts.create("A"),b=app.accounts.create("B");for(const u of [a,b])app.accounts.setKey(u.id,"sk-"+"synthetic".repeat(8));
    const sa=app.accounts.session(a.id),sb=app.accounts.session(b.id);
    const headers=(s:string)=>({Cookie:`__Host-providence=${s}`,Origin:origin,"Content-Type":"application/json"});
    let r=await fetch(base+"/v1/devices/pair",{method:"POST",headers:headers(sa),body:JSON.stringify({name:"Only A",stepUpToken:fixtureStepUp(app.accounts,sa,"pair_device","Only A")})});assert.equal(r.status,201);
    const code=(await r.json() as any).code;
    r=await fetch(base+"/pair/exchange",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({code})});assert.equal(r.status,200);const device=await r.json() as any;
    const aDevices=await (await fetch(base+"/v1/devices",{headers:headers(sa)})).json() as any;
    const bDevices=await (await fetch(base+"/v1/devices",{headers:headers(sb)})).json() as any;
    assert.ok(aDevices.devices.some((d:any)=>d.id===device.deviceId));assert.ok(!bDevices.devices.some((d:any)=>d.id===device.deviceId));
    assert.equal((await fetch(base+"/v1/devices/pair",{method:"POST",headers:{Cookie:`__Host-providence=${sa}`,"Content-Type":"application/json"},body:'{"name":"bad"}'})).status,403);
    assert.equal((await fetch(base+"/v1/devices/pair",{method:"POST",headers:{...headers(sa),Origin:"https://attacker.example"},body:'{"name":"bad"}'})).status,403);
    const {WebSocket}=await import("ws");const socket=new WebSocket(`ws://127.0.0.1:${port}/worker?deviceId=${device.deviceId}`,{headers:{Authorization:`Bearer ${"wrong".repeat(16)}`}});
    const rejected=new Promise<number>((resolve,reject)=>{socket.on("unexpected-response",(_request,response)=>{resolve(response.statusCode!);response.destroy();socket.terminate();});socket.on("error",()=>{});socket.on("open",()=>reject(new Error("Forged token connected")));});
    assert.equal(await rejected,401);
    const watchCodeResponse = await fetch(base+"/v1/clients/pair", { method:"POST", headers:headers(sa), body:JSON.stringify({name:"Watch A",stepUpToken:fixtureStepUp(app.accounts,sa,"pair_client","Watch A")}) });
    assert.equal(watchCodeResponse.status,201); const watchCode = (await watchCodeResponse.json() as any).code;
    const watchResponse = await fetch(base+"/client/exchange", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({code:watchCode})});
    assert.equal(watchResponse.status,200); const watchSession = await watchResponse.json() as any;
    const watchHeaders = {Authorization:`Bearer ${watchSession.token}`};
    const watchDevices = await (await fetch(base+"/v1/devices",{headers:watchHeaders})).json() as any;
    assert.ok(watchDevices.devices.some((d:any)=>d.id===device.deviceId));
    assert.equal((await fetch(base+"/v1/devices/pair",{method:"POST",headers:{...watchHeaders,"Content-Type":"application/json"},body:'{"name":"unauthorized"}'})).status,403);
    const voice = await (await fetch(base+"/v1/voice",{headers:watchHeaders})).json() as any;
    assert.equal(voice.transcriptionConfigured,true);assert.equal(voice.deviceId,"providence-voice");
    assert.ok(Date.parse(watchSession.expiresAt)-Date.now()>29*86400_000);
    app.accounts.logout(sa);assert.equal((await fetch(base+"/v1/devices",{headers:headers(sa)})).status,401);
    assert.equal((await fetch(base+"/v1/devices",{headers:headers(sb)})).status,200);
    assert.equal((await fetch(base+"/pair/exchange",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({code})})).status,400);
  }finally{await app.close();rmSync(dir,{recursive:true,force:true});}
});
