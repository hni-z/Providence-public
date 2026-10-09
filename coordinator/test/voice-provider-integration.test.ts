import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runtime } from '../src/runtime.js';
import { runtimeMetadata, loadDeviceTranscription } from '../src/device-config.js';
import { runtimeRequest } from '../src/devices.js';
import { Speech, SpeechError } from '../src/speech.js';
import { Coordinator } from '../src/coordinator.js';
import { createHttpServer } from '../src/server.js';

function fixture() {
 const directory=mkdtempSync(join(tmpdir(),'providence-voice-provider-'));
 const openai=join(directory,'openai.env'),elevenlabs=join(directory,'elevenlabs.env');
 writeFileSync(openai,'OPENAI_API_KEY=fixture-openai-private-key\n',{mode:0o600});
 writeFileSync(elevenlabs,'ELEVENLABS_API_KEY=fixture-elevenlabs-private-key\n',{mode:0o600});
 return {directory,openai,elevenlabs,cleanup:()=>rmSync(directory,{recursive:true,force:true})};
}
const recording={base64:Buffer.from('fake fixture audio').toString('base64'),mimeType:'audio/webm'};

test('Runtime retains the ElevenLabs discriminant and emits only safe provider metadata',async()=>{
 const f=fixture(),original=globalThis.fetch;let calls=0;
 try{
  const settings=loadDeviceTranscription({transcriptionProvider:'elevenlabs',elevenLabsEnvFile:f.elevenlabs,transcriptionEnvFile:f.openai},{});
  const runtime=new Runtime({root:f.directory},settings);
  runtime.rpc.call=async()=>{throw new Error('Speech must not call the agent runtime');};
  globalThis.fetch=async(url,options)=>{
   calls++;assert.equal(url,'https://api.elevenlabs.io/v1/speech-to-text');
   assert.equal(new Headers(options?.headers).get('xi-api-key'),'fixture-elevenlabs-private-key');
   assert.equal(new Headers(options?.headers).has('authorization'),false);
   assert.equal((options?.body as FormData).get('model_id'),'scribe_v2');
   return Response.json({text:'A fixture transcript'});
  };
  assert.deepEqual(await runtimeRequest(runtime,'audio.transcribe',recording),{text:'A fixture transcript'});
  assert.equal(calls,1);assert.equal(runtime.transcriptionProvider,'ElevenLabs');
  const metadata=runtimeMetadata(runtime.root,runtime.hasTranscription,runtime.transcriptionProvider);
  assert.equal(metadata.transcriptionProvider,'ElevenLabs');
  assert.equal(JSON.stringify(metadata).includes('private-key'),false);
  assert.equal(JSON.stringify(metadata).includes('elevenlabs.env'),false);
  assert.equal(runtimeMetadata(runtime.root,false,'ElevenLabs').transcriptionProvider,undefined);
 }finally{globalThis.fetch=original;f.cleanup();}
});

test('Speech selects only its explicit output provider and retains one-request/busy ownership',async()=>{
 const f=fixture();let calls=0,release!:()=>void;
 try{
  const speech=new Speech({speechProvider:'elevenlabs',transcriptionProvider:'openai',transcriptionEnvFile:f.openai,elevenLabsEnvFile:f.elevenlabs,elevenLabsVoiceId:'fixtureVoice'},async(url,options)=>{
   calls++;assert.equal(String(url),'https://api.elevenlabs.io/v1/text-to-speech/fixtureVoice/stream?output_format=mp3_44100_128');
   assert.equal(new Headers(options?.headers).get('xi-api-key'),'fixture-elevenlabs-private-key');
   assert.equal(options?.redirect,'error');
   assert.deepEqual(JSON.parse(String(options?.body)),{text:'A new reply',model_id:'eleven_flash_v2_5'});
   await new Promise<void>(resolve=>release=resolve);
   return new Response(new Uint8Array([1,2,3]),{headers:{'content-type':'audio/mpeg'}});
  });
  assert.equal(speech.provider,'ElevenLabs');assert.equal(speech.configured,true);
  const first=speech.synthesize({requestId:'first',text:'A new reply'});
  await assert.rejects(speech.synthesize({requestId:'first',text:'A new reply'}),e=>e instanceof SpeechError&&e.status===409);
  await assert.rejects(speech.synthesize({requestId:'second',text:'A new reply'}),e=>e instanceof SpeechError&&e.status===409);
  release();assert.deepEqual(await first,Buffer.from([1,2,3]));assert.equal(calls,1);
  assert.equal(JSON.stringify(speech).includes('private-key'),false);
  const independent=new Speech({transcriptionProvider:'elevenlabs',transcriptionEnvFile:f.openai,elevenLabsEnvFile:f.elevenlabs},async(url,options)=>{
   assert.equal(url,'https://api.openai.com/v1/audio/speech');
   assert.equal(new Headers(options?.headers).get('authorization'),'Bearer fixture-openai-private-key');
   assert.equal(options?.redirect,'error');
   return new Response(new Uint8Array([1]),{headers:{'content-type':'audio/mpeg'}});
  });
  assert.equal(independent.provider,'OpenAI');await independent.synthesize({requestId:'openai',text:'Reply'});
 }finally{f.cleanup();}
});

test('ElevenLabs needs an explicit voice and late body cancellation cannot return audio or replay',async()=>{
 const f=fixture();let calls=0;
 try{
  const unavailable=new Speech({speechProvider:'elevenlabs',elevenLabsEnvFile:f.elevenlabs},async()=>{throw new Error('must not call');});
  assert.equal(unavailable.configured,false);assert.equal(unavailable.voice,undefined);assert.equal(unavailable.unavailableReason,'voice_id_required');
  await assert.rejects(unavailable.synthesize({requestId:'missing-voice',text:'Reply'}),e=>e instanceof SpeechError&&e.status===503);
  const controller=new AbortController();
  const speech=new Speech({speechProvider:'elevenlabs',elevenLabsEnvFile:f.elevenlabs,elevenLabsVoiceId:'fixtureVoice'},async()=>{
   calls++;
   return new Response(new ReadableStream<Uint8Array>({pull(stream){controller.abort();stream.enqueue(new Uint8Array([1,2,3]));stream.close();}},{highWaterMark:0}),{headers:{'content-type':'audio/mpeg'}});
  });
  await assert.rejects(speech.synthesize({requestId:'stopped',text:'Reply'},controller.signal),e=>e instanceof SpeechError&&e.status===499);
  await assert.rejects(speech.synthesize({requestId:'stopped',text:'Reply'}),e=>e instanceof SpeechError&&e.status===409);
  assert.equal(calls,1);
 }finally{f.cleanup();}
});

test('provider errors remain fixed, credit-aware and single-attempt at the Speech boundary',async()=>{
 const f=fixture();
 try{
  for(const [status,expected] of [[401,503],[402,402],[403,503],[422,503],[429,429],[500,503]]){
   let calls=0;
   const speech=new Speech({speechProvider:'elevenlabs',elevenLabsEnvFile:f.elevenlabs,elevenLabsVoiceId:'fixtureVoice'},async()=>{calls++;return new Response('raw-secret-provider-detail',{status});});
   await assert.rejects(speech.synthesize({requestId:'one',text:'Reply'}),e=>e instanceof SpeechError&&e.status===expected&&!e.message.includes('raw-secret'));
   await assert.rejects(speech.synthesize({requestId:'one',text:'Reply'}),e=>e instanceof SpeechError&&e.status===409);
   assert.equal(calls,1);
  }
 }finally{f.cleanup();}
});

test('authenticated discovery and STT preserve per-device provider, durable identity, and the existing task boundary',async()=>{
 const f=fixture();
 const config={clientToken:'k'.repeat(64),localDeviceId:'mac',localDeviceName:'Mac',workspace:f.directory,devices:[],transcriptionProvider:'elevenlabs' as const,speechProvider:'elevenlabs' as const,elevenLabsEnvFile:f.elevenlabs};
 const app=new Coordinator(config,f.directory);let calls=0;
 const devices=[{id:'mac',name:'Mac',local:true,connectionState:'online',online:true,capabilities:{files:true,shell:true,browser:false,desktop:false,phoneMirroring:false,transcription:true},transcriptionProvider:'ElevenLabs' as const},{id:'legacy',name:'Legacy fixture',local:false,connectionState:'online',online:true,capabilities:{files:true,shell:true,browser:false,desktop:false,phoneMirroring:false,transcription:true}}];
 app.devices.list=()=>devices.map(device=>({...device,connectionStatus:{state:'online' as const,reasonCode:'ready' as const}}));
 app.devices.call=async(deviceId,method,params)=>{calls++;assert.equal(deviceId,'mac');assert.equal(method,'audio.transcribe');assert.deepEqual(params,recording);return {text:'Recognized fixture request'};};
 const server=createHttpServer(app,config.clientToken,{publicOrigin:'https://providence.example'});
 await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const origin=`http://127.0.0.1:${(server.address() as any).port}`;
 const request=(path:string,body?:unknown,auth=true)=>fetch(origin+path,{method:body===undefined?'GET':'POST',headers:{...(auth?{Authorization:`Bearer ${config.clientToken}`}:{ }),'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
 try{
  assert.equal((await request('/v1/voice',undefined,false)).status,401);
  const voice=await(await request('/v1/voice')).json();
  assert.equal(voice.provider,'ElevenLabs');assert.equal(voice.speechConfigured,false);assert.equal(voice.transcriptionConfigured,true);assert.equal(voice.voice,null);assert.equal(voice.reason,'voice_id_required');
  const cap=await(await request('/v1/transcriptions')).json();
  assert.equal(cap.transcription.provider,'ElevenLabs');assert.equal(cap.transcription.devices[0].provider,'ElevenLabs');assert.equal(cap.transcription.devices[1].provider,'OpenAI');
  assert.equal(JSON.stringify([voice,cap]).includes('private-key'),false);assert.equal(JSON.stringify([voice,cap]).includes('elevenlabs.env'),false);
  const body={requestId:'one-stt',deviceId:'mac',...recording,provider:'OpenAI',apiKey:'not-used-client-override',model:'not-used-model'};
  const accepted=await request('/v1/transcriptions',body);assert.equal(accepted.status,202);const job=await accepted.json();
  const result=await(await request('/v1/transcriptions/'+job.id)).json();assert.equal(result.status,'completed');assert.equal(result.text,'Recognized fixture request');
  devices[0].transcriptionProvider='OpenAI' as any;
  const repeat=await(await request('/v1/transcriptions',body)).json();assert.equal(repeat.id,job.id);assert.equal(calls,1);
  assert.equal((await request('/v1/transcriptions',{...body,base64:Buffer.from('different').toString('base64')})).status,409);
  assert.equal(Object.keys(app.store.state.tasks).length,0,'transcribing never starts another agent conversation/task');
 }finally{await new Promise<void>(done=>server.close(()=>done()));f.cleanup();}
});

test('authenticated ElevenLabs speech returns bounded audio and consumes duplicate IDs without starting tasks',async()=>{
 const f=fixture(),original=globalThis.fetch;let providerCalls=0;
 const config={clientToken:'k'.repeat(64),localDeviceId:'mac',localDeviceName:'Mac',workspace:f.directory,devices:[],speechProvider:'elevenlabs' as const,elevenLabsEnvFile:f.elevenlabs,elevenLabsVoiceId:'fixtureVoice'};
 globalThis.fetch=async(url,options)=>{
  if(String(url).startsWith('https://api.elevenlabs.io/')){providerCalls++;return new Response(new Uint8Array([1,2,3]),{headers:{'content-type':'audio/mpeg'}});}
  return original(url,options);
 };
 const app=new Coordinator(config,f.directory),server=createHttpServer(app,config.clientToken,{publicOrigin:'https://providence.example'});
 await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const origin=`http://127.0.0.1:${(server.address() as any).port}`;
 const headers={Authorization:`Bearer ${config.clientToken}`,'Content-Type':'application/json'};
 try{
  assert.equal((await original(origin+'/v1/speech',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);
  assert.equal((await original(origin+'/v1/speech',{method:'POST',headers:{...headers,Origin:'https://untrusted.example'},body:'{}'})).status,403);
  assert.equal(providerCalls,0);
  const body=JSON.stringify({requestId:'speech-once',text:'A fresh assistant reply'});
  const first=await original(origin+'/v1/speech',{method:'POST',headers,body});assert.equal(first.status,200);assert.equal(first.headers.get('content-type'),'audio/mpeg');assert.equal(first.headers.get('cache-control'),'no-store');assert.deepEqual(Buffer.from(await first.arrayBuffer()),Buffer.from([1,2,3]));
  assert.equal((await original(origin+'/v1/speech',{method:'POST',headers,body})).status,409);assert.equal(providerCalls,1);
  assert.equal((await original(origin+'/v1/speech',{method:'POST',headers,body:JSON.stringify({requestId:'bad',text:'Text',provider:'openai',apiKey:'client-must-not-control-provider'})})).status,400);
  assert.equal(Object.keys(app.store.state.tasks).length,0);assert.equal(providerCalls,1);
 }finally{globalThis.fetch=original;await new Promise<void>(done=>server.close(()=>done()));f.cleanup();}
});

test('closing the speech HTTP response aborts its provider transport and the service remains usable',async()=>{
 const f=fixture(),original=globalThis.fetch;let providerCalls=0;
 let started!:()=>void,aborted!:()=>void;const ready=new Promise<void>(r=>started=r),stopped=new Promise<void>(r=>aborted=r);
 const config={clientToken:'k'.repeat(64),localDeviceId:'mac',localDeviceName:'Mac',workspace:f.directory,devices:[],speechProvider:'elevenlabs' as const,elevenLabsEnvFile:f.elevenlabs,elevenLabsVoiceId:'fixtureVoice'};
 globalThis.fetch=async(url,options)=>{
  if(!String(url).startsWith('https://api.elevenlabs.io/'))return original(url,options);
  providerCalls++;started();return new Promise((_resolve,reject)=>{
   options?.signal?.addEventListener('abort',()=>{aborted();reject(new DOMException('aborted fixture','AbortError'));},{once:true});
  });
 };
 const app=new Coordinator(config,f.directory),server=createHttpServer(app,config.clientToken,{publicOrigin:'https://providence.example'});
 await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const origin=`http://127.0.0.1:${(server.address() as any).port}`;
 const headers={Authorization:`Bearer ${config.clientToken}`,'Content-Type':'application/json'},body=JSON.stringify({requestId:'stopped-http',text:'Fresh reply'}),controller=new AbortController();
 try{
  const pending=original(origin+'/v1/speech',{method:'POST',headers,body,signal:controller.signal});
  const rejected=assert.rejects(pending,{name:'AbortError'});
  await ready;controller.abort();await rejected;
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{await Promise.race([stopped,new Promise((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('provider did not abort')),1500);})]);}finally{clearTimeout(timer);}
  assert.equal((await original(origin+'/health')).status,200);
  assert.equal((await original(origin+'/v1/speech',{method:'POST',headers,body})).status,409);
  assert.equal(providerCalls,1);assert.equal(Object.keys(app.store.state.tasks).length,0);
 }finally{globalThis.fetch=original;await new Promise<void>(done=>server.close(()=>done()));f.cleanup();}
});

test('a completed transcription broadcasts its identity without the transcript text',async()=>{
 const f=fixture();
 const transcript='Private spoken request text';
 const config={clientToken:'k'.repeat(64),localDeviceId:'mac',localDeviceName:'Mac',workspace:f.directory,devices:[]};
 const app=new Coordinator(config,f.directory);
 app.devices.list=()=>[{id:'mac',name:'Mac',local:true,connectionState:'online',online:true,capabilities:{files:true,shell:true,browser:false,desktop:false,phoneMirroring:false,transcription:true}}] as any;
 app.devices.call=async()=>({text:transcript});
 const server=createHttpServer(app,config.clientToken,{publicOrigin:'https://providence.example'});
 await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const origin=`http://127.0.0.1:${(server.address() as any).port}`;
 const headers={Authorization:`Bearer ${config.clientToken}`,'Content-Type':'application/json'};
 try{
  const accepted=await fetch(origin+'/v1/transcriptions',{method:'POST',headers,body:JSON.stringify({requestId:'events-stt',deviceId:'mac',...recording})});
  assert.equal(accepted.status,202);const job=await accepted.json();
  const result=await(await fetch(origin+'/v1/transcriptions/'+job.id,{headers})).json();
  assert.equal(result.status,'completed');assert.equal(result.text,transcript);
  const events=await(await fetch(origin+'/v1/events',{headers})).json();
  const updates=events.events.filter((e:any)=>e.type==='transcription.updated');
  assert.equal(updates.length,1);
  assert.deepEqual(updates[0].job,{id:job.id,requestId:'events-stt',deviceId:'mac',status:'completed'});
  assert.equal(JSON.stringify(events).includes(transcript),false);
  assert.equal(JSON.stringify(events).includes(result.fingerprint),false);
 }finally{await new Promise<void>(done=>server.close(()=>done()));f.cleanup();}
});
