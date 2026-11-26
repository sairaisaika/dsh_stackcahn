import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { createLocalVoice } from '../src/local-voice.mjs';
import { VoiceBridge } from '../src/bridge.mjs';
import { createAgentTransport } from '../src/agent-transport.mjs';
import { createPairing } from '../src/pairing.mjs';
import { encodePcm, decodePcm } from '../src/agent-protocol.mjs';

function deferred() { let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});promise.catch(()=>{});return {promise,resolve,reject}; }
async function until(check) { for(let i=0;i<500;i++){if(check())return;await delay(2);}assert.fail('condition did not become true'); }
const aborted = signal => new Promise((resolve,reject)=>{
  const rejectNow=()=>reject(Object.assign(new Error('cancelled'),{code:'cancelled'}));
  if(signal.aborted)rejectNow();else signal.addEventListener('abort',rejectNow,{once:true});
});
class Connection extends EventEmitter {
  phase='idle';playbackSupported=true;frames=[];calls=[];queue=[];reader=null;holdDrain=false;
  snapshot(){return {phase:this.phase};}
  async start(){this.calls.push('start');this.phase='active';}
  async stop(){this.calls.push('stop');this.phase='idle';this.drain?.reject(new Error('stopped'));this.reader?.reject(new Error('stopped'));return {deviceIdle:true};}
  async readInput({signal}){
    if(this.queue.length)return {pcm:this.queue.shift()};
    const pending=deferred();this.reader=pending;
    const abort=()=>pending.reject(new Error('aborted'));signal.addEventListener('abort',abort,{once:true});
    try{return await pending.promise;}finally{signal.removeEventListener('abort',abort);if(this.reader===pending)this.reader=null;}
  }
  push(n){const pcm=Buffer.alloc(960);pcm.writeInt16LE(n);if(this.reader){const pending=this.reader;this.reader=null;pending.resolve({pcm});}else this.queue.push(pcm);}
  async sendOutput(frame){this.frames.push(Buffer.from(frame));return {accepted:true};}
  async drainOutput(){this.calls.push('drain');if(this.holdDrain){this.drain=deferred();return this.drain.promise;}return {playbackIdle:true};}
  async interruptOutput(){this.calls.push('interrupt');return {playbackIdle:true};}
}
function fixture(t,options={}){
  const connection=options.connection??new Connection();const calls=[];const asks=[];
  const frontend={async start(){calls.push('warm');},async process(pcm){calls.push('input');return {segment:{pcm:pcm.subarray(0,2),sampleRate:16000,reason:'silence',continuation:false,...options.segment}};},async dispose(){calls.push('audio-close');},...options.frontend};
  const asr={async transcribe(pcm){return {text:({1:'你好',2:'第二句',3:'停止',4:'不要停止',5:'别说了。'})[pcm.readInt16LE()]??'hello'};},async dispose(){calls.push('asr-close');},...options.asr};
  const tts={async *synthesize(){calls.push('tts');yield Buffer.alloc(500,7);},async dispose(){calls.push('tts-close');},...options.tts};
  const voice=createLocalVoice({getConnection:()=>connection,language:options.language??'zh',maxQueuedSegments:options.maxQueuedSegments??2,speaker:options.speaker,
    captionOnly:options.captionOnly,keepSynthesisWarm:options.keepSynthesisWarm,onActiveFault:options.onActiveFault,
    factories:{audio:()=>frontend,recognition:()=>asr,synthesis:()=>{options.onSynthesis?.();return tts;}}});
  const dsh={async bind(id){calls.push(['bind',id]);return {async ask(text,{signal,onSpeechPreview}){asks.push(text);return options.ask?options.ask(text,signal,onSpeechPreview):'回答';}};}};
  const bridge=new VoiceBridge({voice,dsh,exitTarget:'device-idle',timeoutMs:1000});
  t.after(()=>voice.dispose().catch(()=>{}));
  return {connection,voice,bridge,calls,asks};
}

test('a capture gap drops an unfinished Stop transcription and a later turn works', async t => {
  const connection = new Connection();
  connection.inputGeneration = 0;
  connection.readInputBatch = async ({ signal }) => ({
    frames: [await connection.readInput({ signal })], generation: connection.inputGeneration,
  });
  const pendingStop = deferred();
  let recognized = 0, reset = 0;
  const { bridge, asks } = fixture(t, { connection, frontend: { async reset() { reset++; } },
    asr: { async transcribe(pcm) {
      recognized++;
      return pcm.readInt16LE() === 3 ? pendingStop.promise : { text: '恢复后的新话' };
    } },
  });
  await bridge.enter('existing');
  connection.push(3);
  await until(() => recognized === 1);
  connection.inputGeneration++;
  connection.push(1);
  await until(() => reset === 1);
  pendingStop.resolve({ text: '停止' });
  await until(() => asks.length === 1);
  assert.deepEqual(asks, ['恢复后的新话']);
  assert.equal(bridge.status().state, 'bridged');
  assert.equal((await bridge.stop()).state, 'idle');
});

test('a failed DSH turn speaks a short notice and the same lease keeps listening', async t => {
  let failing = true;
  const { bridge, connection, asks } = fixture(t, { ask() {
    if (!failing) return '回答';
    failing = false;
    throw Object.assign(new Error('interrupted on the desktop'), { code: 'dsh-turn-incomplete' });
  } });
  const drains = () => connection.calls.filter(call => call === 'drain').length;
  await bridge.enter('existing');
  connection.push(1);
  await until(() => drains() === 1); // The notice, not a reply.
  assert.equal(bridge.status().state, 'bridged');
  assert.equal(bridge.status().lastTurnError, 'dsh-turn-incomplete');
  connection.push(2);
  await until(() => asks.length === 2 && drains() === 2);
  assert.equal(bridge.status().lastTurnError, null);
  assert.ok(!connection.calls.includes('stop'));
  assert.equal((await bridge.stop()).state, 'idle');
});

test('saying 别说了 ends the reply in progress and keeps the conversation open', async t => {
  const pending = deferred();
  const { bridge, connection, asks } = fixture(t, { ask: text => text === '你好' ? pending.promise : '回答' });
  await bridge.enter('existing');
  connection.push(1);
  await until(() => asks.length === 1);
  connection.push(5);
  await until(() => connection.calls.includes('interrupt'));
  pending.resolve('迟到的回答');
  connection.push(2);
  await until(() => asks.length === 2 && connection.calls.includes('drain'));
  assert.equal(bridge.status().state, 'bridged');
  assert.equal(connection.calls.filter(call => call === 'drain').length, 1);
  assert.ok(!connection.calls.includes('stop'));
  assert.equal((await bridge.stop()).state, 'idle');
});

test('a prepared first sentence stays local, is played once after confirmation and can be discarded', async t => {
  for (const scenario of ['matching', 'replacement', 'stop']) {
    const settled = deferred();
    const synthesis = deferred();
    const synthesized = [];
    let outstanding = false;
    const f = fixture(t, {
      async ask(text, signal, preview) {
        preview('首句。');
        const reply = await Promise.race([settled.promise, aborted(signal)]);
        if (scenario === 'replacement') preview(null);
        return reply;
      },
      tts: { async *synthesize(text) {
        assert.equal(outstanding, false);
        outstanding = true;
        synthesized.push(text);
        try {
          if (text === '首句。') synthesis.resolve();
          yield Buffer.alloc(480, text === '首句。' ? 1 : 2);
        } finally { outstanding = false; }
      } },
    });
    await f.bridge.enter('selected');
    f.connection.push(1);
    await synthesis.promise;
    assert.deepEqual(f.connection.frames, [], scenario);
    if (scenario === 'stop') {
      const stopped = await f.bridge.receive({ id: 'stop', text: '停止', final: true });
      assert.equal(stopped.state, 'idle');
      assert.equal(outstanding, false);
      assert.deepEqual(f.connection.frames, []);
      assert.deepEqual(synthesized, ['首句。']);
      continue;
    }
    settled.resolve(scenario === 'replacement' ? '修订。' : '首句。第二句。');
    await until(() => f.connection.calls.includes('drain'));
    assert.deepEqual(f.connection.frames.map(frame => frame[0]), scenario === 'replacement' ? [2] : [1, 2]);
    assert.deepEqual(synthesized, ['首句。', scenario === 'replacement' ? '修订。' : '第二句。']);
    await f.bridge.stop();
  }
});

test('automatic language selection stays consistent across the full confirmed reply', async t => {
  const synthesized = [];
  const f = fixture(t, { language: 'auto',
    async ask(text, signal, preview) {
      preview('Hello!');
      return 'Hello! 下一句。';
    },
    tts: { async *synthesize(text, { language }) {
      synthesized.push([text, language]);
      yield Buffer.alloc(480, language === 'en' ? 1 : 2);
    } },
  });
  await f.bridge.enter('selected');
  f.connection.push(1);
  await until(() => f.connection.calls.includes('drain'));
  assert.deepEqual(synthesized, [['Hello!', 'en'], ['Hello! 下一句。', 'auto']]);
  assert.deepEqual(f.connection.frames.map(frame => frame[0]), [2]);
});

test('long replies keep one language and send all sections through a single playback fence', async t => {
  const synthesized = [];
  const captions = [];
  const prefix = '先说结论。';
  const tail = 'Hello world! '.repeat(625) + '中' + '🙂'.repeat(132);
  const reply = prefix + tail;
  const f = fixture(t, {
    language: 'auto',
    async ask(text, signal, preview) { preview(prefix); return reply; },
    tts: { async *synthesize(text, { language }) {
      assert.ok(text.length <= 120);
      assert.ok(text.isWellFormed(), 'a cut must not bisect a surrogate pair');
      assert.equal(language, 'zh');
      synthesized.push(text);
      yield Buffer.alloc(480);
    } },
  });
  f.connection.sendCaption = (speaker, text) => { captions.push([speaker, text]); return true; };
  await f.bridge.enter('selected');
  assert.deepEqual(await f.bridge.receive({ id: 'voice', text: '继续', final: true }), { delivered: true });
  assert.equal(synthesized[0], prefix);
  // Every character reaches the synthesizer; only whitespace at a section edge is trimmed.
  assert.equal(synthesized.slice(1).join('').replace(/\s/g, ''), tail.replace(/\s/g, ''));
  assert.deepEqual(captions, [['user', '继续'], ['assistant', reply]]);
  assert.deepEqual(f.connection.calls, ['start', 'drain']);
  assert.equal(f.connection.frames.length, synthesized.length);
  await f.bridge.stop();
});

test('local adapter is passive, activates after bridge ownership and keeps successive rounds bound',async t=>{
  const f=fixture(t);assert.deepEqual(f.calls,[]);assert.deepEqual(f.connection.calls,[]);
  await f.bridge.enter('selected-existing');assert.equal(f.bridge.status().state,'bridged');
  assert.equal(f.calls[1],'warm');assert.equal(f.connection.calls[0],'start');
  f.connection.push(1);await until(()=>f.connection.calls.filter(x=>x==='drain').length===1);
  f.connection.push(2);await until(()=>f.connection.calls.filter(x=>x==='drain').length===2);
  assert.deepEqual(f.asks,['你好','第二句']);assert.equal(f.calls.filter(Array.isArray).length,1);
  assert.equal(f.connection.frames.length,4);
  assert.equal(f.connection.frames[1].subarray(0,20).every(x=>x===7),true);
  assert.equal(f.connection.frames[1].subarray(20).every(x=>x===0),true);
  f.connection.push(4);await until(()=>f.asks.length===3);assert.equal(f.bridge.status().state,'bridged');
  f.connection.push(3);await until(()=>f.bridge.status().state==='idle');
  assert.equal(f.connection.calls.filter(x=>x==='stop').length,1);
  assert.equal(f.calls.filter(x=>x==='audio-close').length,1);
});

test('spoken Stop is recognized while DSH is pending and late replies never play',async t=>{
  const late=deferred();const f=fixture(t,{ask:()=>late.promise});await f.bridge.enter('chosen');
  f.connection.push(1);await until(()=>f.asks.length===1);
  f.connection.push(3);await until(()=>f.bridge.status().state==='idle');
  late.resolve('late reply');await delay(10);
  assert.deepEqual(f.asks,['你好']);assert.equal(f.connection.frames.length,0);
});

test('capture and recognition continue while synthesis waits; Stop joins actual cleanup',async t=>{
  const cleanup=deferred();let synthesizing=false;
  const f=fixture(t,{tts:{async *synthesize(text,{signal}){synthesizing=true;await aborted(signal);},async dispose(){await cleanup.promise;}}});
  await f.bridge.enter('chosen');f.connection.push(1);await until(()=>synthesizing);
  f.connection.push(3);await until(()=>f.connection.calls.includes('stop'));
  assert.equal(f.bridge.status().state,'releasing');cleanup.resolve();await until(()=>f.bridge.status().state==='idle');
});

test('the first lease adopts standby TTS once and listens while that worker is still warming', async t => {
  const warming = deferred();
  const dshReply = deferred();
  const finalSubmitted = deferred();
  const synthesized = [];
  let starts = 0;
  t.after(() => { warming.resolve(); dshReply.resolve(); });
  const f = fixture(t, {
    tts: {
      async warmup() { starts++; await warming.promise; },
      async *synthesize(text) { synthesized.push(text); yield Buffer.alloc(480); },
    },
    async ask(text, signal, preview) {
      preview('第一句。');
      await dshReply.promise;
      finalSubmitted.resolve();
      return '第一句。第二句。';
    },
  });
  f.voice.prewarmSynthesis();
  f.voice.prewarmSynthesis();
  await until(() => starts === 1);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.connection.calls, []);
  await f.bridge.enter('chosen');
  assert.equal(starts, 1);
  assert.equal(f.connection.phase, 'active');
  f.connection.push(1);
  await until(() => f.asks.length === 1);
  dshReply.resolve();
  await finalSubmitted.promise;
  await delay(0);
  assert.deepEqual(synthesized, []);
  assert.deepEqual(f.connection.frames, []);
  warming.resolve();
  await until(() => f.connection.calls.includes('drain'));
  assert.deepEqual(synthesized, ['第一句。', '第二句。']);
  assert.equal(f.connection.frames.length, 2);
});

test('stopping an unused prewarm joins cancellation and disposal before it can be replaced', async t => {
  const cleaned = deferred();
  t.after(() => cleaned.resolve());
  let starts = 0, cancelled = false;
  const f = fixture(t, { tts: {
    async warmup({signal}) {
      if (++starts > 1) return;
      try { await aborted(signal); }
      finally { cancelled = true; await cleaned.promise; }
    },
  } });
  f.voice.prewarmSynthesis();
  await until(() => starts === 1);
  const stopping = f.voice.cancelPrewarm();
  assert.equal(f.voice.cancelPrewarm(), stopping);
  await until(() => cancelled);
  await assert.rejects(f.bridge.enter('chosen'), {code:'voice-busy'});
  assert.deepEqual(f.connection.calls, []);
  cleaned.resolve();
  await stopping;
  await f.bridge.enter('chosen');
  assert.equal(starts, 2);
  await f.bridge.stop();
  assert.equal(f.calls.filter(name => name === 'tts-close').length, 2);
});

test('armed standby can reuse idle Kokoro across speech Stop without retaining a voice lease', async t => {
  let armed = true, workers = 0;
  const f = fixture(t, {keepSynthesisWarm: () => armed, onSynthesis: () => workers++});
  await f.bridge.enter('existing');
  f.connection.push(1);
  await until(() => f.bridge.status().pending === 0 && f.connection.calls.includes('drain'));
  f.connection.push(3);
  await until(() => f.bridge.status().state === 'idle');
  assert.equal(f.connection.phase,'idle');
  assert.equal(f.voice.status().phase,'idle');
  assert.deepEqual(f.calls.filter(call=>typeof call==='string'&&call.endsWith('-close')),['audio-close','asr-close']);
  const frames=f.connection.frames.length;
  await f.bridge.enter('existing');
  f.connection.push(2);
  await until(() => f.bridge.status().pending === 0 && f.connection.frames.length > frames);
  assert.deepEqual(f.asks,['你好','第二句']);
  assert.equal(workers,1);
  armed=false;
  await f.bridge.stop();
  assert.equal(f.calls.filter(call=>call==='tts-close').length,1);
});

test('revoking standby before the device acknowledges Stop closes the warmed worker', async t => {
  const receipt=deferred();
  let armed=true;
  const f=fixture(t,{keepSynthesisWarm:()=>armed});
  const finish=f.connection.stop.bind(f.connection);
  t.after(()=>receipt.resolve());
  f.connection.stop=async()=>{await receipt.promise;return finish();};
  await f.bridge.enter('existing');
  const stopping=f.bridge.stop('voice-stop');
  assert.ok(!f.calls.includes('tts-close'));
  armed=false;
  receipt.resolve();
  assert.equal((await stopping).state,'idle');
  assert.ok(f.calls.includes('tts-close'));
});

test('a lost device Stop receipt never retains the idle worker', async t => {
  const f=fixture(t,{keepSynthesisWarm:()=>true});
  const stop=f.connection.stop.bind(f.connection);
  f.connection.stop=async()=>{await stop();f.connection.phase='closed';return {deviceIdle:false};};
  await f.bridge.enter('existing');
  const result=await f.bridge.stop('voice-stop');
  assert.equal(result.state,'recovering');
  assert.ok(f.calls.includes('tts-close'));
  assert.equal(f.voice.canReconnect(),true);
});

test('a warmup failure before connect can be retried on the first lease', async t => {
  let attempts = 0, workers = 0;
  const f = fixture(t, {
    onSynthesis: () => { workers++; },
    tts: { async warmup() { if (++attempts === 1) throw new Error('first load failed'); } },
  });
  f.voice.prewarmSynthesis();
  await until(() => attempts === 1);
  await f.bridge.enter('chosen');
  f.connection.push(1);
  await until(() => f.connection.calls.includes('drain'));
  assert.equal(workers, 1);
  assert.equal(attempts, 2);
  await f.bridge.stop();
});

test('an obsolete preview cancelled during warmup never uses the warmed synthesizer', async t => {
  const warming = deferred();
  const discarded = deferred();
  const synthesized = [];
  t.after(() => warming.resolve());
  const f = fixture(t, {
    tts: {
      async warmup() { await warming.promise; },
      async *synthesize(text) { synthesized.push(text); yield Buffer.alloc(480); },
    },
    async ask(text, signal, preview) {
      preview('旧句子。');
      preview(null);
      discarded.resolve();
      return '新句子。';
    },
  });
  await f.bridge.enter('chosen');
  f.connection.push(1);
  await discarded.promise;
  warming.resolve();
  await until(() => f.connection.calls.includes('drain'));
  assert.deepEqual(synthesized, ['新句子。']);
});

test('spoken Stop during TTS warmup stops the device before the model process finishes cleanup', async t => {
  const cleanup = deferred();
  let warmupCancelled = false;
  t.after(() => cleanup.resolve());
  const f = fixture(t, {
    tts: {
      async warmup({signal}) {
        try { await aborted(signal); }
        finally { warmupCancelled = true; await cleanup.promise; }
      },
      async *synthesize() { assert.fail('unready synthesis cannot be used'); },
    },
  });
  await f.bridge.enter('chosen');
  f.connection.push(1);
  await until(() => f.asks.length === 1);
  f.connection.push(3);
  await until(() => warmupCancelled && f.connection.calls.includes('stop'));
  assert.equal(f.bridge.status().state, 'releasing');
  assert.deepEqual(f.asks, ['你好']);
  cleanup.resolve();
  await until(() => f.bridge.status().state === 'idle');
  assert.deepEqual(f.connection.frames, []);
});

test('TTS startup failure after listening begins releases the lease without waiting for a new prompt', async t => {
  const warming = deferred();
  t.after(() => warming.resolve());
  const f = fixture(t, {tts:{async warmup() { await warming.promise; }}});
  await f.bridge.enter('chosen');
  warming.reject(Object.assign(new Error('synthetic failure'), {code:'speech-startup-failed'}));
  await until(() => f.bridge.status().state === 'idle');
  assert.equal(f.bridge.status().lastError, 'speech-startup-failed');
  assert.deepEqual(f.connection.calls, ['start', 'stop']);
  assert.deepEqual(f.asks, []);
});

test('Stop supersedes a pending playback drain without aborting its transport signal',async t=>{
  const f=fixture(t,{keepSynthesisWarm:()=>true});f.connection.holdDrain=true;await f.bridge.enter('chosen');
  f.connection.push(1);await until(()=>f.connection.drain);
  f.connection.push(3);await until(()=>f.bridge.status().state==='idle');
  assert.equal(f.connection.phase,'idle');assert.deepEqual(f.connection.calls,['start','drain','stop']);
  assert.ok(f.calls.includes('tts-close'));
});

test('records the first active fault before release and ignores normal Stop',async t=>{
  for (const source of ['transport', 'audio-input', 'normal-stop']) {
    const reports=[];
    const f=fixture(t,{onActiveFault:sample=>reports.push(sample),
      frontend: source==='audio-input' ? {async process(){throw Object.assign(new Error('private detail'),{code:'audio-process-failed'});}} : {}});
    await f.bridge.enter('chosen');
    if (source==='normal-stop') {
      await f.bridge.stop();
      assert.deepEqual(reports,[]);
      continue;
    }
    if (source==='transport') {
      f.connection.phase='closed';
      f.connection.emit('disconnect',Object.assign(new Error('private detail'),{code:'protocol-invalid',protocolCode:'input-order'}));
      f.connection.emit('disconnect',Object.assign(new Error('cleanup detail'),{code:'disconnected'}));
    } else f.connection.push(1);
    await until(()=>['idle','recovering'].includes(f.bridge.status().state));
    assert.equal(reports.length,1);
    const [sample]=reports;
    assert.equal(sample.source,source);
    assert.equal(sample.firstInputReceived,source==='audio-input');
    assert.equal(sample.code,source==='transport'?'protocol-invalid':'audio-process-failed');
    assert.equal(sample.protocolCode,source==='transport'?'input-order':undefined);
    assert.ok(sample.activeMs>=0);
    assert.doesNotMatch(JSON.stringify(sample),/private detail/);
    assert.equal(f.bridge.status().state,source==='transport'?'recovering':'idle');
  }
});

test('activation failure disposes local owners and cannot hide uncertain device startup',async t=>{
  const f=fixture(t,{frontend:{async start(){throw Object.assign(new Error('model'),{code:'model-invalid'});}}});
  await assert.rejects(f.bridge.enter('chosen'),{code:'model-invalid',activationStage:'local-audio'});
  assert.equal(f.bridge.status().state,'idle');assert.equal(f.connection.calls.length,0);
  assert.ok(f.calls.includes('audio-close'));
  const connection=new Connection();connection.start=async()=>{connection.phase='closed';throw new Error('start acknowledgement lost');};
  const g=fixture(t,{connection});await assert.rejects(g.bridge.enter('chosen'),{activationStage:'device-audio'});
  assert.equal(g.bridge.status().state,'recovering');assert.equal(g.voice.status().phase,'fault');
  const lost=new Connection();
  lost.start=async()=>{
    const error=Object.assign(new Error('connection ended'),{code:'disconnected'});
    lost.phase='closed';lost.emit('disconnect',error);throw error;
  };
  const h=fixture(t,{connection:lost});
  await assert.rejects(h.bridge.enter('chosen'),{code:'disconnected',activationStage:'device-link'});
  assert.equal(h.voice.canReconnect(),true);
});

test('a recognizer backlog keeps the newest speech and never closes the channel',async t=>{
  const first=deferred();let calls=0;
  const text={1:'你好',2:'第二句',4:'不要停止'};
  const f=fixture(t,{maxQueuedSegments:1,asr:{async transcribe(pcm){
    if(++calls===1)await first.promise;
    return {text:text[pcm.readInt16LE()]};
  }}});
  await f.bridge.enter('chosen');f.connection.push(1);await until(()=>calls===1);
  f.connection.push(2);await until(()=>f.voice.status().queuedSegments===1);
  f.connection.push(4);await delay(20);
  assert.equal(f.voice.status().queuedSegments,1);
  first.resolve();
  await until(()=>f.asks.length===2);
  assert.deepEqual(f.asks,['你好','不要停止']);
  assert.equal(f.bridge.status().state,'bridged');assert.equal(f.voice.status().failure,null);
  assert.ok(!f.connection.calls.includes('stop'));
  await f.bridge.stop();
});

test('a late recognizer and a sliced command cannot stop or speak into another lease',async t=>{
  const late=deferred();let started=false;
  const f=fixture(t,{asr:{async transcribe(){started=true;return late.promise;}}});
  await f.bridge.enter('chosen');f.connection.push(1);await until(()=>started);
  const stopping=f.bridge.stop();await until(()=>f.connection.calls.includes('stop'));
  late.resolve({text:'late'});await stopping;assert.deepEqual(f.asks,[]);
  const g=fixture(t,{segment:{reason:'limit'}});await g.bridge.enter('chosen');g.connection.push(3);
  await until(()=>g.asks.length===1);assert.equal(g.bridge.status().state,'bridged');
  assert.deepEqual(g.asks,['停止']);await g.bridge.stop();
});

test('unsupported playback and duplicate ownership fail before capture; clean re-entry creates a fresh lease',async t=>{
  const f=fixture(t);f.connection.playbackSupported=false;await assert.rejects(f.bridge.enter('chosen'),{code:'voice-playback-unsupported'});
  assert.deepEqual(f.connection.calls,[]);f.connection.playbackSupported=true;await f.bridge.enter('chosen');
  await assert.rejects(f.voice.acquire({exitTarget:'device-idle',onTranscript(){},onDisconnect(){}}),{code:'voice-busy'});
  await f.bridge.stop();await f.bridge.enter('chosen');await f.bridge.stop();
  assert.equal(f.connection.calls.filter(x=>x==='start').length,2);
});

test('caption-only requires the device opt-in, consumes speech, shows text and stops without opening synthesis',async t=>{
  const shown=[];
  const f=fixture(t,{captionOnly:true,onSynthesis:()=>assert.fail('caption-only must not create TTS'),
    async ask(text,_signal,preview){assert.equal(preview,undefined);return text+'的回答';}});
  f.voice.prewarmSynthesis();
  await assert.rejects(f.bridge.enter('chosen'),{code:'voice_caption_required'});
  assert.deepEqual(f.connection.calls,[]);
  f.connection.captionRequested=true;f.connection.playbackSupported=false;
  f.connection.sendCaption=(speaker,text,options)=>{assert.equal(options.required,true);shown.push([speaker,text]);return true;};
  await f.bridge.enter('chosen');
  f.connection.push(1);await until(()=>shown.length===2);
  f.connection.push(4);await until(()=>shown.length===4);
  assert.deepEqual(shown,[['user','你好'],['assistant','你好的回答'],['user','不要停止'],['assistant','不要停止的回答']]);
  f.connection.push(3);await until(()=>f.bridge.status().state==='idle');
  assert.deepEqual(f.asks,['你好','不要停止']);assert.deepEqual(f.connection.calls,['start','stop']);
  assert.deepEqual(f.connection.frames,[]);
});

test('a refused required caption preserves the DSH turn and reports failure without speaking it',async t=>{
  const f=fixture(t,{captionOnly:true,onSynthesis:()=>assert.fail('caption-only must not create TTS')});
  f.connection.captionRequested=true;
  f.connection.sendCaption=speaker=>speaker==='user';
  await f.bridge.enter('chosen');f.connection.push(1);
  await until(()=>f.bridge.status().lastTurnError==='voice_caption_delivery_failed');
  assert.deepEqual(f.asks,['你好']);
  // The undelivered reply is reported. The Text session itself stays open.
  assert.equal(f.bridge.status().state,'bridged');
  assert.deepEqual(f.connection.frames,[]);
  await f.bridge.stop();
});

test('actual TLS transport plus voice bridge handles input during playback drain and confirms Stop',async t=>{
  const root=await mkdtemp(join(tmpdir(),'sion-voice-tls-'));t.after(()=>rm(root,{recursive:true,force:true}));
  createPairing(join(root,'pair'),'wss://192.168.1.2:9080/audio');
  const pairing=JSON.parse(await readFile(join(root,'pair/pairing.json'),'utf8'));
  const deviceId='123456abcdef',boot='c'.repeat(32);
  const transport=createAgentTransport({pairing,deviceId});t.after(()=>transport.close());
  const address=await transport.listen({host:'127.0.0.1',port:0});
  const connected=once(transport.events,'connection');
  const ws=new WebSocket(`wss://127.0.0.1:${address.port}/audio`,'sion-agent-v1',{ca:pairing.record.ca,servername:'sion-host',rejectUnauthorized:true,
    headers:{Authorization:`Bearer ${pairing.record.local_token}`,'X-Sion-Pair-Id':pairing.record.pair_id,'X-Sion-Device-Id':deviceId}});
  ws.on('error',()=>{});t.after(()=>ws.terminate());await once(ws,'open');
  const send=value=>ws.send(JSON.stringify(value));
  send({type:'hello',protocol:1,device_id:deviceId,pair_id:pairing.record.pair_id,boot_id:boot,epoch:'0',phase:'idle',playback_fence:1});
  const [connection]=await connected;let epoch=0n,sequence=0n,draining=false,stopReceived=false;
  ws.on('message',(data,binary)=>{
    if(binary){const frame=decodePcm(data,2);send({type:'output',boot_id:boot,epoch:String(epoch),sequence:String(frame.sequence)});return;}
    const m=JSON.parse(data);
    if(m.type==='start'||m.type==='stop'){
      epoch=BigInt(m.epoch)+1n;
      if(m.type==='stop')stopReceived=true;
      send({type:m.type==='start'?'started':'stopped',boot_id:boot,epoch:String(epoch),request_id:m.request_id,...(m.type==='stop'?{resources_stopped:true}:{})});
    }else if(m.type==='renew')send({type:'renewed',boot_id:boot,epoch:m.epoch});
    else if(m.type==='drain_output')draining=true; // Await real Stop, not a fake drain receipt.
  });
  const input=n=>{const pcm=Buffer.alloc(960);pcm.writeInt16LE(n);ws.send(encodePcm({kind:1,epoch,sequence:sequence++,pcm}));};
  const f=fixture(t,{connection});await f.bridge.enter('existing');input(1);await until(()=>draining);
  input(3);await until(()=>f.bridge.status().state==='idle');
  assert.ok(stopReceived);assert.equal(connection.snapshot().phase,'idle');assert.deepEqual(f.asks,['你好']);
});

test('actual models keep paced input alive while speaking and recognize Stop through simulated echo (opt-in)',{
  skip:!(process.env.STACKCHAN_LOCAL_AUDIO_RUNTIME&&process.env.STACKCHAN_LOCAL_VOICE_RUNTIME&&process.env.STACKCHAN_WHISPER_BINARY&&process.env.STACKCHAN_AUDIO_FIXTURE),timeout:120000,
},async t=>{
  const {resolve}=await import('node:path');
  const {KokoroBackend}=await import('../src/local-speech.mjs');
  const runtime=resolve(process.env.STACKCHAN_LOCAL_VOICE_RUNTIME),python=join(runtime,'venv/bin/python');
  const setup=new KokoroBackend({python,assets:join(runtime,'assets')});t.after(()=>setup.dispose());
  const parts=[];for await(const pcm of setup.synthesize('不要停止。',{language:'zh'}))parts.push(pcm);
  const initial=Buffer.concat(parts);await setup.dispose();
  const stopPcm=await readFile(join(resolve(process.env.STACKCHAN_AUDIO_FIXTURE),'near.pcm'));
  const connection=new Connection();let timer,frameIndex=0,firstOutput=null,stopAt=null,maxBuffered=0,outputFrames=0;
  const output=[];const reference=[];
  connection.start=async()=>{
    connection.phase='active';
    timer=setInterval(()=>{
      if(connection.phase!=='active')return;
      const queued=output.shift();const ref=queued?.frame??Buffer.alloc(480);
      if(queued){queued.resolve({accepted:true});outputFrames++;if(firstOutput===null){firstOutput=frameIndex;stopAt=frameIndex+100;}}
      reference.push(ref);if(reference.length>5)reference.shift();
      const echo=reference.length===5?reference[0]:Buffer.alloc(480);
      const nearSource=stopAt!==null&&frameIndex>=stopAt?stopPcm:initial;
      const nearIndex=(stopAt!==null&&frameIndex>=stopAt?frameIndex-stopAt:frameIndex)*240;
      const pcm=Buffer.alloc(960);
      for(let j=0;j<240;j++){
        const near=nearIndex+j<nearSource.length/2?nearSource.readInt16LE((nearIndex+j)*2):0;
        const value=Math.round(0.55*echo.readInt16LE(j*2)+0.75*near);
        assert.ok(Math.abs(value)<32767);
        pcm.writeInt16LE(value,j*4);pcm.writeInt16LE(ref.readInt16LE(j*2),j*4+2);
      }
      frameIndex++;
      if(connection.reader){const r=connection.reader;connection.reader=null;r.resolve({pcm});}
      else connection.queue.push(pcm);
      maxBuffered=Math.max(maxBuffered,connection.queue.length);
      if(connection.queue.length>20){connection.phase='closed';connection.emit('disconnect',Object.assign(new Error('overrun'),{code:'input-overflow'}));}
    },10);
  };
  connection.sendOutput=frame=>{const p=deferred();output.push({...p,frame:Buffer.from(frame)});return p.promise;};
  connection.drainOutput=async()=>{while(output.length&&connection.phase==='active')await delay(5);if(connection.phase!=='active')throw new Error('stopped');return {playbackIdle:true};};
  connection.stop=async()=>{
    clearInterval(timer);connection.phase='idle';connection.queue.length=0;
    for(const item of output.splice(0))item.reject(new Error('stopped'));
    connection.reader?.reject(new Error('stopped'));return {deviceIdle:true};
  };
  t.after(()=>clearInterval(timer));
  const voice=createLocalVoice({getConnection:()=>connection,language:'zh',
    audio:{python,directory:resolve(process.env.STACKCHAN_LOCAL_AUDIO_RUNTIME)},
    recognition:{binary:resolve(process.env.STACKCHAN_WHISPER_BINARY),model:join(runtime,'assets/whisper/ggml-small-q5_1.bin'),temporaryDirectory:join(runtime,'voice-integration-utterances')},
    synthesis:{python,assets:join(runtime,'assets')},
  });t.after(()=>voice.dispose().catch(()=>{}));
  const asks=[];
  const bridge=new VoiceBridge({voice,exitTarget:'device-idle',timeoutMs:25000,dsh:{async bind(){return {async ask(text){asks.push(text);return '现在正在播放一段中文语音。我们继续介绍今天的天气和日常生活。';}};}}});
  await bridge.enter('isolated-test-session');
  const begin=Date.now();
  while(['bridged','releasing'].includes(bridge.status().state)&&Date.now()-begin<90000)await delay(25);
  assert.equal(bridge.status().state,'idle',JSON.stringify({bridge:bridge.status(),voice:voice.status(),asks,maxBuffered}));
  assert.equal(bridge.status().lastError,null,'normal Stop must not be a hidden audio failure');
  assert.equal(voice.status().failure,null);
  assert.equal(asks.length,1);assert.match(asks[0],/不要停止/);
  assert.ok(outputFrames>100,'actual TTS must be playing before the near-end Stop');
  assert.ok(stopAt!==null);assert.ok(maxBuffered<=20);
  t.diagnostic(JSON.stringify({synthetic:true,pacedFrames:frameIndex,maxBuffered,outputFrames,elapsedMs:Date.now()-begin,asks}));
});

test('a missing resource receipt stays recovering even when local workers exited',async t=>{
  const connection=new Connection();connection.stop=async()=>{connection.phase='idle';return {};};
  const f=fixture(t,{connection});await f.bridge.enter('chosen');await f.bridge.stop();
  assert.equal(f.bridge.status().state,'recovering');assert.equal(f.bridge.status().lastError,'voice-idle-unconfirmed');
  assert.equal(f.voice.status().phase,'fault');assert.ok(f.calls.includes('audio-close'));
  assert.equal(f.voice.canReconnect(),false);
  assert.equal(f.voice.retireDisconnected(),false);
});

test('a closed carrier can be retired only after successful local teardown', async t => {
  for (const failsCleanup of [false, true]) {
    const cleanup = deferred();
    const f = fixture(t, { frontend: { dispose() { return cleanup.promise; } } });
    await f.bridge.enter('chosen');
    f.connection.phase = 'closed';
    f.connection.emit('disconnect', Object.assign(new Error('network lost'), { code: 'disconnected' }));
    assert.equal(f.voice.canReconnect(), false);
    assert.equal(f.voice.retireDisconnected(), false);
    if (failsCleanup) cleanup.reject(new Error('worker did not exit'));
    else cleanup.resolve();
    const stopped = await f.bridge.stop();
    assert.equal(stopped.state, 'recovering');
    assert.equal(stopped.lastError, 'voice-idle-unconfirmed');
    assert.equal(f.voice.canReconnect(), !failsCleanup);
    assert.equal(f.voice.retireDisconnected(), !failsCleanup);
    assert.equal(f.voice.canReconnect(), false);
    assert.deepEqual(f.connection.calls, ['start']);
  }
});

test('Stop during input warmup owns and joins cleanup without ever enabling capture',async t=>{
  let warming=false;const f=fixture(t,{frontend:{async start({signal}){warming=true;await aborted(signal);}}});
  const entry=f.bridge.enter('chosen');const rejected=assert.rejects(entry);await until(()=>warming);
  await f.bridge.stop();await rejected;assert.equal(f.bridge.status().state,'idle');
  assert.deepEqual(f.connection.calls,[]);assert.equal(f.calls.filter(x=>x==='audio-close').length,1);
});
test('the lease reports when speech was last heard', async t => {
  const connection = new Connection();
  let probability = 0.1;
  const f = fixture(t, { connection, frontend: { async process() { return { probability, segment: null }; } } });
  await f.bridge.enter('selected');
  const lease = f.bridge.lease;
  assert.equal(lease.standbyMode, 0);
  connection.push(9);
  await delay(20);
  assert.equal(lease.lastSpeechAtMs(), 0); // Room noise below the speech threshold is not activity.
  probability = 0.9;
  const before = performance.now();
  connection.push(9);
  await until(() => lease.lastSpeechAtMs() >= before);
  await f.bridge.stop();
});
test('device attention and head gestures reach the bridge only through a live linked lease', async t => {
  const connection = new Connection();
  connection.standbyMode = 2;
  const indicators = [];
  connection.setVoiceIndicator = state => indicators.push(state);
  const f = fixture(t, { connection, frontend: { async process() { return { probability: 0, segment: null }; } } });
  await f.bridge.enter('selected');
  assert.equal(f.bridge.lease.standbyMode, 2);
  assert.equal(f.bridge.status().attending, false);
  assert.ok(indicators.length > 0 && indicators.every(state => state === 'standby')); // Never shown as listening first.
  connection.onAttention();
  await until(() => f.bridge.status().attending === true);
  assert.equal(indicators.at(-1), 'listening');
  connection.onHeadTouchGesture({ kind: 'tap', durationMs: 120 }); // Nothing is being said: no effect.
  assert.equal(f.bridge.status().attending, true);
  await f.bridge.stop();
  connection.onAttention(); // After release the old lease forwards nothing.
  assert.equal(f.bridge.status().state, 'idle');
});
test('an enrolment sample is never transcribed, and a judged utterance carries the verdict', async t => {
  const verdicts = [{ enrolling: true }, { owner: false }, { owner: true }];
  const heard = []; let transcribed = 0;
  const f = fixture(t, { speaker: pcm => { heard.push(pcm.length); return verdicts.shift(); },
    asr: { async transcribe() { transcribed++; return { text: '你好' }; } } });
  const events = [];
  const receive = f.bridge.receive.bind(f.bridge);
  f.bridge.receive = (event, gen) => { events.push(event.owner); return receive(event, gen); };
  await f.bridge.enter('selected');
  f.connection.push(1); await until(() => heard.length === 1);
  await delay(20);
  assert.equal(transcribed, 0); // Taken as a voice sample, not as something said to DSH.
  f.connection.push(1); await until(() => events.length === 1);
  f.connection.push(1); await until(() => events.length === 2);
  assert.deepEqual(events, [false, true]);
  assert.equal(transcribed, 2);
  await f.bridge.stop();
});

test('recognition outside Chinese and English is retried once as Chinese', async t => {
  const calls = [];
  const { bridge, connection, asks } = fixture(t, { language: 'auto', asr: { async transcribe(pcm, options) {
    calls.push(options.language);
    return options.language === 'zh' ? { text: '小D在吗', language: 'zh' } : { text: 'Пляша', language: 'ru' };
  } } });
  await bridge.enter('existing');
  connection.push(1);
  await until(() => asks.length === 1);
  assert.deepEqual(calls, ['auto', 'zh']);
  assert.deepEqual(asks, ['小D在吗']);
  await bridge.stop();
});

test('Chinese or English recognition is used without a second pass', async t => {
  const calls = [];
  const { bridge, connection, asks } = fixture(t, { language: 'auto', asr: { async transcribe(pcm, options) {
    calls.push(options.language);
    return { text: 'hello there', language: 'en' };
  } } });
  await bridge.enter('existing');
  connection.push(1);
  await until(() => asks.length === 1);
  assert.deepEqual(calls, ['auto']);
  assert.deepEqual(asks, ['hello there']);
  await bridge.stop();
});
