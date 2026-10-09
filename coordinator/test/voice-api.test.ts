import test from 'node:test';
import assert from 'node:assert/strict';
import { transcribeVoice } from '../web/src/voice-api.js';
import { transcriptionRefused } from '../web/src/browser-voice.js';

test('stopping during recording conversion prevents transcription submission',async()=>{
 const original=globalThis.fetch;const controller=new AbortController();let requests=0;
 globalThis.fetch=async()=>{requests++;throw new Error('must not submit');};
 const recording=new Blob(['recording'],{type:'audio/webm'});
 recording.arrayBuffer=async()=>{controller.abort();return new ArrayBuffer(8);};
 try{await assert.rejects(transcribeVoice('fixture','mac',recording,controller.signal),{name:'AbortError'});assert.equal(requests,0);}
 finally{globalThis.fetch=original;}
});
test('a stop arriving while the final transcript is decoded cannot return text for a task submission',async()=>{
 const original=globalThis.fetch;const controller=new AbortController();let requests=0;
 globalThis.fetch=async()=>{
  requests++;
  return {ok:true,json:async()=>{controller.abort();return {id:'job',status:'completed',text:'late transcript'};}} as Response;
 };
 try{await assert.rejects(transcribeVoice('fixture','mac',new Blob(['recording'],{type:'audio/webm'}),controller.signal),{name:'AbortError'});assert.equal(requests,1);}
 finally{globalThis.fetch=original;}
});

test('iOS voice upload preserves same-origin identity under a no-referrer document',async()=>{
 const original=globalThis.fetch;let calls=0;
 globalThis.fetch=async(url,init)=>{
  calls++; assert.equal(url,'/v1/transcriptions');
  assert.equal(init?.mode,'same-origin'); assert.equal(init?.referrerPolicy,'same-origin');
  assert.equal(init?.redirect,'error'); assert.equal(init?.credentials,'omit');
  assert.equal(new Headers(init?.headers).get('Authorization'),'Bearer fixture');
  assert.equal(new Headers(init?.headers).has('Origin'),false,'browser generates Origin; client must not forge it');
  return new Response(JSON.stringify({id:'job',status:'completed',text:'Read the current window title.'}),{headers:{'content-type':'application/json'}});
 };
 try{assert.equal(await transcribeVoice('fixture','mac',new Blob(['test'],{type:'audio/mp4'}),new AbortController().signal),'Read the current window title.');assert.equal(calls,1);}
 finally{globalThis.fetch=original;}
});

test('only a recognized initial admission refusal preserves the recording for manual retry', async () => {
 const original = globalThis.fetch;
 try {
  for (const [status, errorCode, retryable] of [
   [409, 'transcription_busy', true], [409, 'history_full', true], [503, 'provider_not_configured', true],
   [409, 'restart_interrupted', false], [429, 'provider_rate_limited', false],
   [503, 'provider_unavailable', false], [503, undefined, false],
  ] as const) {
   let calls = 0;
   globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({error: 'Unavailable', errorCode}), {status}); };
   await assert.rejects(transcribeVoice('fixture', 'mac', new Blob(['test'], {type:'audio/webm'}), new AbortController().signal), error => {
    assert.equal(transcriptionRefused(error), retryable, `${status}/${errorCode}`); return true;
   });
   assert.equal(calls, 1, 'no automatic retry');
  }
 } finally { globalThis.fetch = original; }
});

test('an accepted transcription followed by a refused status poll cannot re-upload audio', async () => {
 const original = globalThis.fetch;
 const methods: string[] = [];
 globalThis.fetch = async (_url, init) => {
  methods.push(init?.method ?? 'GET');
  return methods.length === 1
   ? new Response(JSON.stringify({id:'accepted-job', status:'pending'}), {status:202})
   : new Response(JSON.stringify({error:'Unavailable', errorCode:'provider_not_configured'}), {status:503});
 };
 try {
  await assert.rejects(transcribeVoice('fixture', 'mac', new Blob(['test'], {type:'audio/webm'}), new AbortController().signal), error => {
   assert.equal(transcriptionRefused(error), false); return true;
  });
  assert.deepEqual(methods, ['POST', 'GET']);
 } finally { globalThis.fetch = original; }
});
