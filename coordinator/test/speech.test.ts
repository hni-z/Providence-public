import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Speech,SpeechError } from '../src/speech.js';
import { Coordinator } from '../src/coordinator.js';
import { createHttpServer } from '../src/server.js';

test('speech keeps credentials server-side, bounds input, and does not replay accepted request identities',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'providence-speech-'));const file=join(dir,'voice.env');
 writeFileSync(file,'OPENAI_API_KEY=test-private-credential-value',{mode:0o600});
 let calls=0;
 try{
  const speech=new Speech({transcriptionEnvFile:file},async(url,options)=>{
   calls++;assert.equal(url,'https://api.openai.com/v1/audio/speech');
   const body=JSON.parse(String(options?.body));assert.equal(body.model,'gpt-4o-mini-tts');assert.equal(body.voice,'marin');
   assert.equal(JSON.stringify(body).includes('credential'),false);
   return new Response(new Uint8Array([1,2,3]),{headers:{'content-type':'audio/mpeg'}});
  });
  await assert.rejects(speech.synthesize({requestId:'long',text:'x'.repeat(4001)}),e=>e instanceof SpeechError&&e.status===400);
  assert.deepEqual(await speech.synthesize({requestId:'one',text:'A fresh reply'}),Buffer.from([1,2,3]));
  await assert.rejects(speech.synthesize({requestId:'one',text:'A fresh reply'}),e=>e instanceof SpeechError&&e.status===409);
  assert.equal(calls,1);assert.equal(JSON.stringify(speech).includes('credential'),false);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('speech never returns raw provider failures and failed outcomes cannot be automatically replayed',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'providence-speech-'));const file=join(dir,'voice.env');writeFileSync(file,'OPENAI_API_KEY=test-private-credential-value');
 try{
  const speech=new Speech({transcriptionEnvFile:file},async()=>new Response('raw-private-provider-detail',{status:401}));
  await assert.rejects(speech.synthesize({requestId:'failed',text:'Hello'}),e=>e instanceof SpeechError&&e.status===503&&!e.message.includes('raw-private'));
  await assert.rejects(speech.synthesize({requestId:'failed',text:'Hello'}),e=>e instanceof SpeechError&&e.status===409);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('stopping speech aborts the provider request and retains its consumed identity',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'providence-speech-stop-'));const file=join(dir,'voice.env');writeFileSync(file,'OPENAI_API_KEY=test-private-credential-value');
 try{
  let started!:()=>void;const ready=new Promise<void>(r=>started=r);
  const speech=new Speech({transcriptionEnvFile:file},async(_url,options)=>new Promise((_resolve,reject)=>{
   const stop=()=>reject(new DOMException('private raw reason','AbortError'));
   options?.signal?.addEventListener('abort',stop,{once:true});started();
  }));
  const controller=new AbortController();const pending=speech.synthesize({requestId:'stopped',text:'Hello'},controller.signal);
  await ready;controller.abort();
  await assert.rejects(pending,e=>e instanceof SpeechError&&e.status===499&&!e.message.includes('private'));
  await assert.rejects(speech.synthesize({requestId:'stopped',text:'Hello'}),e=>e instanceof SpeechError&&e.status===409);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('voice routes require existing authentication and allowed origin before accepting input',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'providence-speech-http-'));
 const config={clientToken:'x'.repeat(64),localDeviceId:'mac',localDeviceName:'Mac',workspace:dir,devices:[]};
 const app=new Coordinator(config,dir);const server=createHttpServer(app,config.clientToken,{publicOrigin:'https://providence.example'});
 await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const origin=`http://127.0.0.1:${(server.address() as any).port}`;
 try{
  assert.equal((await fetch(origin+'/v1/voice')).status,401);
  assert.equal((await fetch(origin+'/v1/speech',{method:'POST',body:'{}'})).status,401);
  assert.equal((await fetch(origin+'/v1/speech',{method:'POST',headers:{Authorization:`Bearer ${config.clientToken}`,Origin:'https://untrusted.example'},body:'{}'})).status,403);
  const response=await fetch(origin+'/v1/voice',{headers:{Authorization:`Bearer ${config.clientToken}`}});
  assert.equal(response.status,200);assert.equal((await response.json()).provider,'OpenAI');
  assert.equal(Object.keys(app.store.state.tasks).length,0);
 }finally{await new Promise<void>(done=>server.close(()=>done()));rmSync(dir,{recursive:true,force:true});}
});
