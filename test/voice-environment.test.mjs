import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink,access} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {createVoiceEnvironment} from '../src/voice-environment.mjs';
const ready=()=>({checkedAt:1,checks:[],filesVerified:true,loadTest:'not_run',failedStage:'',assetBytes:1});
async function directory(t){const path=await mkdtemp(join(tmpdir(),'sion-voice-env-'));t.after(()=>rm(path,{recursive:true,force:true}));return path;}
const status=(report,id)=>report.checks.find(c=>c.id===id).status;
test('unconfigured check is passive, reports each missing component and does not load models',async()=>{
  let loads=0;const env=createVoiceEnvironment({installation:{},factories:{audio(){loads++;throw Error();}}});
  assert.equal(loads,0);const report=await env.verify();assert.equal(loads,0);assert.equal(report.filesVerified,false);assert.equal(report.loadTest,'not_run');
  assert.equal(status(report,'python'),'unconfigured');assert.equal(status(report,'speechAssets'),'unconfigured');
  assert.equal(report.assetBytes,558924578);assert.equal(report.checks.length,8);
});
test('missing assets, corrupt bytes, symlink parents and missing native receipts remain distinct from readiness',async t=>{
  const dir=await directory(t);const assets=join(dir,'assets');await mkdir(assets,{mode:0o700});
  const installation={assetsDirectory:assets,audioDirectory:dir,temporaryDirectory:join(dir,'temporary')};
  const env=createVoiceEnvironment({installation});let report=await env.inspect();
  assert.equal(status(report,'speechAssets'),'missing');assert.equal(status(report,'nativeLibraries'),'missing');
  assert.equal(status(report,'temporaryDirectory'),'available');await assert.rejects(access(installation.temporaryDirectory));
  await mkdir(join(assets,'kokoro'),{mode:0o700});await writeFile(join(assets,'kokoro/config.json'),'bad');
  report=await env.inspect();assert.equal(status(report,'speechAssets'),'invalid');
  await rm(join(assets,'kokoro'),{recursive:true});await symlink(dir,join(assets,'kokoro'));
  report=await env.inspect();assert.equal(status(report,'speechAssets'),'invalid');
  assert.equal(JSON.stringify(report).includes(dir),false);
});
test('Python metadata probe rejects unrelated output without exposing it',async t=>{
  const dir=await directory(t),python=join(dir,'fake-python');
  await writeFile(python,`#!${process.execPath}\nconsole.log('PRIVATE VALUE');\n`,{mode:0o700});
  const report=await createVoiceEnvironment({installation:{python}}).inspect();
  assert.equal(status(report,'python'),'invalid');assert.equal(status(report,'packages'),'not_checked');
  assert.doesNotMatch(JSON.stringify(report),/PRIVATE VALUE/);
});
test('cancelling metadata probe waits for its process group to exit',async t=>{
  const dir=await directory(t),python=join(dir,'fake-python'),marker=join(dir,'started');
  await writeFile(python,`#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},100);\n`,{mode:0o700});
  const abort=new AbortController();const pending=createVoiceEnvironment({installation:{python}}).inspect(abort.signal);
  const rejected=assert.rejects(pending);let pid;
  for(let i=0;i<100;i++){try{pid=Number(await readFile(marker,'utf8'));break;}catch{await delay(10);}}
  assert.ok(pid);abort.abort();await rejected;assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
});
test('offline self-test uses synthetic PCM, waits disposal and reports stage failures without raw details',async()=>{
  const events=[];const env=createVoiceEnvironment({installation:{python:'/test/python',audioDirectory:'/test/audio',assetsDirectory:'/test/assets',whisperBinary:'/test/whisper',temporaryDirectory:'/test/tmp'},factories:{
    inspect:async()=>ready(),audio:()=>({async start(){events.push('audio');},async process(pcm){assert.equal(pcm.length,960);},async dispose(){events.push('audio-close');}}),
    synthesis:()=>({async *synthesize(text,{language}){events.push(language);yield Buffer.alloc(480);},async dispose(){events.push('tts-close');}}),
    recognition:()=>({async transcribe(){throw new Error('PRIVATE');},async dispose(){events.push('asr-close');}}),
  }});
  const report=await env.verify();assert.equal(report.loadTest,'failed');assert.equal(report.failedStage,'recognition');
  assert.deepEqual(events,['audio','audio-close','zh','en','asr-close','tts-close']);assert.doesNotMatch(JSON.stringify(report),/PRIVATE/);
});
test('offline self-test cancellation disposes every created worker before rejection',async()=>{
  const abort=new AbortController(),events=[];
  const env=createVoiceEnvironment({installation:{assetsDirectory:'/test'},factories:{inspect:async()=>ready(),audio:()=>({async start(){abort.abort();throw Error();},async dispose(){await delay(2);events.push('closed');}})}});
  await assert.rejects(env.verify(abort.signal),{code:'voice_cancelled'});assert.deepEqual(events,['closed']);
});
test('voice preview uses fixed local text and returns a mono 24 kHz WAV after synthesis closes',async()=>{
  const events=[];
  const env=createVoiceEnvironment({installation:{},factories:{
    inspect:async()=>ready(),
    audio:()=>assert.fail('preview must not start the input frontend'),
    recognition:()=>assert.fail('preview must not load Whisper'),
    synthesis:()=>({
      async *synthesize(text,{language,voice,speechRate}){
        events.push({text,language,voice,speechRate});
        yield Buffer.from([7,0,9,0]);
      },
      async dispose(){events.push('closed');},
    }),
  }});
  for(const [voice,language,text] of [['','zh','你好，这是音色试听。'],['af_maple','en','Hello, this is a voice preview.']]){
    const sample=await env.preview({language:'auto',voice,speechRate:1.15});
    assert.equal(sample.language,language);
    assert.deepEqual(events.splice(0),[{text,language,voice,speechRate:1.15},'closed']);
    const wav=Buffer.from(sample.wav,'base64');
    assert.equal(wav.toString('ascii',0,4),'RIFF');
    assert.equal(wav.readUInt16LE(22),1);
    assert.equal(wav.readUInt32LE(24),24000);
    assert.equal(wav.readUInt32LE(40),4);
    assert.deepEqual(wav.subarray(44),Buffer.from([7,0,9,0]));
  }
});
test('voice preview validates preferences and stops oversized output before returning a sample',async()=>{
  let probes=0,closed=0;
  const env=createVoiceEnvironment({installation:{},factories:{
    inspect:async()=>{probes++;return ready();},
    synthesis:()=>({
      async *synthesize(){yield Buffer.alloc(24000*2*8+2);assert.fail('preview continued after the limit');},
      async dispose(){closed++;},
    }),
  }});
  await assert.rejects(env.preview({language:'auto',voice:'external',speechRate:1}),{code:'voice_preview_preferences'});
  await assert.rejects(env.preview({language:'zh',voice:'',speechRate:3}),{code:'voice_preview_preferences'});
  assert.equal(probes,0);
  await assert.rejects(env.preview({language:'en',voice:'af_maple',speechRate:1}),{code:'voice_preview_failed'});
  assert.equal(probes,1);
  assert.equal(closed,1);
});
const voice=process.env.STACKCHAN_LOCAL_VOICE_RUNTIME,audio=process.env.STACKCHAN_LOCAL_AUDIO_RUNTIME,binary=process.env.STACKCHAN_WHISPER_BINARY;
test('actual private speech environment passes hash, package metadata and offline model self-test', {skip:!voice||!audio||!binary,timeout:180000},async t=>{
  const dir=await directory(t);const env=createVoiceEnvironment({installation:{python:resolve(voice,'venv/bin/python'),audioDirectory:resolve(audio),assetsDirectory:resolve(voice,'assets'),whisperBinary:resolve(binary),temporaryDirectory:join(dir,'temporary')}});
  const report=await env.verify();assert.equal(report.filesVerified,true,JSON.stringify(report.checks));assert.equal(report.loadTest,'passed',report.failedStage);
});
