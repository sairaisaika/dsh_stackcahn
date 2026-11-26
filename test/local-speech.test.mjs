import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WhisperBackend, KokoroBackend, pcmToWav } from '../src/local-speech.mjs';

const exec = promisify(execFile);
const gone = (pid) => assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
async function until(fn) {
  for (let i = 0; i < 150; i++) { const result = await fn(); if (result) return result; await delay(20); }
  throw new Error('fixture-timeout');
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'sion-speech-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const binary = join(directory, 'whisper');
  await writeFile(binary, `#!${process.execPath}
const fs=require('node:fs');const path=require('node:path');
const arg=(key)=>process.argv[process.argv.indexOf(key)+1];
const model=arg('-m');const output=arg('-of');
const mode=fs.existsSync(model)?fs.readFileSync(model,'utf8'):path.basename(model);
if(arg('-f')!=='-'||fs.readdirSync(path.dirname(output)).length)process.exit(5);
if(mode==='stall-input'){
  process.on('SIGTERM',()=>{});setInterval(()=>{},1000);
  fs.writeFileSync(path.join(path.dirname(model),'pid'),String(process.pid));
  return;
}
const input=fs.readFileSync(0);
fs.writeFileSync(path.join(path.dirname(model),'pid'),String(process.pid));
if(input.toString('ascii',0,4)!=='RIFF'||input.readUInt32LE(24)!==(mode==='16k'?16000:24000))process.exit(5);
if(mode==='hang'){process.on('SIGTERM',()=>{});setInterval(()=>{},1000);}
else if(mode==='error'){console.error('PRIVATE INPUT MUST NOT ESCAPE');process.exit(7);}
else if(mode==='bad'){fs.writeFileSync(output+'.json','{}');}
else if(mode==='huge'){fs.writeFileSync(output+'.json','x'.repeat(131073));}
else fs.writeFileSync(output+'.json',JSON.stringify({result:{language:'zh'},transcription:[{text:' 你好'},{text:'。 '}]}));
`, { mode: 0o700 });
  const worker = join(directory, 'worker.cjs');
  await writeFile(worker, `
const fs=require('node:fs');const path=require('node:path');const readline=require('node:readline');const {once}=require('node:events');
const dir=process.argv[process.argv.indexOf('--assets')+1];
fs.writeFileSync(path.join(dir,'scratch'),process.argv[process.argv.indexOf('--runtime-directory')+1]);
fs.appendFileSync(path.join(dir,'workers'),process.pid+'\\n');
const send=(o)=>process.stdout.write(JSON.stringify(o)+'\\n');
send({type:'ready',protocol:1,rate:24000,channels:1});
readline.createInterface({input:process.stdin}).on('line',async(line)=>{
 const r=JSON.parse(line);const id=r.request_id;
 if(r.text==='hang'){process.on('SIGTERM',()=>{});setInterval(()=>{},1000);return;}
 if(r.text==='death'){process.exit(9);}
 if(r.text==='error'){send({type:'error',request_id:id,code:'PRIVATE INPUT MUST NOT ESCAPE'});return;}
 if(r.text==='line'){process.stdout.write('x'.repeat(70000));return;}
 const count=r.text==='many'?400:2;const pcm=Buffer.alloc(24000,1).toString('base64');
 for(let i=0;i<count;i++){
  const m={type:'pcm',request_id:r.text==='id'?'wrong':id,sequence:r.text==='seq'?7:i,data:r.text==='base64'?'!':pcm};
  if(!send(m))await once(process.stdout,'drain');
  if(r.text==='many')fs.writeFileSync(path.join(dir,'produced'),String(i+1));
 }
 send({type:'done',request_id:id,frames:r.text==='frames'?5:count*12000});
});
`);
  const asr = (mode = 'ok', options = {}) => new WhisperBackend({ binary, model: join(directory, mode),
    temporaryDirectory: join(directory, 'audio'), ...options });
  const tts = (options = {}) => new KokoroBackend({ python: process.execPath, worker, assets: directory, ...options });
  const workers = async () => (await readFile(join(directory, 'workers'), 'utf8')).trim().split('\n').map(Number);
  return { directory, binary, worker, asr, tts, workers };
}
const collect = async (iterator) => { const buffers=[]; for await (const b of iterator) buffers.push(b); return Buffer.concat(buffers); };

async function residentFixture(t, mode) {
  const directory = await mkdtemp(join(tmpdir(), 'sion-resident-whisper-'));
  const binary = join(directory, 'worker');
  const model = join(directory, mode);
  await writeFile(binary, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const model = process.argv[2];
const mode = path.basename(model);
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
if (mode === 'wait-ready' || mode === 'block-input') {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
}
fs.writeFileSync(path.join(path.dirname(model), 'pid'), String(process.pid));
if (mode === 'wait-ready') return;
send({type:'ready', protocol:1});
if (mode === 'block-input') return;
let buffer = Buffer.alloc(0);
process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 5 && buffer.length >= 5 + buffer.readUInt32LE(0)) {
    const length = buffer.readUInt32LE(0);
    const language = ['auto', 'zh', 'en'][buffer[4]];
    const wav = buffer.subarray(5, 5 + length);
    if (!language || wav.toString('ascii', 0, 4) !== 'RIFF') process.exit(7);
    const rate = wav.readUInt32LE(24);
    const textHex = mode === 'bad' ? 'gg' : Buffer.from(process.pid + ':' + rate).toString('hex');
    send({type:'result', language, textHex});
    buffer = buffer.subarray(5 + length);
  }
});
`, {mode: 0o700});
  const worker = new WhisperBackend({binary, model, protocol: 1, timeoutMs: 5000});
  t.after(async () => { await worker.dispose(); await rm(directory, {recursive: true, force: true}); });
  return {worker, directory, pid: async () => until(async () => {
    try { return Number(await readFile(join(directory, 'pid'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  })};
}

test('resident ASR warms once, accepts two rates and languages on the same pipe, and reaps idle worker', async t => {
  const {worker, directory, pid} = await residentFixture(t, 'normal');
  await worker.warmup();
  const processId = await pid();
  assert.deepEqual(await worker.transcribe(Buffer.alloc(320), {sampleRate: 16000, language: 'zh'}),
    {text: `${processId}:16000`, language: 'zh'});
  assert.deepEqual(await worker.transcribe(Buffer.alloc(480), {sampleRate: 24000, language: 'en'}),
    {text: `${processId}:24000`, language: 'en'});
  assert.deepEqual((await readdir(directory)).sort(), ['pid', 'worker']);
  await worker.dispose(); gone(processId);
});

test('resident ASR aborts before ready and while sending a full WAV pipe, waiting for exit', async t => {
  const starting = await residentFixture(t, 'wait-ready');
  const controller = new AbortController();
  const warm = assert.rejects(starting.worker.warmup({signal: controller.signal}), {code: 'speech-aborted'});
  const startingPid = await starting.pid();
  controller.abort();
  await warm; gone(startingPid);

  const blocked = await residentFixture(t, 'block-input');
  await blocked.worker.warmup();
  const blockedPid = await blocked.pid();
  const result = assert.rejects(blocked.worker.transcribe(Buffer.alloc(24000 * 2 * 30)), {code: 'speech-aborted'});
  await assert.rejects(blocked.worker.transcribe(Buffer.alloc(480)), {code: 'speech-busy'});
  await blocked.worker.dispose();
  await result; gone(blockedPid);
  await assert.rejects(blocked.worker.warmup(), {code: 'speech-disposed'});
});

test('resident ASR discards the process after a malformed response', async t => {
  const {worker, pid} = await residentFixture(t, 'bad');
  await worker.warmup();
  const processId = await pid();
  await assert.rejects(worker.transcribe(Buffer.alloc(480), {language: 'en'}), {code: 'speech-result-invalid'});
  gone(processId);
});

test('TTS owns a private short working directory and removes it after exit or forced cancellation',async t=>{
  const f=await fixture(t);const tts=f.tts();t.after(()=>tts.dispose());
  await collect(tts.synthesize('hello'));
  const scratch=await readFile(join(f.directory,'scratch'),'utf8');
  const {lstat}=await import('node:fs/promises');assert.equal((await lstat(scratch)).mode&0o077,0);
  assert.ok(Buffer.byteLength(scratch)<130);assert.deepEqual(await readdir(scratch),[]);
  const abort=new AbortController(),work=collect(tts.synthesize('hang',{signal:abort.signal}));
  const cancelled=assert.rejects(work,{code:'speech-aborted'});await delay(20);abort.abort();await cancelled;
  await assert.rejects(lstat(scratch),{code:'ENOENT'});
  await assert.rejects(collect(tts.synthesize('death')),{code:'speech-process-ended'});
  const next=await readFile(join(f.directory,'scratch'),'utf8');assert.notEqual(next,scratch);
  await assert.rejects(lstat(next),{code:'ENOENT'});
});

test('ASR accepts explicit frontend 16 kHz and bounds duration using the selected rate', async(t) => {
  const f=await fixture(t);const asr=f.asr('16k');t.after(()=>asr.dispose());
  const pcm=Buffer.alloc(16000*2);
  const wav=pcmToWav(pcm,16000);
  assert.equal(wav.readUInt32LE(24),16000);assert.equal(wav.readUInt32LE(28),32000);
  assert.deepEqual(wav.subarray(44),pcm);
  assert.equal((await asr.transcribe(pcm,{sampleRate:16000})).text,'你好。');
  await assert.rejects(asr.transcribe(Buffer.alloc(16000*2*30+2),{sampleRate:16000}),{code:'speech-pcm-invalid'});
  for(const sampleRate of [8000,48000,'16000',NaN,null]) {
    await assert.rejects(asr.transcribe(pcm,{sampleRate}),{code:'speech-rate-invalid'});
  }
});

test('ASR pipes bounded WAV without writing input audio and removes the transcript after reading', async(t) => {
  const f=await fixture(t); const asr=f.asr(); t.after(()=>asr.dispose());
  assert.deepEqual(await asr.transcribe(Buffer.alloc(4800)),{text:'你好。',language:'zh'});
  assert.deepEqual(await readdir(join(f.directory,'audio')),[]);
  assert.equal(pcmToWav(Buffer.alloc(480)).readUInt32LE(40),480);
  for(const pcm of [Buffer.alloc(0),Buffer.alloc(3),Buffer.alloc(1440002),'text'])
    await assert.rejects(asr.transcribe(pcm),{code:'speech-pcm-invalid'});
});

test('ASR Stop cancels a full pipe even when the worker never reads the WAV', async(t) => {
  const f=await fixture(t);const asr=f.asr('stall-input');t.after(()=>asr.dispose());
  const controller=new AbortController();
  const rejection=assert.rejects(asr.transcribe(Buffer.alloc(24000*2*30),{signal:controller.signal}),{code:'speech-aborted'});
  const pid=await until(async()=>{try{return Number(await readFile(join(f.directory,'pid'),'utf8'));}catch{return null;}});
  controller.abort();
  await rejection;gone(pid);
  assert.deepEqual(await readdir(join(f.directory,'audio')),[]);
});

test('ASR abort waits for SIGKILL, rejects overlap, and permits a fresh operation', async(t) => {
  const f=await fixture(t);const asr=f.asr('hang');t.after(()=>asr.dispose());
  const abort=new AbortController(); const result=asr.transcribe(Buffer.alloc(480),{signal:abort.signal});
  const rejection=assert.rejects(result,{code:'speech-aborted'});
  const pid=await until(async()=>{try{return Number(await readFile(join(f.directory,'pid'),'utf8'));}catch{return null;}});
  await assert.rejects(asr.transcribe(Buffer.alloc(480)),{code:'speech-busy'});
  abort.abort(); await rejection;gone(pid);
  assert.deepEqual(await readdir(join(f.directory,'audio')),[]);
  await writeFile(join(f.directory,'hang'),'ok');
  assert.equal((await asr.transcribe(Buffer.alloc(480))).text,'你好。');
  const pre=new AbortController();pre.abort();await assert.rejects(asr.transcribe(Buffer.alloc(480),{signal:pre.signal}),{code:'speech-aborted'});
  await asr.dispose();await assert.rejects(asr.transcribe(Buffer.alloc(480)),{code:'speech-disposed'});
});

test('ASR timeout/dispose, corrupt output and process errors are bounded and redacted', async(t) => {
  const f=await fixture(t);
  for (const [mode,code] of [['hang','speech-timeout'],['error','speech-process-failed'],['bad','speech-result-invalid'],['huge','speech-result-invalid']]) {
    const asr=f.asr(mode,{timeoutMs:mode==='hang'?150:5000});
    await assert.rejects(asr.transcribe(Buffer.alloc(480)),{code}); await asr.dispose();
    assert.deepEqual(await readdir(join(f.directory,'audio')),[]);
  }
  const asr=f.asr('hang'); const running=asr.transcribe(Buffer.alloc(480));
  const rejection=assert.rejects(running,{code:'speech-aborted'});await asr.dispose();await rejection;
});

test('ASR rejects shared or symlink temporary directories before spawning', async(t) => {
  const f=await fixture(t); const directory=join(f.directory,'shared');
  await symlink(f.directory,directory); const asr=f.asr('ok',{temporaryDirectory:directory});
  await assert.rejects(asr.transcribe(Buffer.alloc(480)),{code:'speech-temp-not-private'});
  await asr.dispose();await rm(directory);await chmod(f.directory,0o755);
  const shared=f.asr('ok',{temporaryDirectory:f.directory});
  await assert.rejects(shared.transcribe(Buffer.alloc(480)),{code:'speech-temp-not-private'});await shared.dispose();
});

test('TTS reuses its loaded worker for successive jobs; break kills before returning',async(t)=>{
  const f=await fixture(t);const tts=f.tts();t.after(()=>tts.dispose());
  await tts.warmup();
  const [pid]=await f.workers();
  await tts.warmup();
  for(let i=0;i<2;i++)assert.equal((await collect(tts.synthesize('hello'))).length,48000);
  assert.deepEqual(await f.workers(),[pid]);
  for await(const chunk of tts.synthesize('hello')){assert.equal(chunk.length,24000);break;}
  gone(pid);
  await collect(tts.synthesize('again'));assert.equal((await f.workers()).length,2);
  await tts.dispose();for(const pid of await f.workers())gone(pid);
});

test('TTS warmup releases a worker cancelled before ready and can retry',async(t)=>{
  const f=await fixture(t);const tts=f.tts();t.after(()=>tts.dispose());
  const original=await readFile(f.worker,'utf8');
  await writeFile(f.worker,original.replace("send({type:'ready',protocol:1,rate:24000,channels:1});",''));
  const abort=new AbortController();
  const cancelled=assert.rejects(tts.warmup({signal:abort.signal}),{code:'speech-aborted'});
  const [pid]=await until(()=>f.workers().catch(()=>null));
  const scratch=await readFile(join(f.directory,'scratch'),'utf8');
  await assert.rejects(collect(tts.synthesize('overlap')),{code:'speech-busy'});
  abort.abort();
  await cancelled;
  gone(pid);
  await assert.rejects(readdir(scratch),{code:'ENOENT'});
  await writeFile(f.worker,original);
  await tts.warmup();
  assert.equal((await collect(tts.synthesize('hello'))).length,48000);
});

test('TTS respects consumer backpressure, busy ownership, abort while paused and disposal',async(t)=>{
  const f=await fixture(t);const tts=f.tts();t.after(()=>tts.dispose());const abort=new AbortController();
  const stream=tts.synthesize('many',{signal:abort.signal});await stream.next();await delay(50);
  const produced=Number(await readFile(join(f.directory,'produced'),'utf8'));assert.ok(produced<400);
  await assert.rejects(collect(tts.synthesize('overlap')),{code:'speech-busy'});
  abort.abort();await tts.dispose();for(const pid of await f.workers())gone(pid);
  await assert.rejects(stream.next(),{code:'speech-aborted'});
  await assert.rejects(collect(tts.synthesize('again')),{code:'speech-disposed'});
});

test('TTS validates request identity, ordering, base64, done frames, line bounds and process death',async(t)=>{
  const f=await fixture(t);const tts=f.tts();t.after(()=>tts.dispose());
  for(const mode of ['id','seq','base64','frames','line','death','error']){
    await assert.rejects(collect(tts.synthesize(mode)),error=>error.code.startsWith('speech-')&&!error.message.includes('PRIVATE'));
    for(const pid of await f.workers())gone(pid);
  }
  assert.equal((await collect(tts.synthesize('recovered'))).length,48000);
});

test('TTS timeout kills unresponsive worker and does not retain busy state',async(t)=>{
  // Include cold process/filesystem startup under the full parallel suite.
  // The hang fixture never returns; this still exercises actual timeout/KILL.
  const f=await fixture(t);const tts=f.tts({timeoutMs:1000});t.after(()=>tts.dispose());
  await assert.rejects(collect(tts.synthesize('hang')),{code:'speech-timeout'});
  for(const pid of await f.workers())gone(pid);
  assert.equal((await collect(tts.synthesize('recovered'))).length,48000);
});

test('TTS startup failure and invalid requests never return pretend audio',async(t)=>{
  const f=await fixture(t);const tts=f.tts();t.after(()=>tts.dispose());
  for(const options of [{language:'bad'},{voice:'missing'},{speechRate:NaN},{speechRate:3}])
    await assert.rejects(collect(tts.synthesize('hello',options)),error=>error.code.startsWith('speech-'));
  await assert.rejects(collect(tts.synthesize('')),{code:'speech-request-invalid'});
  await writeFile(f.worker,"console.log(JSON.stringify({type:'error',code:'SECRET'}))");
  await assert.rejects(collect(tts.synthesize('hello')),{code:'speech-startup-failed'});
});

test('TTS startup deadline, output duration bound and dispose without caller abort',async(t)=>{
  const f=await fixture(t);const tts=f.tts();t.after(()=>tts.dispose());
  await assert.rejects(collect(tts.synthesize('many')),{code:'speech-output-limit'});
  const stream=tts.synthesize('hello');await stream.next();await tts.dispose();
  for(const pid of await f.workers())gone(pid);
  await assert.rejects(stream.next(),{code:'speech-disposed'});
  await writeFile(f.worker,'setInterval(()=>{},1000)');
  const startup=f.tts({timeoutMs:150});t.after(()=>startup.dispose());
  await assert.rejects(collect(startup.synthesize('hello')),{code:'speech-timeout'});
});

test('model installer verifies bytes/hash, refuses replacement and never publishes partial success',async()=>{
  const code=`
import hashlib, io, json, tempfile
from pathlib import Path
import sys
sys.path.insert(0,'scripts')
from prepare_voice import install
with tempfile.TemporaryDirectory() as temporary:
 root=Path(temporary); manifest=root/'manifest.json'; data=b'model-bytes'
 manifest.write_text(json.dumps({'version':1,'files':[{'path':'tts/model.bin','url':'https://invalid.example/model','bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()}]}))
 target=root/'assets'
 install(target,manifest,lambda *a,**k:io.BytesIO(data))
 install(target,manifest,lambda *a,**k:(_ for _ in ()).throw(AssertionError('must reuse verified file')))
 assert (target/'installed.json').exists()
 (target/'tts/model.bin').write_bytes(b'corrupt')
 try: install(target,manifest,lambda *a,**k:io.BytesIO(data));assert False
 except ValueError: pass
 assert not (target/'installed.json').exists()
 for content in (data[:-1],data+b'x',b'x'*len(data)):
  bad=root/('bad'+str(len(content)))
  try:install(bad,manifest,lambda *a,**k:io.BytesIO(content));assert False
  except ValueError:pass
  assert not (bad/'installed.json').exists()
  assert not list(bad.rglob('*.partial'))
 print('verified')
`;
  const result=await exec(process.env.STACKCHAN_TEST_PYTHON||'python3',['-c',code],{cwd:resolve('.')});
  assert.equal(result.stdout.trim(),'verified');
});

test('real offline Chinese/English Kokoro → whisper round trip (opt-in installed assets)',{
  skip: !process.env.STACKCHAN_LOCAL_VOICE_RUNTIME, timeout:360000,
},async(t)=>{
  const runtime=resolve(process.env.STACKCHAN_LOCAL_VOICE_RUNTIME);
  const tts=new KokoroBackend({python:join(runtime,'venv/bin/python'),assets:join(runtime,'assets')});
  const asr=new WhisperBackend({binary:resolve(process.env.STACKCHAN_WHISPER_BINARY),
    model:join(runtime,'assets/whisper/ggml-small-q5_1.bin'),temporaryDirectory:join(runtime,'utterances')});
  t.after(()=>Promise.all([tts.dispose(),asr.dispose()]));
  for(const [language,text,match] of [['zh','你好，我是希昂。今天我们测试本地语音。',/本地/],['en','Hello. This is a local voice test.',/local voice test/i]]){
    const start=performance.now();let first;const chunks=[];
    for await(const chunk of tts.synthesize(text,{language})){first??=performance.now();chunks.push(chunk);}
    const pcm=Buffer.concat(chunks);const synthesisMs=performance.now()-start;
    const begin=performance.now();const result=await asr.transcribe(pcm,{language});
    assert.match(result.text,match);assert.equal(result.language,language);
    t.diagnostic(JSON.stringify({language,syntheticInput:text,transcript:result.text,firstChunkMs:Math.round(first-start),
      synthesisMs:Math.round(synthesisMs),recognitionMs:Math.round(performance.now()-begin),audioSeconds:pcm.length/48000}));
  }
  assert.deepEqual(await readdir(join(runtime,'utterances')),[]);
});

test('disposing during TTS directory preparation prevents a late worker from starting',async t=>{
  const f=await fixture(t),tts=f.tts();const request=collect(tts.synthesize('hello'));
  const rejected=assert.rejects(request,{code:'speech-disposed'});await tts.dispose();await rejected;
  await assert.rejects(readFile(join(f.directory,'workers')),{code:'ENOENT'});
});
