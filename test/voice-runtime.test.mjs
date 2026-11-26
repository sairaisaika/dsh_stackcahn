import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {chmod,mkdtemp,readFile,rm,symlink,unlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Context} from '@deepseek-ai/cordis';
import Registry from '@deepseek-ai/dsh-typert-registry';
import Gateway from '@deepseek-ai/dsh-api-gateway';
import {VoiceRemote} from '../lib/remote-api.js';
import {TYPERT} from '../lib/typert.host.js';
import {createVoiceDiagnosticStore} from '../src/voice-diagnostics.mjs';
import {createVoiceRuntime} from '../src/voice-runtime.mjs';
import {readRelayConfiguration,relayConfigName} from '../src/agent-relay-config.mjs';

const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});promise.catch(()=>{});return {promise,resolve,reject};};
const installation={python:'/private/python',audioDirectory:'/private/audio',assetsDirectory:'/private/assets',whisperBinary:'/private/whisper',temporaryDirectory:'/private/utterances'};
function fixture(t,overrides={}){
  const events=[];let preferences={sessionId:'existing',asrBackend:'whisper.cpp',ttsBackend:'kokoro',language:'zh',voice:'',speechRate:1};
  const lost=deferred();const connection={snapshot:()=>({phase:bridge.state==='bridged'?'active':'idle'})};
  const bridge={state:'idle',status(){return {state:this.state,lastError:null};},async enter(id){events.push('enter:'+id);this.state='bridged';},async stop(){events.push('stop');this.state='idle';return this.status();},...overrides.bridge};
  const transport={connection:null,async listen(){events.push('listen');},async close(){events.push('listener-close');},...overrides.transport};
  const identity={pairing:{SECRET:'hidden'},deviceId:'123456abcdef',closed:lost.promise,async release(){events.push('identity-release');lost.resolve({expected:true});},...overrides.identity};
  let issued=0;
  const pairing={async acquireIdentity(){events.push('identity');if(!issued++)return identity;const next=deferred();return {...identity,closed:next.promise,async release(){events.push('identity-release');next.resolve({expected:true});}};},...overrides.pairing};
  const voice={async dispose(){events.push('voice-close');}};
  const runtime=createVoiceRuntime({ctx:overrides.ctx??{},pairing,getPreferences:()=>preferences,installation:overrides.installation??installation,profileDirectory:overrides.profileDirectory,
    onVoiceFault:overrides.onVoiceFault,onVoiceDiagnostic:overrides.onVoiceDiagnostic,
    factories:{transport:()=>transport,voice:overrides.voice??(()=>voice),bridge:overrides.makeBridge??(()=>bridge),
      relayRetryDelay:overrides.relayRetryDelay,
      ...(overrides.setup?{installation:overrides.setup}:{}),environment:overrides.environment??{async inspect(){return {filesVerified:true};}}}});
  t.after(()=>runtime.dispose().catch(()=>{}));
  return {runtime,events,bridge,transport,lost,connect(){transport.connection=connection;},change(p){preferences={...preferences,...p};}};
}

async function photoFixture(t){
  const {default:sharp}=await import('sharp');
  const picture={mediaType:'image/jpeg',width:32,height:24,
    jpeg:await sharp({create:{width:32,height:24,channels:3,background:'blue'}}).jpeg().toBuffer()};
  const captured=deferred(),saving=deferred(),saved=deferred();let captures=0,epoch='1';
  let provider={async saveImage(){saving.resolve();return saved.promise;}};
  const f=fixture(t,{ctx:{get:name=>name==='attachments'?provider:undefined}});
  await f.runtime.execute('start');f.connect();await f.runtime.execute('connect');
  f.transport.connection.snapshot=()=>({phase:f.bridge.state==='bridged'?'active':'idle',bootId:'boot',epoch});
  f.transport.connection.captureCamera=async()=>{captures++;return captured.promise;};
  return {...f,picture,captured,saving,saved,get captures(){return captures;},nextEpoch(){epoch=String(+epoch+1);},
    provider(value){provider=value;},ref:{attachmentId:'sha256:'+'a'.repeat(64),mediaType:'image/jpeg',width:32,height:24,bytes:100}};
}
test('photo authority is the active selected session; no storage or capture on missing provider / wrong session',async t=>{
  const f=await photoFixture(t);
  await assert.rejects(f.runtime.photograph({}),{code:'capability_session_required'});
  f.provider(undefined);await assert.rejects(f.runtime.photograph({id:'existing'}),{code:'camera_attachments_unavailable'});
  assert.equal(f.captures,0);
});
test('photo import stays exclusive through storage and returns only the current result',async t=>{
  const f=await photoFixture(t);const pending=f.runtime.photograph({id:'existing'});
  f.captured.resolve(f.picture);await f.saving.promise;
  assert.equal(f.runtime.snapshot().camera.operation,'importing');
  await assert.rejects(f.runtime.photograph({id:'existing'}),{code:'camera-busy'});
  f.saved.resolve(f.ref);assert.deepEqual(await pending,{version:1,attachment:f.ref});assert.equal(f.captures,1);
  assert.equal(f.runtime.snapshot().camera.operation,'saved');
});
test('Stop and reconnect cannot publish a photo whose native save was already running',async t=>{
  const f=await photoFixture(t);const pending=f.runtime.photograph({id:'existing'});
  const rejected=assert.rejects(pending,{code:'capability_inactive'});
  f.captured.resolve(f.picture);await f.saving.promise;
  await f.runtime.execute('stop');await f.runtime.execute('connect');
  f.saved.resolve(f.ref);await rejected;
});
test('device epoch changes invalidate photos even without a settings action',async t=>{
  const f=await photoFixture(t);const pending=f.runtime.photograph({id:'existing'});
  const rejected=assert.rejects(pending,{code:'camera_session_changed'});
  f.captured.resolve(f.picture);await f.saving.promise;f.nextEpoch();f.saved.resolve(f.ref);await rejected;
});
test('service restart cannot stack more image imports behind an uncancellable old save',async t=>{
  const f=await photoFixture(t);const pending=f.runtime.photograph({id:'existing'});
  const rejected=assert.rejects(pending,{code:'capability_inactive'});
  f.captured.resolve(f.picture);await f.saving.promise;
  await f.runtime.execute('shutdown');await f.runtime.execute('start');f.connect();await f.runtime.execute('connect');
  await assert.rejects(f.runtime.photograph({id:'existing'}),{code:'camera-busy'});
  f.saved.resolve(f.ref);await rejected;assert.equal(f.captures,1);
});
test('saved preference changes during capture prevent starting attachment writes',async t=>{
  const f=await photoFixture(t);const pending=f.runtime.photograph({id:'existing'});
  const rejected=assert.rejects(pending,{code:'voice_restart_required'});
  f.change({sessionId:'different'});f.captured.resolve(f.picture);await rejected;
});
test('provider withdrawal and tool cancellation discard a late durable image reference',async t=>{
  for(const mode of ['provider','abort']){
    const f=await photoFixture(t),abort=new AbortController();
    const pending=f.runtime.photograph({id:'existing'},abort.signal);
    const rejected=assert.rejects(pending,mode==='provider'?{code:'camera_attachments_unavailable'}:{name:'AbortError'});
    f.captured.resolve(f.picture);await f.saving.promise;
    if(mode==='provider')f.provider(undefined);else abort.abort();
    f.saved.resolve(f.ref);await rejected;
  }
});
test('Host runtime is passive; explicit start locks identity, connect applies saved existing session, shutdown orders release',async t=>{
  const f=fixture(t);assert.deepEqual(f.events,[]);assert.equal(f.runtime.snapshot().applied,false);
  const started=await f.runtime.execute('start');assert.equal(started.phase,'listening');assert.equal(started.deviceIdleConfirmed,false);
  await assert.rejects(f.runtime.execute('connect'),{code:'voice_device_missing'});f.connect();
  assert.equal((await f.runtime.execute('connect')).applied,true);
  assert.ok(f.events.includes('enter:existing'));
  const stopped=await f.runtime.execute('stop');assert.equal(stopped.phase,'listening');assert.equal(stopped.deviceIdleConfirmed,true);
  assert.equal(f.events.includes('identity-release'),false);
  await f.runtime.execute('shutdown');assert.ok(f.events.indexOf('listener-close')<f.events.indexOf('identity-release'));
  assert.equal(f.runtime.snapshot().phase,'stopped');
  assert.equal(JSON.stringify(f.runtime.snapshot()).includes('SECRET'),false);
});

test('connect reports fixed startup reasons without exposing the internal error', async t => {
  const cases=[
    [{activationStage:'local-audio'},'voice_local_audio_start_failed'],
    [{activationStage:'device-audio'},'voice_device_audio_start_failed'],
    [{activationStage:'device-link'},'voice_device_link_lost'],
    [{code:'session-migration-required'},'voice_selected_session_unavailable'],
  ];
  for (const [details, code] of cases) {
    const f=fixture(t,{bridge:{async enter(){throw Object.assign(new Error('/private/model.key'),details);}}});
    await f.runtime.execute('start');
    f.connect();
    await assert.rejects(f.runtime.execute('connect'),{code,message:code});
    assert.equal(f.runtime.snapshot().lastError,code);
  }
});

test('fault logs project fixed codes and metadata without private diagnostics', async t => {
  const reports=[];
  let report;
  const f=fixture(t,{onVoiceFault:sample=>reports.push(sample),voice:options=>{
    report=options.onActiveFault;return {async dispose(){}};
  }});
  await f.runtime.execute('start');
  report({source:'transport',code:'protocol-invalid',protocolCode:'input-order',activeMs:21.3,firstInputReceived:true,
    message:'/private/clip.wav',deviceId:'private'});
  report({source:'private-source',code:'private-root-cause',protocolCode:'private-protocol',activeMs:-3});
  assert.deepEqual(reports,[
    {version:1,transport:'lan',source:'transport',code:'protocol-invalid',protocolCode:'input-order',activeMs:21,firstInputReceived:true},
    {version:1,transport:'lan',source:'unknown',code:'unknown',firstInputReceived:false},
  ]);
  await f.runtime.execute('shutdown');
  report({source:'transport',code:'disconnected'});
  assert.equal(reports.length,2);
});

test('explicit service Start primes local speech while idle; Stop and Shutdown join cleanup', async t => {
  const events = [];
  const cleanup = deferred();
  const f = fixture(t, {voice:() => ({
    prewarmSynthesis() { events.push('warm'); },
    async cancelPrewarm() { events.push('cancel'); await cleanup.promise; },
    async dispose() { events.push('dispose'); await cleanup.promise; },
  })});
  t.after(() => cleanup.resolve());
  assert.deepEqual(events, []);
  const listening = await f.runtime.execute('start');
  assert.equal(listening.applied, false);
  assert.equal(listening.connected, false);
  assert.deepEqual(events, ['warm']);
  const stopping = f.runtime.execute('stop');
  assert.deepEqual(events, ['warm','cancel']);
  const closing = f.runtime.execute('shutdown');
  assert.equal(f.runtime.snapshot().phase, 'stopping');
  cleanup.resolve();
  await stopping;
  await closing;
  assert.deepEqual(events, ['warm','cancel','dispose']);
  assert.equal(f.runtime.snapshot().phase, 'stopped');
});

test('latency preview is opt-in, contains only rounded timing fields and resets on next connect',async t=>{
  let sample,voiceOptions;
  const f=fixture(t,{
    voice(options){voiceOptions=options;return {async dispose(){}};},
    makeBridge(_ctx,options){sample=options.onLatency;return f.bridge;},
  });
  await f.runtime.execute('start');
  assert.equal(voiceOptions.measureLatency,false);
  assert.equal(sample,undefined);
  assert.deepEqual(f.runtime.snapshot().latency,{enabled:false,latest:null});
  await f.runtime.execute('shutdown');
  f.change({measureLatency:true});
  f.connect();
  await f.runtime.execute('start');
  assert.equal(voiceOptions.measureLatency,true);
  assert.deepEqual(f.runtime.snapshot().latency,{enabled:true,latest:null});
  await f.runtime.execute('connect');
  sample({asrMs:301.6,outputAckMs:0.2,bridgeQueueMs:NaN,sessionId:'private',segmentToFirstOutputAckMs:790.2});
  const latest={asrMs:302,outputAckMs:0,segmentToFirstOutputAckMs:790};
  assert.deepEqual(f.runtime.snapshot().latency,{enabled:true,latest});
  await f.runtime.execute('stop');
  sample({segmentToFirstOutputAckMs:1000});
  assert.deepEqual(f.runtime.snapshot().latency.latest,latest);
  await f.runtime.execute('connect');
  assert.equal(f.runtime.snapshot().latency.latest,null);
  await f.runtime.execute('shutdown');
  assert.deepEqual(f.runtime.snapshot().latency,{enabled:false,latest:null});
});

test('USB starts without a listener, opens the saved port on Connect and keeps it through Stop',async t=>{
  const calls=[];
  const stream={};let open=false;
  const f=fixture(t,{
    identity:{openUsb(port){open=true;calls.push(port);return {stream,ready:Promise.resolve(),async close(){open=false;}};}},
    transport:{async attachUsb(selected){assert.equal(selected,stream);f.connect();}},
  });
  f.change({transport:'usb',usbPort:'/dev/cu.usbmodemfixture'});
  const started=await f.runtime.execute('start');
  assert.equal(started.transport,'usb');assert.equal(started.phase,'listening');assert.equal(started.connected,false);
  assert.deepEqual(f.events,['identity']);assert.deepEqual(calls,[]);
  await f.runtime.execute('connect');assert.equal(open,true);assert.deepEqual(calls,['/dev/cu.usbmodemfixture']);
  assert.ok(f.events.includes('enter:existing'));
  assert.equal((await f.runtime.execute('stop')).deviceIdleConfirmed,true);assert.equal(open,true);
  await f.runtime.execute('connect');assert.equal(calls.length,1);
  const end=await f.runtime.execute('shutdown');assert.equal(end.transport,null);assert.equal(open,false);
});

test('USB standby on a silent port (as with the factory firmware) writes nothing, stays outside TLS and cancels cleanly',{timeout:3000},async t=>{
  const {Duplex}=await import('node:stream');
  const profileDirectory=await mkdtemp(join(tmpdir(),'sion-usb-no-ready-'));
  t.after(()=>rm(profileDirectory,{recursive:true,force:true}));
  const diagnosticStore=createVoiceDiagnosticStore(profileDirectory,()=>assert.fail('fixture diagnostic store unavailable'));
  let written=0;
  const stream=new Duplex({read(){},write(_bytes,_encoding,done){written++;done();}});
  t.after(()=>stream.destroy());
  const f=fixture(t,{
    onVoiceDiagnostic:diagnosticStore.write,
    identity:{openUsb(){return {stream,ready:Promise.resolve(),async close(){stream.destroy();}};}},
    transport:{async attachUsb(){assert.fail('TLS requires a device ready receipt');}},
  });
  f.change({transport:'usb',usbPort:'/dev/cu.usbmodemfixture'});
  await f.runtime.execute('start');
  await f.runtime.execute('arm-usb');
  // Longer than the old probe interval (500 ms): a listening Host still has written nothing.
  await new Promise(resolve=>setTimeout(resolve,1200));
  assert.equal(written,0);
  assert.equal(f.runtime.snapshot().usbStandby,true);
  assert.equal(f.runtime.snapshot().connected,false);
  assert.deepEqual(f.events,['identity']);
  const stopped=await f.runtime.execute('stop');
  assert.equal(stopped.usbStandby,false);
  assert.equal(stopped.deviceIdleConfirmed,false);
  await diagnosticStore.flush();
  const contents=await readFile(join(profileDirectory,'.stackchan-diagnostics','voice.jsonl'),'utf8');
  const events=contents.trim().split('\n').map(line=>JSON.parse(line).event);
  assert.ok(events.includes('usb-opened')&&events.includes('usb-connect-ended'));
  assert.equal(events.includes('usb-device-ready'),false);
  assert.equal(events.includes('usb-authenticated'),false);
});

test('USB standby reports device link loss during audio startup, keeps identity and waits to retry',{timeout:2000},async t=>{
  const {Duplex}=await import('node:stream');
  const {USB_STANDBY_READY}=await import('../src/agent-usb-wire.mjs');
  const entering=deferred(),dropped=deferred();let peerPhase='idle';
  // The DSH firmware announces itself unprompted (v77); the Host writes nothing before that.
  const stream=new Duplex({read(){},write(_chunk,_encoding,done){assert.fail('nothing is written before TLS');done();}});
  setTimeout(()=>stream.push(USB_STANDBY_READY),50);
  t.after(()=>{dropped.resolve();stream.destroy();});
  const f=fixture(t,{
    identity:{openUsb(port){
      assert.equal(port,'/dev/cu.usbmodemfixture');
      return {stream,ready:Promise.resolve(),async close(){f.events.push('usb-close');stream.destroy();}};
    }},
    transport:{async attachUsb(selected){
      assert.equal(selected,stream);f.connect();
      this.connection.snapshot=()=>({phase:peerPhase});
      this.connection.close=async options=>{
        assert.deepEqual(options,{graceful:true});f.events.push('peer-close');this.connection=null;
      };
    }},
    bridge:{async enter(id){
      f.events.push('enter:'+id);this.state='connecting';entering.resolve();
      await dropped.promise;peerPhase='closed';this.state='idle';
      throw Object.assign(new Error('transport dropped during audio startup'),{activationStage:'device-link'});
    }},
    voice:()=>({async cancelPrewarm(){f.events.push('cancel-warm');},async dispose(){}}),
    // Hold the first retry so the waiting state can be observed.
    relayRetryDelay(ms,_value,{signal}){
      f.events.push('retry-wait:'+ms);
      return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
    },
  });
  f.change({transport:'usb',usbPort:'/dev/cu.usbmodemfixture'});
  await f.runtime.execute('start');
  assert.equal((await f.runtime.execute('arm-usb')).usbStandby,true);
  await entering.promise;
  assert.equal(f.runtime.snapshot().connected,true);
  assert.equal(f.runtime.snapshot().usbStandby,true);
  dropped.resolve();await new Promise(resolve=>setImmediate(resolve));
  const state=f.runtime.snapshot();
  // The standing request survives one lost link. The reason stays visible.
  assert.equal(state.usbStandby,true);assert.equal(state.connected,false);
  assert.equal(state.lastError,'voice_device_link_lost');
  assert.equal(state.transport,'usb');assert.equal(state.sessionId,'existing');
  assert.deepEqual(f.events,['identity','enter:existing','peer-close','retry-wait:250']);
  await f.runtime.execute('shutdown');
  assert.ok(f.events.includes('cancel-warm'));
  assert.ok(f.events.includes('usb-close'));assert.ok(f.events.includes('identity-release'));
});

async function relayProfile(t) {
  const directory=await mkdtemp(join(tmpdir(),'sion-relay-profile-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const path=join(directory,relayConfigName);
  const config={version:1,endpoint:'wss://relay.example.test',roomId:'a'.repeat(32),pairId:'b'.repeat(32),token:'c'.repeat(64)};
  return {directory,path,config,write: (value=config)=>writeFile(path,JSON.stringify(value),{mode:0o600})};
}
test('Host relay credentials only accept a bounded private regular file and a verified TLS origin',async t=>{
  const p=await relayProfile(t);
  const check=()=>readRelayConfiguration(p.directory);
  await assert.rejects(check(),{code:'voice_relay_config_missing'});
  await p.write();
  assert.equal((await check()).endpoint,'wss://relay.example.test/');
  await chmod(p.path,0o644);
  await assert.rejects(check(),{code:'voice_relay_config_invalid'});
  await chmod(p.path,0o600);
  for(const patch of [{endpoint:'ws://relay.example.test'},{endpoint:'wss://relay.example.test/?token=secret'},
    {endpoint:'wss://u:p@relay.example.test'},{key:p.config.token},{ca:'wrong-cert'}]){
    await p.write({...p.config,...patch});
    await assert.rejects(check(),{code:'voice_relay_config_invalid'});
  }
  await writeFile(p.path,Buffer.alloc(16385));
  await assert.rejects(check(),{code:'voice_relay_config_invalid'});
  const alternate=join(p.directory,'other.json');
  await writeFile(alternate,JSON.stringify(p.config),{mode:0o600});
  await unlink(p.path);await symlink(alternate,p.path);
  await assert.rejects(check(),{code:'voice_relay_config_invalid'});
});

test('relay uses pairing-bound Host material and the selected existing session without a LAN listener',async t=>{
  const p=await relayProfile(t);
  await p.write();
  const incompatible=fixture(t,{profileDirectory:p.directory});
  incompatible.change({transport:'relay'});
  await assert.rejects(incompatible.runtime.execute('start'),{code:'voice_relay_identity_mismatch'});
  assert.ok(incompatible.events.includes('identity-release'));

  let attempts=0;
  const f=fixture(t,{profileDirectory:p.directory,identity:{pairing:{record:{pair_id:p.config.pairId}}},
    transport:{async attachRelay(options) {
      assert.equal(options.token,p.config.token);
      assert.equal(options.roomId,p.config.roomId);
      assert.equal(options.pairId,undefined);
      if(!attempts++)throw Object.assign(new Error('fixture'),{code:'relay-closed'});
      f.connect();
    }},
  });
  f.change({transport:'relay'});
  const started=await f.runtime.execute('start');
  assert.equal(started.connected,false);
  assert.equal(started.transport,'relay');
  assert.deepEqual(f.events,['identity']);
  await assert.rejects(f.runtime.execute('connect'),{code:'voice_relay_timeout'});
  assert.equal((await f.runtime.execute('connect')).applied,true);
  const publicState=JSON.stringify(f.runtime.snapshot());
  for(const value of [p.config.token,p.config.endpoint,p.config.pairId,p.config.roomId])assert.ok(!publicState.includes(value));
  assert.ok(f.events.includes('enter:existing'));
  assert.equal((await f.runtime.execute('stop')).deviceIdleConfirmed,true);
  await f.runtime.execute('connect');assert.equal(attempts,2);
  await f.runtime.execute('shutdown');
  assert.ok(f.events.indexOf('listener-close')<f.events.indexOf('identity-release'));
});

test('relay Stop cancels a pending rendezvous and waits for actual closure',async t=>{
  const p=await relayProfile(t);
  await p.write();
  const joining=deferred(),released=deferred();
  const f=fixture(t,{profileDirectory:p.directory,identity:{pairing:{record:{pair_id:p.config.pairId}}},
    transport:{attachRelay({signal}){
      joining.resolve();
      return new Promise((_,reject)=>signal.addEventListener('abort',()=>released.promise.then(()=>reject(Error('cancelled'))),{once:true}));
    }},
  });
  f.change({transport:'relay'});
  await f.runtime.execute('start');
  const rejected=assert.rejects(f.runtime.execute('connect'),{code:'voice_cancelled'});
  await joining.promise;
  assert.equal(f.runtime.snapshot().phase,'connecting');
  let stopped=false;
  const pending=f.runtime.execute('stop').then(result=>{stopped=true;return result;});
  await delay(1);assert.equal(stopped,false);
  released.resolve();
  const result=await pending;await rejected;
  assert.equal(result.phase,'listening');assert.equal(result.deviceIdleConfirmed,false);
});

test('relay standby survives a rendezvous expiry, then waits for the paired device and can be revoked',async t=>{
  const p=await relayProfile(t);await p.write();
  const retry=deferred(),joining=deferred(),released=deferred();
  let attempts=0;
  const f=fixture(t,{profileDirectory:p.directory,identity:{pairing:{record:{pair_id:p.config.pairId}}},
    async relayRetryDelay(ms){assert.equal(ms,250);await retry.promise;},
    transport:{async attachRelay({signal}){
      if(++attempts===1)throw Object.assign(new Error('expired'),{code:'relay-closed'});
      joining.resolve();
      await new Promise((_,reject)=>signal.addEventListener('abort',()=>released.promise.then(()=>reject(Error('cancelled'))),{once:true}));
    }},
  });
  f.change({transport:'relay'});
  await f.runtime.execute('start');assert.equal(attempts,0);
  const request=new AbortController();
  const armed=await f.runtime.execute('arm-relay',request.signal);
  request.abort();
  assert.equal(armed.relayStandby,true);assert.equal(armed.applied,false);
  await assert.rejects(f.runtime.execute('connect'),{code:'voice_busy'});
  retry.resolve();await joining.promise;
  assert.equal(f.runtime.snapshot().phase,'listening');
  assert.deepEqual(f.events,['identity']);
  let stopped=false;
  const stopping=f.runtime.execute('stop').then(value=>{stopped=true;return value;});
  await delay(5);assert.equal(stopped,false);
  released.resolve();assert.equal((await stopping).relayStandby,false);
  await f.runtime.execute('shutdown');assert.equal(attempts,2);
});

test('relay standby closes a newly authenticated peer if the saved session changed while waiting',async t=>{
  const p=await relayProfile(t);await p.write();
  const admitted=deferred(),closed=deferred();
  const f=fixture(t,{profileDirectory:p.directory,identity:{pairing:{record:{pair_id:p.config.pairId}}},
    transport:{async attachRelay(){
      await admitted.promise;
      this.connection={snapshot:()=>({phase:'idle'}),close:()=>{this.connection=null;closed.resolve();}};
    }},
  });
  f.change({transport:'relay'});
  await f.runtime.execute('start');await f.runtime.execute('arm-relay');
  f.change({sessionId:'another'});admitted.resolve();await closed.promise;
  await new Promise(resolve=>setImmediate(resolve)); // The carrier close callback precedes standby cleanup.
  const state=f.runtime.snapshot();
  assert.equal(state.lastError,'voice_restart_required');assert.equal(state.relayStandby,false);
  assert.equal(state.sessionId,'existing');assert.deepEqual(f.events,['identity']);
});

test('LAN standby revalidates the saved session for a replacement peer during DSH bind',async t=>{
  const events=new EventEmitter();
  const binding=deferred(),replacement=deferred();
  let getConnection,attempts=0;
  const f=fixture(t,{
    transport:{events},
    voice(options){getConnection=options.getConnection;return {async dispose(){}};},
    makeBridge(_ctx,{onReleased}){
      return {...f.bridge,async enter(id){
        assert.equal(id,'existing');
        this.state='connecting';
        if(++attempts===1){
          binding.resolve();
          await replacement.promise;
        }
        const peer=getConnection();
        if(!peer){
          this.state='idle';
          throw Object.assign(new Error('lost connection during bind'),{code:'voice-device-not-ready'});
        }
        f.events.push('enter:'+id+':'+peer.name);this.state='bridged';
      },async stop(){
        const result=await f.bridge.stop.call(this);onReleased(result);return result;
      }};
    },
  });
  function join(name){
    const peer={name,snapshot:()=>({phase:'idle'}),close(){
      f.events.push('close:'+name);
      if(f.transport.connection===peer)f.transport.connection=null;
    }};
    f.transport.connection=peer;events.emit('connection',peer);
  }
  await f.runtime.execute('start');
  assert.equal((await f.runtime.execute('arm-lan')).lanStandby,true);
  join('first');await binding.promise;
  join('replacement');replacement.resolve();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(attempts,2);
  assert.equal(f.runtime.snapshot().phase,'active');
  assert.deepEqual(f.events,['identity','listen','close:first','enter:existing:replacement']);
  const stopped=await f.runtime.execute('stop');
  assert.equal(stopped.lanStandby,false);
  assert.equal(stopped.deviceIdleConfirmed,true);
  assert.equal(stopped.connected,false);
});

test('LAN standby cannot apply preferences saved while waiting and can be cancelled without a peer',async t=>{
  const events=new EventEmitter();
  const f=fixture(t,{transport:{events}});
  await f.runtime.execute('start');
  await f.runtime.execute('arm-lan');
  assert.equal((await f.runtime.execute('stop')).lanStandby,false);
  assert.equal(events.listenerCount('connection'),0);
  await f.runtime.execute('arm-lan');
  f.change({sessionId:'another'});
  f.transport.connection={snapshot:()=>({phase:'idle'}),close(){f.transport.connection=null;}};
  events.emit('connection',f.transport.connection);
  await new Promise(resolve=>setImmediate(resolve));
  const state=f.runtime.snapshot();
  assert.equal(state.lanStandby,false);
  assert.equal(state.connected,false);
  assert.equal(state.lastError,'voice_restart_required');
  assert.equal(state.sessionId,'existing');
  assert.equal(f.events.some(event=>event.startsWith('enter:')),false);
});

test('reconnection keeps the selected session and identity and requires a fresh idle peer', async t => {
  let clean = false;
  const opened = [];
  const f = fixture(t, {
    voice: () => ({ canReconnect: () => clean, retireDisconnected() { clean = false; return true; }, async dispose() {} }),
    makeBridge() {
      if (!opened.length) { opened.push(f.bridge); return f.bridge; }
      const bridge = { ...f.bridge, state: 'idle' };
      opened.push(bridge);
      return bridge;
    },
  });
  await f.runtime.execute('start');
  f.connect();
  await f.runtime.execute('connect');
  f.bridge.state = 'recovering';
  f.transport.connection = null;
  assert.equal(f.runtime.snapshot().phase, 'fault');
  await assert.rejects(f.runtime.execute('connect'), { code: 'voice_release_unconfirmed' });
  clean = true;
  assert.equal(f.runtime.snapshot().canReconnect, true);
  assert.equal(f.runtime.snapshot().deviceIdleConfirmed, false);
  await assert.rejects(f.runtime.execute('connect'), { code: 'voice_device_missing' });
  f.transport.connection = { snapshot: () => ({ phase: 'active' }) };
  await assert.rejects(f.runtime.execute('connect'), { code: 'voice_release_unconfirmed' });
  assert.equal(opened.length, 1);
  f.connect();
  f.change({ sessionId: 'other' });
  await assert.rejects(f.runtime.execute('connect'), { code: 'voice_restart_required' });
  f.change({ sessionId: 'existing' });
  assert.equal((await f.runtime.execute('connect')).phase, 'active');
  assert.equal(opened.length, 2);
  assert.deepEqual(f.events, ['identity', 'listen', 'enter:existing', 'enter:existing']);
});

test('USB Stop cancels opening, waits for handle release, and does not confirm device idle',async t=>{
  const entered=deferred(), ready=deferred(), destroyed=deferred();let closed=false;
  const f=fixture(t,{identity:{openUsb(){entered.resolve();return {stream:{},ready:ready.promise,
    close(){ready.reject(new Error('closed'));return destroyed.promise.then(()=>{closed=true;});}};}},
    transport:{async attachUsb(){assert.fail('cancelled port must never authenticate');}},
  });
  f.change({transport:'usb',usbPort:'/dev/cu.usbmodemfixture'});
  await f.runtime.execute('start');
  const rejected=assert.rejects(f.runtime.execute('connect'),{code:'voice_cancelled'});await entered.promise;
  assert.equal(f.runtime.snapshot().phase,'connecting');
  let stopped=false;
  const stop=f.runtime.execute('stop').then(state=>{stopped=true;return state;});
  await delay(1);assert.equal(stopped,false);destroyed.resolve();
  const result=await stop;await rejected;
  assert.equal(closed,true);assert.equal(result.phase,'listening');assert.equal(result.deviceIdleConfirmed,false);
});

test('errors opening or authenticating USB leave the selected service available to retry',async t=>{
  let attempts=0,closed=0;
  const f=fixture(t,{identity:{openUsb(){++attempts;return {stream:{},ready:attempts===1
    ?Promise.reject(Object.assign(new Error('fixture'),{code:'voice_usb_port_unavailable'})):Promise.resolve(),
    async close(){closed++;}};}},
    transport:{async attachUsb(){if(attempts===2)throw new Error('fixture');f.connect();}},
  });
  f.change({transport:'usb',usbPort:'/dev/cu.usbmodemfixture'});
  await f.runtime.execute('start');
  await assert.rejects(f.runtime.execute('connect'),{code:'voice_usb_port_unavailable'});
  await assert.rejects(f.runtime.execute('connect'),{code:'voice_usb_handshake_failed'});
  assert.ok(closed>=2);assert.equal(f.runtime.snapshot().phase,'listening');
  const live=await f.runtime.execute('connect');assert.equal(live.phase,'active');assert.equal(live.lastError,'');
});
test('preferences saved while running never silently replace the session',async t=>{
  const f=fixture(t);await f.runtime.execute('start');f.connect();await f.runtime.execute('connect');f.change({sessionId:'another'});
  assert.equal(f.runtime.snapshot().sessionId,'existing');assert.equal(f.runtime.snapshot().pendingChanges,true);
  await f.runtime.execute('stop');await assert.rejects(f.runtime.execute('connect'),{code:'voice_restart_required'});
  await f.runtime.execute('shutdown');await f.runtime.execute('start');f.connect();await f.runtime.execute('connect');
  assert.equal(f.runtime.snapshot().sessionId,'another');
});
test('missing installation and unconfirmed pairing fail without listener or model startup',async t=>{
  const f=fixture(t,{installation:{}});await assert.rejects(f.runtime.execute('start'),{code:'voice_unconfigured'});assert.deepEqual(f.events,[]);
  const g=fixture(t,{pairing:{async acquireIdentity(){throw Object.assign(new Error('private path'),{code:'reconcile_required'});}}});
  await assert.rejects(g.runtime.execute('start'),e=>e.code==='reconcile_required'&&e.message==='reconcile_required');assert.equal(g.runtime.snapshot().phase,'stopped');
});
test('startup cancellation closes pending listener before identity unlock',async t=>{
  const listen=deferred();const f=fixture(t,{transport:{async listen(){await listen.promise;},async close(){f.events.push('listener-close');listen.resolve();}}});
  const start=f.runtime.execute('start');const rejected=assert.rejects(start,{code:'voice_cancelled'});await delay(0);
  await f.runtime.execute('shutdown');await rejected;
  assert.ok(f.events.indexOf('listener-close')<f.events.indexOf('identity-release'));
});
test('identity helper loss fails closed and closes listener instead of continuing with stale credentials',async t=>{
  const f=fixture(t);await f.runtime.execute('start');f.lost.resolve({expected:false});
  for(let i=0;i<100&&f.runtime.snapshot().phase!=='stopped';i++)await delay(1);
  assert.equal(f.runtime.snapshot().phase,'stopped');assert.equal(f.runtime.snapshot().lastError,'voice_identity_lost');assert.ok(f.events.includes('listener-close'));
});
test('unknown device shutdown closes Host resources but keeps lack of device confirmation visible',async t=>{
  const f=fixture(t,{bridge:{async stop(){return {state:'recovering'};}}});await f.runtime.execute('start');f.connect();
  await assert.rejects(f.runtime.execute('shutdown'),{code:'voice_release_unconfirmed'});
  const state=f.runtime.snapshot();assert.equal(state.phase,'stopped');assert.equal(state.deviceIdleConfirmed,false);assert.equal(state.lastError,'voice_release_unconfirmed');
  assert.ok(f.events.includes('identity-release'));
});
test('unexpected bridge shutdown rejection still closes listener, local workers and identity lease',async t=>{
  const f=fixture(t,{bridge:{async stop(){throw new Error('private detail');}}});
  await f.runtime.execute('start');f.connect();
  await assert.rejects(f.runtime.execute('shutdown'),{code:'voice_release_unconfirmed'});
  assert.equal(f.runtime.snapshot().deviceIdleConfirmed,false);
  assert.equal(f.runtime.snapshot().phase,'stopped');
  assert.deepEqual(f.events.slice(-3),['listener-close','voice-close','identity-release']);
  assert.equal(f.runtime.snapshot().lastError,'voice_release_unconfirmed');
});
test('generated voice Remote checks owner, accepts only actions and returns redacted runtime state',async t=>{
  const p=await relayProfile(t);await p.write();
  const f=fixture(t,{profileDirectory:p.directory,identity:{pairing:{record:{pair_id:p.config.pairId}}}});
  const ctx=new Context();await ctx.plugin(Registry);ctx.provide('remoteAccess',{decide:()=>({kind:'allow'})});await ctx.plugin(Gateway);
  ctx.typert.register(TYPERT);ctx.provide('stackchanVoice',f.runtime);new VoiceRemote(ctx);t.after(()=>ctx.fiber.dispose());
  const owner={id:'test-owner',ctx,principal:{kind:'owner'},signal:new AbortController().signal,interactions:'none'};
  const invoke=(args,peer=owner)=>ctx.typertGateway.invoke({namespace:'stackchanVoice',method:'execute',args,peer});
  const stopped=await invoke({action:'snapshot'});
  assert.equal(stopped.phase,'stopped');
  assert.deepEqual(stopped.latency,{enabled:false,latest:null});
  await assert.rejects(invoke({action:'snapshot'}, {...owner,principal:{kind:'viewer'}}),e=>e.code==='stackchan/owner-required');
  await assert.rejects(invoke({action:'start'}, {...owner,principal:{kind:'viewer'}}),e=>e.code==='stackchan/owner-required');
  await assert.rejects(invoke({action:'arm-relay'}, {...owner,principal:{kind:'viewer'}}),e=>e.code==='stackchan/owner-required');
  await assert.rejects(invoke({action:'arm-lan'}, {...owner,principal:{kind:'viewer'}}),e=>e.code==='stackchan/owner-required');
  await assert.rejects(invoke({action:'arm-usb'}, {...owner,principal:{kind:'viewer'}}),e=>e.code==='stackchan/owner-required');
  await assert.rejects(invoke({action:'prepare-environment'}, {...owner,principal:{kind:'viewer'}}),e=>e.code==='stackchan/owner-required');
  await assert.rejects(invoke({action:'check-installation'}, {...owner,principal:{kind:'viewer'}}),e=>e.code==='stackchan/owner-required');
  await assert.rejects(invoke({action:'check-installation',command:'untrusted'}),e=>e.code==='gateway/arguments-invalid');
  await assert.rejects(invoke({action:'repair-environment',url:'https://untrusted.invalid'}),e=>e.code==='gateway/arguments-invalid');
  await assert.rejects(invoke({action:'prepare-environment'}),e=>e.code==='stackchan/voice-failed'&&e.details.reason==='voice_installation_custom');
  await assert.rejects(invoke({action:'start',directory:'/private'}),e=>e.code==='gateway/arguments-invalid');
  await assert.rejects(invoke({action:'connect',endpoint:p.config.endpoint,token:p.config.token}),e=>e.code==='gateway/arguments-invalid');
  await assert.rejects(invoke({action:'arm-relay',sessionId:'another'}),e=>e.code==='gateway/arguments-invalid');
  await assert.rejects(invoke({action:'arm-lan',sessionId:'another'}),e=>e.code==='gateway/arguments-invalid');
  await assert.rejects(invoke({action:'arm-usb',port:'/dev/cu.usbmodem-untrusted'}),e=>e.code==='gateway/arguments-invalid');
  await assert.rejects(invoke({action:'erase'}),e=>e.code==='gateway/input-invalid');assert.deepEqual(f.events,[]);
  const inspect=(args,peer=owner)=>ctx.typertGateway.invoke({namespace:'stackchanVoice',method:'environment',args,peer});
  await assert.rejects(inspect({action:'verify'}, {...owner,principal:{kind:'viewer'}}),e=>e.code==='stackchan/owner-required');
  await assert.rejects(inspect({action:'inspect',python:'/private'}),e=>e.code==='gateway/arguments-invalid');
  await assert.rejects(inspect({action:'download'}),e=>e.code==='gateway/input-invalid');
  const preview=(args,peer=owner)=>ctx.typertGateway.invoke({namespace:'stackchanVoice',method:'preview',args,peer});
  const sample={language:'auto',voice:'af_maple',speechRate:0.5};
  await assert.rejects(preview(sample,{...owner,principal:{kind:'viewer'}}),{code:'stackchan/owner-required'});
  await assert.rejects(preview({...sample,text:'user input'}),{code:'gateway/arguments-invalid'});
  await assert.rejects(preview({...sample,language:'fr'}),{code:'gateway/input-invalid'});
  f.change({transport:'relay'});
  const state=await invoke({action:'start'});
  assert.equal(state.transport,'relay');
  for(const value of [p.config.endpoint,p.config.roomId,p.config.pairId,p.config.token])
    assert.ok(!JSON.stringify(state).includes(value));
  assert.equal((await invoke({action:'shutdown'})).phase,'stopped');
});

test('actual journal, TLS, Host bridge and native photo tool deliver a DSH image in the existing session',async t=>{
  const {mkdtemp,readFile,writeFile,rm}=await import('node:fs/promises');
  const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const {once}=await import('node:events');const {WebSocket}=await import('ws');
  const {createPairingHost}=await import('../src/pairing-host.mjs');
  const {createAgentTransport}=await import('../src/agent-transport.mjs');
  const {createLocalVoice}=await import('../src/local-voice.mjs');
  const {default:sharp}=await import('sharp');
  const {default:Attachments}=await import('@deepseek-ai/dsh-attachment-local');
  const {default:Tools}=await import('@deepseek-ai/dsh-tools');
  const Native=await import('@deepseek-ai/dsh-tool-executor-native');
  const {registerCapabilityTools}=await import('../src/capability-tools.mjs');
  const jpeg=await sharp({create:{width:640,height:480,channels:3,background:'green'}}).jpeg().toBuffer();
  const directory=await mkdtemp(join(tmpdir(),'sion-host-voice-'));
  const pairing=createPairingHost({directory});let runtime;
  t.after(async()=>{await runtime?.dispose().catch(()=>{});await pairing.dispose();await rm(directory,{recursive:true,force:true});});
  assert.equal((await pairing.call({action:'prepare',revision:0,deviceId:'123456abcdef',localUrl:'wss://192.168.1.2:9080/audio'})).ok,true);
  const path=join(directory,'state.json'),state=JSON.parse(await readFile(path,'utf8'));
  state.active=state.candidate;state.candidate=null;await writeFile(path,JSON.stringify(state));
  const bundle=JSON.parse(await readFile(join(directory,state.active,'pairing.json'),'utf8'));
  const before=await readFile(path);let listener,address;const bound=[];
  const controller={async projections({sessionId}){bound.push(sessionId);return {kind:'sequenced'};},async *follow(){throw new Error('unexpected prompt');},async prompt(){throw new Error('unexpected prompt');}};
  const ctx=new Context();t.after(()=>ctx.fiber.dispose());
  ctx.provide('sessionController',controller);ctx.provide('systemPrompt',{tools(){return()=>{};}});
  await ctx.plugin(Attachments,{dshHome:join(directory,'dsh')});await ctx.plugin(Tools);await ctx.plugin(Native);
  runtime=createVoiceRuntime({ctx,pairing,installation,getPreferences:()=>({sessionId:'existing-fixture',asrBackend:'whisper.cpp',ttsBackend:'kokoro',language:'zh',voice:'',speechRate:1}),factories:{
    environment:{async inspect(){return {filesVerified:true};}},
    transport:options=>{listener=createAgentTransport(options);const listen=listener.listen;listener.listen=async()=>{address=await listen({host:'127.0.0.1',port:0});return address;};return listener;},
    voice:options=>createLocalVoice({...options,factories:{audio:()=>({async start(){},async process(){return {segment:null};},async dispose(){}}),recognition:()=>({async dispose(){}}),synthesis:()=>({async dispose(){}})}}),
  }});
  registerCapabilityTools(ctx,runtime);
  await runtime.execute('start');
  const ready=once(listener.events,'connection');const boot='e'.repeat(32);
  const ws=new WebSocket(`wss://127.0.0.1:${address.port}/audio`,'sion-agent-v1',{ca:bundle.record.ca,servername:'sion-host',rejectUnauthorized:true,headers:{Authorization:`Bearer ${bundle.record.local_token}`,'X-Sion-Pair-Id':bundle.record.pair_id,'X-Sion-Device-Id':'123456abcdef'}});
  ws.on('error',()=>{});t.after(()=>ws.terminate());await once(ws,'open');
  ws.send(JSON.stringify({type:'hello',protocol:1,device_id:'123456abcdef',pair_id:bundle.record.pair_id,boot_id:boot,epoch:'0',phase:'idle',playback_fence:1,camera:1}));
  let captures=0;
  await ready;ws.on('message',data=>{
    const m=JSON.parse(data),identity={request_id:m.request_id,boot_id:boot,epoch:m.epoch};
    const send=value=>ws.send(JSON.stringify({...identity,...value}));
    if(['start','stop'].includes(m.type))send({type:m.type==='start'?'started':'stopped',epoch:String(BigInt(m.epoch)+1n),...(m.type==='stop'?{resources_stopped:true}:{})});
    if(m.type==='capture_camera'){captures++;send({type:'camera_meta',bytes:String(jpeg.length),width:'640',height:'480'});}
    if(m.type==='camera_next'){
      const offset=Number(m.offset);
      send(offset===jpeg.length?{type:'camera_complete'}:{type:'camera_chunk',offset:m.offset,data:jpeg.subarray(offset,offset+1024).toString('base64')});
    }
  });
  assert.equal((await runtime.execute('connect')).phase,'active');assert.deepEqual(bound,['existing-fixture']);
  const photo=async(id,agentId)=>(await ctx.tools.execute({agent:{id:agentId},calls:[{type:'tool-call',id,name:'stackchan_take_photo',arguments:'{}'}],signal:new AbortController().signal})).results[0].result;
  assert.equal((await photo('no-session',undefined)).isError,true);assert.equal(captures,0);
  const image=await photo('photo','existing-fixture');assert.equal(image.isError,false,JSON.stringify(image));assert.equal(captures,1);
  assert.equal(image.content[0].type,'image');
  const stored=await ctx.attachments.readImage(image.content[0].attachment);
  assert.equal((await sharp(stored.data).metadata()).width,640);assert.deepEqual(bound,['existing-fixture']);
  assert.equal((await pairing.call({action:'snapshot'})).error,'host_busy');
  const end=await runtime.execute('shutdown');assert.equal(end.phase,'stopped');assert.equal(end.deviceIdleConfirmed,true);
  assert.equal((await pairing.call({action:'snapshot'})).ok,true);assert.deepEqual(await readFile(path),before);
});

test('explicit Stop preempts a pending connect and its late rejection cannot overwrite successful stop status',async t=>{
  const pending=deferred();let entered=false;
  const f=fixture(t,{bridge:{async enter(){this.state='connecting';entered=true;await pending.promise;},async stop(){this.state='idle';pending.reject(new Error('cancelled'));return this.status();}}});
  await f.runtime.execute('start');f.connect();const connect=f.runtime.execute('connect');const rejected=assert.rejects(connect,{code:'voice_cancelled'});
  assert.ok(entered);const state=await f.runtime.execute('stop');await rejected;
  assert.equal(state.phase,'listening');assert.equal(f.runtime.snapshot().lastError,'');assert.equal(f.runtime.snapshot().deviceIdleConfirmed,true);
});

test('start rechecks environment before acquiring identity; stale readiness never authorizes startup',async t=>{
  let ready=true;const f=fixture(t,{environment:{async inspect(){return {filesVerified:ready};}}});
  assert.equal((await f.runtime.environment('inspect')).filesVerified,true);ready=false;
  await assert.rejects(f.runtime.execute('start'),{code:'voice_environment_required'});
  assert.deepEqual(f.events,[]);assert.equal(f.runtime.snapshot().phase,'stopped');
});
test('shutdown cancels an environment self-test, waits cleanup and excludes concurrent start',async t=>{
  const entered=deferred(),closed=deferred();
  const f=fixture(t,{environment:{async verify(signal){entered.resolve();await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));await closed.promise;throw new Error('private');}}});
  const pending=f.runtime.environment('verify');const rejected=assert.rejects(pending,{code:'voice_cancelled'});await entered.promise;
  await assert.rejects(f.runtime.execute('start'),{code:'voice_busy'});
  let done=false;const stop=f.runtime.execute('shutdown').then(()=>{done=true;});await delay(0);assert.equal(done,false);
  closed.resolve();await stop;await rejected;assert.equal(f.runtime.snapshot().phase,'stopped');
});
test('cancelling a preview keeps the runtime exclusive until cleanup and never acquires the device identity',async t=>{
  const entered=deferred(),closed=deferred(),abort=new AbortController();
  const request={language:'zh',voice:'zf_001',speechRate:1};
  let cancelled=false;
  const f=fixture(t,{environment:{async preview(value,signal){
    assert.deepEqual(value,request);
    entered.resolve();
    await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
    cancelled=true;
    await closed.promise;
    return {language:'zh',wav:'UklGRg=='};
  }}});
  t.after(()=>closed.resolve());
  f.change({sessionId:'',asrBackend:'unconfigured'});
  const preview=f.runtime.preview(request,abort.signal);
  const rejected=assert.rejects(preview,{code:'voice_cancelled'});
  await entered.promise;
  await assert.rejects(f.runtime.preview(request),{code:'voice_busy'});
  abort.abort();
  await assert.rejects(f.runtime.execute('start'),{code:'voice_busy'});
  assert.equal(cancelled,true);
  assert.deepEqual(f.events,[]);
  closed.resolve();
  await rejected;
  assert.equal(f.runtime.snapshot().phase,'stopped');
});

test('a new Start cannot enter between shutdown resource cleanup and its final state',async t=>{
  const f=fixture(t);const closing=f.runtime.execute('shutdown');
  await assert.rejects(f.runtime.execute('start'),{code:'voice_busy'});await closing;
  assert.equal((await f.runtime.execute('start')).phase,'listening');
});

test('managed environment supplies runtime paths after prepare, remains frozen until restart and is never auto-started',async t=>{
  let active=null,prepared=0,reads=0,disposed=0;const used=[];
  const setup={snapshot:()=>({stage:active?'ready':'idle',available:!!active,busy:false,error:''}),
    async active(){reads++;return active;},async prepare({replace}){prepared++;assert.equal(replace,false);active={...installation};},async dispose(){disposed++;}};
  const f=fixture(t,{installation:{},setup,voice:options=>{used.push(options);return {async dispose(){}};}});
  assert.equal(f.runtime.snapshot().installation.mode,'managed');assert.equal(reads,0);
  const ready=await f.runtime.execute('prepare-environment');
  assert.equal(ready.phase,'stopped');assert.equal(ready.installation.available,true);assert.deepEqual(f.events,[]);assert.equal(prepared,1);
  assert.doesNotMatch(JSON.stringify(ready),/private\/|whisperBinary|python/);
  await f.runtime.execute('start');assert.equal(reads,1);assert.equal(used[0].audio.python,installation.python);
  active={...installation,python:'/new/python'};
  await assert.rejects(f.runtime.execute('repair-environment'),{code:'voice_busy'});assert.equal(prepared,1);
  f.connect();await f.runtime.execute('connect');assert.equal(reads,1);assert.equal(used.length,1);
  await f.runtime.execute('shutdown');await f.runtime.execute('start');assert.equal(used[1].audio.python,'/new/python');
  await f.runtime.dispose();assert.equal(disposed,1);
});

test('installation cancellation waits actual cleanup, blocks competing actions and keeps progress readable',async t=>{
  const entered=deferred(),cleanup=deferred();let busy=false,finished=false;
  const setup={snapshot:()=>({stage:busy?'models':'idle',available:false,busy,error:''}),async active(){return null;},async dispose(){},
    async prepare({signal,replace}){assert.equal(replace,true);busy=true;entered.resolve();await new Promise(r=>signal.addEventListener('abort',r,{once:true}));await cleanup.promise;busy=false;finished=true;throw Object.assign(new Error('private'),{code:'voice_installation_cancelled'});}};
  const f=fixture(t,{installation:{},setup});const pending=f.runtime.execute('repair-environment');
  const rejected=assert.rejects(pending,{code:'voice_cancelled'});await entered.promise;
  assert.equal((await f.runtime.execute('snapshot')).installation.stage,'models');
  await assert.rejects(f.runtime.execute('start'),{code:'voice_busy'});
  await assert.rejects(f.runtime.environment('inspect'),{code:'voice_busy'});
  let closed=false;const closing=f.runtime.execute('shutdown').then(()=>{closed=true;});await delay(0);assert.equal(closed,false);
  await assert.rejects(f.runtime.execute('start'),{code:'voice_busy'});cleanup.resolve();await closing;await rejected;
  assert.equal(finished,true);assert.equal(f.runtime.snapshot().phase,'stopped');assert.deepEqual(f.events,[]);
});

test('partial custom Host configuration is never silently replaced by managed installation',async t=>{
  const setup={snapshot:()=>({stage:'idle',available:false,busy:false,error:''}),async active(){throw Error('unexpected');},async prepare(){throw Error('unexpected');},async dispose(){}};
  const f=fixture(t,{installation:{python:'/custom/python'},setup});
  assert.equal(f.runtime.snapshot().installation.mode,'custom');
  await assert.rejects(f.runtime.execute('prepare-environment'),{code:'voice_installation_custom'});
  await assert.rejects(f.runtime.execute('repair-environment'),{code:'voice_installation_custom'});
  await assert.rejects(f.runtime.execute('check-installation'),{code:'voice_installation_custom'});
  await assert.rejects(f.runtime.execute('start'),{code:'voice_unconfigured'});assert.deepEqual(f.events,[]);
});

test('prerequisite action stays stopped and shutdown waits for cancelled inventory',async t=>{
 const entered=deferred(),cleanup=deferred();let done=false;
 const setup={snapshot:()=>({stage:'checking',available:false,busy:!done,error:'',prerequisites:null}),async active(){assert.fail('no active read');},async dispose(){},
  async inspectPrerequisites(signal){entered.resolve();await new Promise(r=>signal.addEventListener('abort',r,{once:true}));await cleanup.promise;done=true;throw Object.assign(Error(),{code:'voice_installation_cancelled'});}};
 const f=fixture(t,{installation:{},setup});const pending=f.runtime.execute('check-installation'),rejected=assert.rejects(pending,{code:'voice_cancelled'});await entered.promise;
 assert.equal(f.runtime.snapshot().phase,'stopped');await assert.rejects(f.runtime.execute('prepare-environment'),{code:'voice_busy'});
 let closed=false;const closing=f.runtime.execute('shutdown').then(()=>{closed=true;});await delay(0);assert.equal(closed,false);
 cleanup.resolve();await closing;await rejected;assert.equal(done,true);assert.deepEqual(f.events,[]);
});

test('device tool uses only the active frozen DSH session and cannot run after Stop or saved-session change',async t=>{
 const f=fixture(t);await assert.rejects(f.runtime.expression({id:'existing'},'happy'),{code:'capability_inactive'});
 await f.runtime.execute('start');f.connect();await f.runtime.execute('connect');let calls=0;
 f.transport.connection.setExpression=async(expression)=>{calls++;return {version:1,expression,status:'applied'};};
 await assert.rejects(f.runtime.expression({},'happy'),{code:'capability_session_required'});
 assert.deepEqual(await f.runtime.expression({id:'existing'},'happy'),{version:1,expression:'happy',status:'applied'});
 f.change({sessionId:'other'});await assert.rejects(f.runtime.expression({id:'existing'},'happy'),{code:'voice_restart_required'});
 await f.runtime.execute('stop');await assert.rejects(f.runtime.expression({id:'existing'},'happy'),{code:'capability_inactive'});assert.equal(calls,1);
});

test('motion result requires the selected DSH session and the original device epoch',async t=>{
  const f=fixture(t);
  const agent={id:'existing'},target={yaw:200,pitch:450};
  await assert.rejects(f.runtime.moveHead(agent,target),{code:'capability_inactive'});
  await f.runtime.execute('start');f.connect();await f.runtime.execute('connect');
  let calls=0,epoch='1';const movement=deferred();
  f.transport.connection.snapshot=()=>({phase:'active',bootId:'boot',epoch});
  f.transport.connection.moveHead=async args=>{calls++;assert.deepEqual(args,target);return movement.promise;};
  await assert.rejects(f.runtime.moveHead({},target),{code:'capability_session_required'});
  const pending=assert.rejects(f.runtime.moveHead(agent,target),{code:'motion_session_changed'});
  epoch='3';movement.resolve({version:1,status:'reached',observed:target});await pending;
  f.change({sessionId:'other'});
  await assert.rejects(f.runtime.moveHead(agent,target),{code:'voice_restart_required'});
  assert.equal(calls,1);
});

test('ring requests and results stay with the selected DSH session and device epoch',async t=>{
  const f=fixture(t);
  const agent={id:'existing'},effect={color:'#FF2300',durationMs:250};
  await assert.rejects(f.runtime.setRing(agent,effect),{code:'capability_inactive'});
  await f.runtime.execute('start');
  f.connect();
  await f.runtime.execute('connect');
  const reply=deferred();
  let epoch='1',calls=0;
  f.transport.connection.snapshot=()=>({phase:'active',bootId:'boot',epoch});
  f.transport.connection.setRing=async target=>{calls++;assert.deepEqual(target,effect);return reply.promise;};
  await assert.rejects(f.runtime.setRing({},effect),{code:'capability_session_required'});
  const stale=assert.rejects(f.runtime.setRing(agent,effect),{code:'ring_session_changed'});
  epoch='3';
  reply.resolve({version:1,status:'completed'});
  await stale;
  assert.equal(calls,1);
});

test('selected session reads negotiated capabilities passively with no identifiers or stale permission',async t=>{
  const f=fixture(t);
  const agent={id:'existing'};
  const offline=f.runtime.deviceStatus(agent);
  assert.equal(offline.features.audio.availability,'unknown');
  assert.deepEqual(offline.conversation,{replyMode:'inactive',captionChannel:'unknown'});
  assert.deepEqual(f.events,[]);
  assert.throws(()=>f.runtime.deviceStatus({}),{code:'capability_session_required'});

  await f.runtime.execute('start');
  f.connect();
  await f.runtime.execute('connect');
  const connection=f.transport.connection;
  connection.negotiatedCapabilities=()=>({active:true,captionRequested:false,versions:{audio:1,playbackFence:1,camera:1,motion:1,ring:1},
    inFlight:{ring:true}});
  connection.ringSnapshot=()=>({capability:'available',status:'current',permission:'allowed',phase:'idle'});
  connection.cameraSnapshot=()=>({capability:'available',status:'current',permission:'allowed',phase:'idle'});
  connection.motionSnapshot=()=>({capability:'available',status:'stale',permission:'allowed',phase:'moving'});
  const live=f.runtime.deviceStatus(agent);
  assert.equal(live.features.audio.condition,'ready');
  assert.deepEqual(live.conversation,{replyMode:'spoken',captionChannel:'not-requested'});
  assert.equal(live.features.ring.condition,'busy');
  assert.equal(live.features.expression.availability,'unsupported');
  assert.equal(live.features.motion.permission,'unknown');
  assert.equal(live.features.motion.condition,'permission-unknown');
  assert.equal(live.features.camera.condition,'attachment-service-unavailable');
  assert.doesNotMatch(JSON.stringify(live),/existing|123456abcdef|SECRET|hidden/);

  f.change({sessionId:'other'});
  assert.throws(()=>f.runtime.deviceStatus({}),{code:'capability_session_required'});
  assert.equal(f.runtime.deviceStatus(agent).features.audio.condition,'restart-required');
  assert.deepEqual(f.events,['identity','listen','enter:existing']);
});


test('the report tracks negotiated captions and the frozen reply mode across preference changes and Stop',async t=>{
  const f=fixture(t);
  const agent={id:'existing'};
  f.change({captionOnly:true});
  await f.runtime.execute('start');
  f.connect();
  f.transport.connection.negotiatedCapabilities=()=>({
    active:f.bridge.state==='bridged',captionRequested:true,versions:{audio:1,playbackFence:1},
  });
  assert.deepEqual(f.runtime.deviceStatus(agent).conversation,{replyMode:'inactive',captionChannel:'requested'});
  await f.runtime.execute('connect');
  const active=f.runtime.deviceStatus(agent);
  assert.deepEqual(active.conversation,{replyMode:'caption-only',captionChannel:'requested'});
  assert.equal(active.features.audio.condition,'ready');
  assert.equal(active.features.playbackFence.condition,'not-available');
  f.change({captionOnly:false});
  assert.deepEqual(f.runtime.deviceStatus(agent).conversation,active.conversation);
  assert.equal(f.runtime.deviceStatus(agent).features.playbackFence.condition,'restart-required');
  await f.runtime.execute('stop');
  assert.deepEqual(f.runtime.deviceStatus(agent).conversation,{replyMode:'inactive',captionChannel:'requested'});
  await f.runtime.execute('shutdown');
  assert.deepEqual(f.runtime.deviceStatus(agent).conversation,{replyMode:'inactive',captionChannel:'unknown'});
});

test('paired endpoint bind errors give actionable fixed codes and release the held identity', async t => {
  for (const [transportCode, runtimeCode] of [
    ['lan-address-required', 'voice_lan_address_required'],
    ['listen-address-unavailable', 'voice_address_unavailable'],
    ['listen-port-in-use', 'voice_port_in_use'],
  ]) {
    const f = fixture(t, { transport: { async listen() {
      throw Object.assign(new Error('PRIVATE listener path'), { code: transportCode });
    } } });
    await assert.rejects(f.runtime.execute('start'), { code: runtimeCode, message: runtimeCode });
    assert.equal(f.runtime.snapshot().phase, 'stopped');
    assert.equal(f.runtime.snapshot().lastError, runtimeCode);
    assert.ok(f.events.includes('identity-release'));
  }
});

test('any DSH session can use the body; one holder per capability, busy names the holder',async t=>{
  const f=fixture(t);await f.runtime.execute('start');f.connect();await f.runtime.execute('connect');
  const target={yaw:100,pitch:400},effect={color:'#00FF00',durationMs:250};
  const movement=deferred();let moves=0;
  f.transport.connection.moveHead=async()=>{moves++;return movement.promise;};
  f.transport.connection.setRing=async()=>({version:1,status:'completed'});
  f.transport.connection.setExpression=async expression=>({version:1,expression,status:'applied'});
  assert.equal((await f.runtime.expression({id:'telegram'},'happy')).status,'applied');
  const first=f.runtime.moveHead({id:'telegram'},target);
  await assert.rejects(f.runtime.moveHead({id:'desktop'},target),e=>e.code==='motion-busy'&&e.owner==='telegram');
  assert.equal((await f.runtime.setRing({id:'desktop'},effect)).status,'completed');
  movement.resolve({version:1,status:'reached',observed:target});await first;
  const second=deferred();f.transport.connection.moveHead=async()=>{moves++;return second.promise;};
  const next=f.runtime.moveHead({id:'desktop'},target);second.resolve({version:1,status:'reached',observed:target});
  assert.equal((await next).status,'reached');assert.equal(moves,2);
  assert.ok(f.runtime.deviceStatus({id:'telegram'}).features);
});
