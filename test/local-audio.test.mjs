import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { LocalAudioFrontend } from '../src/local-audio.mjs';
import { createHash } from 'node:crypto';
import { WhisperBackend, KokoroBackend } from '../src/local-speech.mjs';
import { isStop } from '../src/bridge.mjs';

const exec = promisify(execFile);
async function fixture(t, mode='ok', options={}) {
  const directory=await mkdtemp(join(tmpdir(),'sion-audio-test-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const worker=join(directory,'worker.cjs');
  await writeFile(worker,`
const fs=require('node:fs');const path=require('node:path');
const dir=process.argv[process.argv.indexOf('--directory')+1];
fs.writeFileSync(path.join(dir,'pid'),String(process.pid));
const mode=${JSON.stringify(mode)};const send=o=>process.stdout.write(JSON.stringify(o)+'\\n');
if(mode==='startup-hang'){process.on('SIGTERM',()=>{});setInterval(()=>{},1000);}
else send({type:'ready',protocol:mode==='version'?2:1,input_rate:24000,output_rate:16000,frame_samples:240,channels:2,block_samples:512,resampler_latency_samples:80});
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line);if(mode==='hang'){process.on('SIGTERM',()=>{});setInterval(()=>{},1000);return;}
 if(mode==='death')process.exit(7);
 if(mode==='oversize'){process.stdout.write('x'.repeat(900001));return;}
 if(r.reset){send({type:'reset'});return;}
 if(Array.isArray(r.data)){
   send({type:'processed_batch',frames:r.data.map((_,i)=>({type:'processed',sequence:r.sequence+i,probability:0.01,segment:null}))});
   return;
 }
 const m={type:'processed',sequence:mode==='sequence'?r.sequence+1:r.sequence,probability:mode==='probability'?2:0.01,segment:null};
 if(mode==='forged')m.segment={sample_start:0,sample_end:512,sample_rate:16000,reason:'silence',continuation:false,data:Buffer.alloc(1024).toString('base64')};
 if(mode==='segment'&&r.sequence===19)m.segment={sample_start:0,sample_end:3072,sample_rate:16000,reason:'silence',continuation:false,data:Buffer.alloc(6144).toString('base64')};
 send(m);
});
`);
  const frontend=new LocalAudioFrontend({python:process.execPath,directory,worker,...options});
  t.after(()=>frontend.dispose());
  const pid=async()=>Number(await readFile(join(directory,'pid'),'utf8'));
  return {frontend,pid};
}
const gone=pid=>assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});

test('frontend warms explicitly, serializes frames and validates completed segment clock',async t=>{
  const {frontend:f,pid}=await fixture(t,'segment');
  await assert.rejects(f.process(Buffer.alloc(960)),{code:'audio-not-ready'});
  assert.deepEqual(await f.start(),{sampleRate:16000,resamplerLatencySamples:80});
  await assert.rejects(f.start(),{code:'audio-not-new'});
  await assert.rejects(f.process(Buffer.alloc(958)),{code:'audio-frame-invalid'});
  const first=f.process(Buffer.alloc(960));
  await assert.rejects(f.process(Buffer.alloc(960)),{code:'audio-busy'});await first;
  for(let i=1;i<19;i++)assert.equal((await f.process(Buffer.alloc(960))).segment,null);
  const result=await f.process(Buffer.alloc(960));
  assert.equal(result.segment.sampleRate,16000);assert.equal(result.segment.pcm.length,6144);
  await f.dispose();gone(await pid());
});

test('frontend processes a bounded batch and resets its sample clock after a gap',async t=>{
  const {frontend:f} = await fixture(t,'segment');
  const pcm = Buffer.alloc(960);
  await f.start();
  await assert.rejects(f.processBatch(Array(5).fill(pcm)), {code:'audio-frame-invalid'});
  assert.equal((await f.processBatch([pcm,pcm,pcm,pcm])).length, 4);
  await f.reset();
  for(let i=0;i<19;i++) assert.equal((await f.process(pcm)).segment,null);
  assert.equal((await f.process(pcm)).segment.sampleEnd,3072);
  await f.reset();
  for(let i=0;i<19;i++) assert.equal((await f.process(pcm)).segment,null);
  assert.equal((await f.process(pcm)).segment.sampleEnd,3072);
});

test('frontend rejects malformed worker messages and waits for actual process exit',async t=>{
  for(const mode of ['version','sequence','probability','forged','oversize','death']){
    const {frontend:f,pid}=await fixture(t,mode);
    if(mode==='version')await assert.rejects(f.start(),{code:'audio-protocol-invalid'});
    else {await f.start();await assert.rejects(f.process(Buffer.alloc(960)),{code:mode==='death'?'audio-process-failed':'audio-protocol-invalid'});}
    gone(await pid());
  }
});

test('frontend frame abort and disposal cannot wait behind hung inference',async t=>{
  for(const kind of ['abort','dispose','timeout']){
    const {frontend:f,pid}=await fixture(t,'hang',{frameTimeoutMs:kind==='timeout'?100:5000});
    await f.start();const ac=new AbortController();
    const result=f.process(Buffer.alloc(960),{signal:ac.signal});
    const check=assert.rejects(result,{code:kind==='abort'?'audio-aborted':kind==='dispose'?'audio-disposed':'audio-timeout'});
    await delay(40);
    if(kind==='abort')ac.abort();
    if(kind==='dispose')await f.dispose();
    await check;gone(await pid());
  }
});

test('frontend startup has bounded cancellation and native unit checks run without models',async t=>{
  const {frontend:f,pid}=await fixture(t,'startup-hang',{startupTimeoutMs:150});
  await assert.rejects(f.start(),{code:'audio-timeout'});gone(await pid());
  const result=await exec(process.env.STACKCHAN_TEST_PYTHON||'python3',['scripts/test_local_audio.py'],{cwd:resolve('.'),env:{PATH:process.env.PATH,HOME:process.env.HOME}});
  assert.match(result.stderr,/OK \(skipped=4\)/);
});

test('real LocalVQE, resampler and Silero worker uses the bounded Node protocol (opt-in)',{
  skip:!process.env.STACKCHAN_LOCAL_AUDIO_RUNTIME,timeout:60000,
},async t=>{
  const f=new LocalAudioFrontend({python:resolve(process.env.STACKCHAN_AUDIO_PYTHON||'.local/voice-dev/venv/bin/python'),directory:resolve(process.env.STACKCHAN_LOCAL_AUDIO_RUNTIME),
    aecV12:process.env.STACKCHAN_AUDIO_AEC_V12==='1'});
  t.after(()=>f.dispose());await f.start();
  for(let i=0;i<150;i++){
    const result=await f.process(Buffer.alloc(960));
    assert.equal(result.segment,null);
  }
  await f.reset();
  for(let i=0;i<30;i++){
    const results=await f.processBatch(Array(4).fill(Buffer.alloc(960)));
    assert.equal(results.length,4);
    assert.ok(results.every(result=>!result.segment));
  }
  await f.dispose();
});

test('synthetic Chinese Stop survives simultaneous playback echo through real AEC/VAD/ASR (opt-in)',{
  skip:!(process.env.STACKCHAN_LOCAL_AUDIO_RUNTIME && process.env.STACKCHAN_LOCAL_VOICE_RUNTIME && process.env.STACKCHAN_WHISPER_BINARY),timeout:180000,
},async t=>{
  const runtime=resolve(process.env.STACKCHAN_LOCAL_VOICE_RUNTIME);
  const python=join(runtime,'venv/bin/python');
  const tts=new KokoroBackend({python,assets:join(runtime,'assets')});
  const asr=new WhisperBackend({binary:resolve(process.env.STACKCHAN_WHISPER_BINARY),model:join(runtime,'assets/whisper/ggml-small-q5_1.bin'),temporaryDirectory:join(runtime,'audio-test-utterances')});
  t.after(()=>Promise.all([tts.dispose(),asr.dispose()]));
  const synth=async text=>{const parts=[];for await(const pcm of tts.synthesize(text,{language:'zh'}))parts.push(pcm);return Buffer.concat(parts);};
  // Research comparisons may select the same private synthetic fixture so that
  // TTS variation is not confused with a DSP configuration effect.
  const fixtureDirectory=process.env.STACKCHAN_AUDIO_FIXTURE;
  const far=fixtureDirectory?await readFile(join(resolve(fixtureDirectory),'far.pcm')):await synth('现在正在播放一段中文语音。我们继续介绍今天的天气和日常生活。');
  const near=fixtureDirectory?await readFile(join(resolve(fixtureDirectory),'near.pcm')):await synth('停止。');
  const negation=await synth('不要停止。');
  for(const pcm of [far,near])assert.ok(pcm.length>0&&pcm.length%2===0&&pcm.length<=48000*20);
  t.diagnostic(JSON.stringify({fixtureSha256:{far:createHash('sha256').update(far).digest('hex'),near:createHash('sha256').update(near).digest('hex')}}));
  const observations=[];
  const cases=[
    {name:'echo-only',nearStartSeconds:null},
    {name:'cold-double-talk',nearStartSeconds:0},
    {name:'established-double-talk',nearStartSeconds:5},
    {name:'quiet-near-end',nearStartSeconds:0,farGain:0},
    {name:'negated-stop',nearStartSeconds:5,nearPcm:negation},
    {name:'longer-echo-path',nearStartSeconds:5,delaySamples:1920},
  ];
  for(const scenario of cases){
    const {nearStartSeconds}=scenario;
    const withNear=nearStartSeconds!==null;
    const f=new LocalAudioFrontend({python,directory:resolve(process.env.STACKCHAN_LOCAL_AUDIO_RUNTIME),worker:process.env.STACKCHAN_AUDIO_WORKER?resolve(process.env.STACKCHAN_AUDIO_WORKER):undefined,
      aecV12:process.env.STACKCHAN_AUDIO_AEC_V12==='1'});
    t.after(()=>f.dispose());await f.start();
    const nearPcm=scenario.nearPcm??near;
    const seconds=Math.ceil((5*24000+nearPcm.length/2+24000)/24000);
    const count=seconds*24000;
    const farAt=i=>i<0?0:Math.round((scenario.farGain??1)*far.readInt16LE((i%(far.length/2))*2));
    const nearStart=(nearStartSeconds??0)*24000;
    const nearAt=i=>withNear&&i>=nearStart&&i<nearStart+nearPcm.length/2?nearPcm.readInt16LE((i-nearStart)*2):0;
    const segments=[];const begin=performance.now();
    for(let offset=0;offset<count;offset+=240){
      const frame=Buffer.alloc(960);
      for(let j=0;j<240;j++){
        const i=offset+j;
        const echoDelay=scenario.delaySamples??480;
        const sample=Math.round(0.55*farAt(i-echoDelay)+0.2*farAt(i-echoDelay-600)+0.75*nearAt(i));
        assert.ok(Math.abs(sample)<32767,'synthetic mix must not clip');
        frame.writeInt16LE(sample,4*j);frame.writeInt16LE(farAt(i),4*j+2);
      }
      const result=await f.process(frame);
      if(result.segment)segments.push(result.segment);
    }
    const processingMs=Math.round(performance.now()-begin);await f.dispose();
    const transcripts=[];
    for(const segment of segments)transcripts.push((await asr.transcribe(segment.pcm,{language:'zh',sampleRate:segment.sampleRate})).text);
    t.diagnostic(JSON.stringify({synthetic:true,case:scenario.name,withNear,nearStartSeconds,audioSeconds:seconds,processingMs,segments:segments.length,transcripts}));
    observations.push(transcripts);
  }
  assert.ok(observations[1].some(isStop),'near-end Stop must remain an entire recognized command');
  assert.ok(observations[2].some(isStop),'near-end Stop during established playback must remain an entire recognized command');
  assert.equal(observations[0].length,0,'this echo-only synthetic case must not create user turns');
  assert.ok(observations[3].some(isStop),'quiet near-end Stop must remain recognizable');
  assert.ok(observations[4].some(text=>/不要停止/.test(text)),'negated stop must retain its negation');
  assert.equal(observations[4].some(isStop),false,'negated stop must not release the voice channel');
  assert.ok(observations[5].some(isStop),'longer echo path must preserve the interruption');
});
