// Actual C++ AgentSession/AudioEngine through a local TLS carrier. The codec and
// network driver are test seams; this is not ESP TLS or acoustic acceptance.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { createAgentTransport, DISPLAY_WINDOW, frameTag } from '../src/agent-transport.mjs';
import { createPairing } from '../src/pairing.mjs';
import {Context} from '@deepseek-ai/cordis';
import Tools from '@deepseek-ai/dsh-tools';
import * as Native from '@deepseek-ai/dsh-tool-executor-native';
import {registerCapabilityTools} from '../src/capability-tools.mjs';
import {describeDeviceCapabilities} from '../src/device-capabilities.mjs';
import {createLocalVoice} from '../src/local-voice.mjs';
import {VoiceBridge} from '../src/bridge.mjs';
const root = await mkdtemp(join(tmpdir(), 'sion-cpp-wss-'));
let transport, ws, peer, clock, lines,toolsContext,voice,readAbort,reading;
const cameraPhases=new Set();
async function waitFor(check, message) {
  const deadline = performance.now() + 3000;
  while (!check() && performance.now() < deadline) await delay(10);
  assert.ok(check(), message);
}
try {
  createPairing(join(root, 'pair'), 'wss://192.168.1.2:9080/audio');
  const pairing = JSON.parse(await readFile(join(root, 'pair/pairing.json'), 'utf8'));
  // The C++ fixture's public pair ID is fixed; the TLS secret is still unique.
  pairing.record.pair_id = 'a'.repeat(32);
  transport = createAgentTransport({ pairing, deviceId: '123456abcdef' });
  const { port } = await transport.listen({ host: '127.0.0.1', port: 0 });
  const connected = once(transport.events, 'connection');
  ws = new WebSocket(`wss://127.0.0.1:${port}/audio`, 'sion-agent-v1', {
    ca: pairing.record.ca, servername: 'sion-host', rejectUnauthorized: true,
    headers: { Authorization: `Bearer ${pairing.record.local_token}`, 'X-Sion-Pair-Id': pairing.record.pair_id,
      'X-Sion-Device-Id': '123456abcdef' },
  });
  ws.on('error', () => {}); await once(ws, 'open');
  peer = spawn(process.argv[2], ['--stdio', '--sensors'], { stdio: ['pipe', 'pipe', 'inherit'] });
  peer.on('error', () => {}); peer.stdin.on('error', () => {});
  lines = createInterface({ input: peer.stdout });
  let deviceAtHome = false;
  let screenReport=null;
  lines.on('line', line => {
    if (line === 'H') { deviceAtHome = true; return; }
    if (line.startsWith('V ')) { screenReport=line.slice(2); return; }
    if (ws.readyState !== WebSocket.OPEN) return;
    if (line.startsWith('T ')) {
      const message=JSON.parse(line.slice(2));if(message.type==='camera_state')cameraPhases.add(message.phase);
      ws.send(line.slice(2));
    }
    else if (line.startsWith('B ')) ws.send(Buffer.from(line.slice(2), 'hex'));
    else if (line === 'C') ws.close();
    else throw new Error('Unexpected fixture output');
  });
  ws.on('message', (bytes, binary) => peer.stdin.write(`${binary ? 'B '+bytes.toString('hex') : 'T '+bytes.toString()}\n`));
  let tick = 0; clock = setInterval(() => peer.stdin.write(`P ${tick += 10}\n`), 10);
  const [connection] = await connected;
  assert.deepEqual(connection.batterySnapshot(),{version:1,status:'waiting'});
  assert.deepEqual(connection.ambientSnapshot(),{version:1,status:'waiting'});
  assert.deepEqual(connection.headTouchSnapshot(),{version:2,status:'waiting'});
  assert.deepEqual(connection.imuSnapshot(),{version:1,status:'waiting'});
  assert.equal((await connection.start()).epoch, '1');
  const captured = await connection.readInput();
  assert.equal(captured.pcm.readInt16LE(0), -32768); assert.equal(captured.pcm.readInt16LE(2), 32767);
  const pcm = Buffer.alloc(480); pcm.writeInt16LE(-32768); pcm.writeInt16LE(32767, 2);
  const acknowledged = await connection.sendOutput(pcm); assert.equal(acknowledged.accepted, true);
  // Two full windows exercise driver-paced credits while capture keeps flowing.
  readAbort = new AbortController(); let inputs = 0;
  reading = (async () => {
    try { while (true) { await connection.readInput({ signal: readAbort.signal }); ++inputs; } }
    catch (error) { if (!readAbort.signal.aborted) throw error; }
  })();
  // Preserve the primary test failure if cleanup happens during an input read.
  void reading.catch(() => {});
  toolsContext=new Context();toolsContext.provide('systemPrompt',{tools(){return()=>{};}});
  await toolsContext.plugin(Tools);await toolsContext.plugin(Native);
  await toolsContext.plugin({name:'capability-carrier',inject:['tools'],apply(ctx){registerCapabilityTools(ctx,{
    expression:(_agent,value,signal)=>connection.setExpression(value,{signal}),
    moveHead:(_agent,target,signal)=>connection.moveHead(target,{signal}),
    setRing:(_agent,target,signal)=>connection.setRing(target,{signal}),
    deviceStatus:()=>describeDeviceCapabilities(connection.negotiatedCapabilities(),{
      phase:connection.snapshot().phase==='active'?'active':'listening',
      battery:connection.batterySnapshot(),
      ambient:connection.ambientSnapshot(),
      headTouch:connection.headTouchSnapshot(),
      imu:connection.imuSnapshot(),
    }),
  });}});
  const readStatus=async()=> (await toolsContext.tools.execute({
    calls:[{type:'tool-call',id:'battery-status',name:'stackchan_device_status',arguments:'{}'}],
    signal:new AbortController().signal,
  })).results[0].result;
  await waitFor(()=>connection.batterySnapshot().status==='current','C++ battery reading reached the Mac');
  const status=await readStatus();
  assert.equal(status.isError,false);
  assert.deepEqual(status.value.battery,{version:1,status:'current',percent:61,direction:'discharging'});
  assert.ok(status.value.notExposed.includes('clock')&&!status.value.notExposed.includes('batteryAndClock'));
  await waitFor(()=>connection.ambientSnapshot().status==='current','C++ light and proximity reached the Mac');
  await waitFor(()=>connection.headTouchSnapshot().status==='current','C++ three-channel head touch reached the Mac');
  await waitFor(()=>connection.imuSnapshot().status==='current','C++ IMU samples reached the Mac');
  const environment=await readStatus();
  assert.equal(environment.isError,false,JSON.stringify(environment));
  assert.deepEqual(environment.value.ambient,{version:1,status:'current',light:{channel0:0,channel1:1234},proximityRaw:2047});
  assert.ok(!environment.value.notExposed.includes('ambientSensors'));
  assert.deepEqual(environment.value.headTouch,{version:2,status:'current',levels:[0,1,3],recentGestures:[]});
  assert.ok(environment.value.notExposed.includes('buttons')&&!environment.value.notExposed.includes('infrared'));
  assert.ok(!environment.value.notExposed.includes('nfc')&&environment.value.body.parts.nfc.chip==='ST25R3916');
  assert.equal(environment.value.body.parts.head.joints.head_yaw.continuousRotation,true);
  assert.deepEqual(environment.value.imu,{version:1,status:'current',accelerationMg:[1000,-1000,0],angularVelocityMdps:[500000,-500000,1999939]});
  assert.ok(environment.value.notExposed.includes('magnetometer'));
  peer.stdin.write('G\n');
  await waitFor(()=>connection.headTouchSnapshot().recentGestures.length===2,'C++ completed gestures reached the Mac');
  const gestures=(await readStatus()).value.headTouch.recentGestures;
  assert.deepEqual(gestures.map(({ageMs,...event})=>event),[
    {sequence:1,kind:'tap',durationMs:100,peak:2},
    {sequence:2,kind:'toward_channel_3',durationMs:200,peak:3},
  ]);
  for(const expression of ['neutral','happy','angry','sad','doubt','sleepy']){
    const batch=await toolsContext.tools.execute({calls:[{type:'tool-call',id:'expression-'+expression,name:'stackchan_set_expression',arguments:JSON.stringify({expression})}],signal:new AbortController().signal});
    assert.equal(batch.results[0].result.isError,false);
    assert.deepEqual(batch.results[0].result.value,{version:1,expression,status:'applied'});
  }
  const move=await toolsContext.tools.execute({calls:[{type:'tool-call',id:'head-move',name:'stackchan_move_head',
    arguments:JSON.stringify({yaw:-200,pitch:450})}],signal:new AbortController().signal});
  assert.equal(move.results[0].result.isError,false);
  assert.deepEqual(move.results[0].result.value,{version:1,status:'reached',observed:{yaw:-200,pitch:450}});
  assert.equal(connection.motionSnapshot().permission,'allowed');
  assert.equal(connection.motionSnapshot(performance.now()+7000).permission,'unknown');
  await assert.rejects(connection.moveHead({yaw:0,pitch:651}),{code:'motion-invalid'});
  const moveAbort=new AbortController();
  const cancelled=assert.rejects(connection.moveHead({yaw:100,pitch:650},{signal:moveAbort.signal}),{code:'motion-cancelled'});
  await assert.rejects(connection.moveHead({yaw:0,pitch:450}),{code:'motion-busy'});
  moveAbort.abort();await cancelled;
  assert.equal(connection.snapshot().phase,'active');
  assert.equal((await connection.moveHead({yaw:200,pitch:600})).observed.pitch,600);
  // Per-LED frames: the C++ ring engine shows them in order and reports completion.
  const leds=Array.from({length:12},(_,i)=>i%2?'#FF0000':'#0000ff');
  assert.deepEqual(await connection.setRingFrames({frames:[{leds,durationMs:40},{leds:leds.slice().reverse(),durationMs:40}],brightness:128}),
    {version:1,status:'completed'});
  await assert.rejects(connection.setRingFrames({frames:[{leds:leds.slice(1),durationMs:40}]}),{code:'ring-invalid'});
  await assert.rejects(connection.setRingFrames({frames:[{leds,durationMs:6000},{leds,durationMs:6000}]}),{code:'ring-invalid'});
  // Sensor recording: the device speeds up its raw reports for the window, then returns to the defaults.
  const recorded=await connection.recordSensors({sensors:['imu','headTouch','ambient','power'],intervalMs:20,durationMs:600});
  assert.deepEqual(recorded.intervalMs,{imu:20,headTouch:50,ambient:750,power:100});
  const power=recorded.samples.filter(s=>s.sensor==='power');
  assert.ok(power.length>=3);assert.deepEqual(power[0].value,{busMv:4000,currentMa:-4,raw:{bus:3200,shunt:-16}});
  const imuSamples=recorded.samples.filter(s=>s.sensor==='imu');
  assert.ok(imuSamples.length>=10,`imu samples ${imuSamples.length}`);
  assert.deepEqual(imuSamples[0].value.raw,[16384,-16384,-1,8192,-8192,32767]);
  assert.equal(imuSamples[0].value.accelerationMg[0],1000);
  assert.ok(recorded.samples.filter(s=>s.sensor==='headTouch').length>=4);
  assert.ok(recorded.samples.every((s,i,a)=>i===0||s.t>=a[i-1].t));
  await assert.rejects(connection.recordSensors({sensors:['imu'],intervalMs:20,durationMs:30001}),{code:'recording-invalid'});
  await assert.rejects(connection.recordSensors({sensors:['camera'],intervalMs:20,durationMs:500}),{code:'recording-invalid'});
  await assert.rejects(connection.setReportRate('imu',19),{code:'recording-invalid'});
  // Real-time setpoints: rejected before a hold, followed while one runs.
  connection.sendSetpoint({yaw:10,pitch:450});
  await waitFor(()=>connection.setpointRejections===1&&connection.lastSetpointRejection==='not-holding','setpoint rejected without a hold');
  const streamed=await connection.streamSetpoints({points:[{atMs:0,yaw:0,pitch:400},{atMs:50,yaw:100,pitch:400},{atMs:100,yaw:200,pitch:420}]});
  assert.equal(streamed.sent,3);assert.equal(streamed.rejected,0);
  assert.equal((await connection.readServos()).yaw.angle,200);   // The fake servo is where the last target put it.
  await connection.setTorque({torque:'release'});
  assert.deepEqual(await connection.setVolume(65),{version:1,volume:65});
  // Screen: text, then a 4x2 picture in chunks, then clear.
  assert.deepEqual(await connection.showText({text:'你好 Sion',area:'top',durationMs:3000}),{version:1,status:'shown'});
  const picture=Buffer.alloc(4*2*2,0);picture.writeUInt16LE(0xf800,0);picture.writeUInt16LE(0x001f,14);
  assert.deepEqual(await connection.showImage({width:4,height:2,x:10,y:20,rgb565:picture,durationMs:3000}),{version:1,status:'shown',width:4,height:2});
  peer.stdin.write('V\n');await waitFor(()=>screenReport!==null,'screen report');
  assert.equal(screenReport,`你好 Sion 4x2 1 ${0xf8+0x00+0x1f}`);
  screenReport=null;
  assert.deepEqual(await connection.clearDisplay(),{version:1,status:'cleared'});
  peer.stdin.write('V\n');await waitFor(()=>screenReport!==null,'screen report after clear');
  assert.equal(screenReport,'- 4x2 0 '+(0xf8+0x1f));
  // A whole screen is 172 chunks: the device acknowledges each, and no more than DISPLAY_WINDOW are ever in flight.
  assert.equal(connection.negotiatedCapabilities().versions.display,2);
  const screen=Buffer.alloc(320*240*2,0x5a);
  assert.deepEqual(await connection.showImage({width:320,height:240,rgb565:screen,durationMs:3000}),{version:1,status:'shown',width:320,height:240});
  assert.ok(connection.displayMaxUnacked>=1&&connection.displayMaxUnacked<=DISPLAY_WINDOW,`in flight ${connection.displayMaxUnacked}`);
  assert.deepEqual(await connection.clearDisplay(),{version:1,status:'cleared'});
  // Frame bank: store by slot (screen unchanged), list, show by number, a frame timeline, drop.
  assert.equal(connection.negotiatedCapabilities().versions.frames,2);
  const small=Buffer.alloc(3*2*2,0);small.writeUInt16LE(0x07e0,0);
  const stored=await connection.storeFrame({slot:2,width:3,height:2,x:5,y:6,rgb565:small});
  assert.equal(stored.status,'stored');assert.equal(stored.tag,frameTag({width:3,height:2,x:5,y:6,rgb565:small}));
  screenReport=null; peer.stdin.write('V\n');await waitFor(()=>screenReport!==null,'screen report after store');
  assert.match(screenReport,/^- \d+x\d+ 0 /);screenReport=null;
  assert.deepEqual(await connection.listFrames(),{version:1,used:12,budget:4194304,frames:[{slot:2,width:3,height:2,x:5,y:6,tag:stored.tag}]});
  const shownFrame=await connection.showFrame({slot:2,durationMs:3000});
  assert.equal(shownFrame.status,'shown');assert.ok(shownFrame.roundTripMs>=0);
  screenReport=null; peer.stdin.write('V\n');await waitFor(()=>screenReport!==null,'screen report after frame');
  assert.equal(screenReport,`- 3x2 1 ${0x07+0xe0}`);screenReport=null;
  await assert.rejects(connection.showFrame({slot:9}),{code:'display-no-frame'});
  assert.equal((await connection.storeFrame({slot:0,width:320,height:240,rgb565:screen})).status,'stored');
  console.error('before timeline');const timeline=await connection.streamSetpoints({points:[{atMs:0,frame:0},{atMs:30,frame:2},{atMs:60,frame:0}]});
  assert.equal(timeline.sent,0);assert.equal(timeline.holdingMs,0);
  // Slot 0 is a full screen and keeps the screen busy for its push time (FRAME_PUSH_MS_FULL with frames 2);
  // a frame due meanwhile waits, and one due behind it would replace it (latest wins). None is lost or fails.
  assert.equal(timeline.frames.failed,0);assert.ok(timeline.frames.shown>=2);
  assert.equal(timeline.frames.shown+timeline.frames.skipped,3);assert.equal(timeline.frames.sent,timeline.frames.shown);
  assert.deepEqual(await connection.dropFrame({slot:'all'}),{version:1,status:'dropped',slot:'all'});
  assert.deepEqual((await connection.listFrames()).frames,[]);
  screenReport=null; peer.stdin.write('V\n');await waitFor(()=>screenReport!==null,'screen report after drop');
  assert.match(screenReport,/^- 320x240 0 /);screenReport=null;
  await assert.rejects(connection.storeFrame({slot:48,width:1,height:1,rgb565:Buffer.alloc(2)}),{code:'display-invalid'});
  await assert.rejects(connection.showImage({width:321,height:1,rgb565:Buffer.alloc(642)}),{code:'display-invalid'});
  await assert.rejects(connection.showText({text:''}),{code:'display-invalid'});
  assert.deepEqual(await connection.sendInfrared({address:0x04,command:0x08,repeats:2}),{version:1,status:'sent'});
  await assert.rejects(connection.sendInfrared({address:0x10000,command:1}),{code:'ir-invalid'});
  const hearing=connection.recordSensors({sensors:['infrared'],intervalMs:20,durationMs:400});
  setTimeout(()=>peer.stdin.write('I 4 8\n'),100);
  assert.deepEqual((await hearing).samples.map(s=>[s.value.address,s.value.command,s.value.repeat]),[[4,8,false]]);
  // NFC: a card arriving and leaving the reader, as events.
  assert.equal(connection.negotiatedCapabilities().versions.nfc,1);
  const nfcRecording=connection.recordSensors({sensors:['nfc'],intervalMs:20,durationMs:400});
  setTimeout(()=>{peer.stdin.write('N 1 04112233445566 68 0\n');peer.stdin.write('N 0 04112233445566 68 0\n');},100);
  assert.deepEqual((await nfcRecording).samples.map(s=>{const {ageMs,...rest}=s.value;assert.ok(ageMs>=0);return rest;}),[
    {phase:'present',technology:'iso14443a',uid:'04112233445566',atqa:68,sak:0,getVersion:null},
    {phase:'removed',technology:'iso14443a',uid:'04112233445566',atqa:68,sak:0,getVersion:null}]);
  // Type 2 page read through the C++ session (the fake card's bytes are (index*7) & 255).
  // Every answer carries the reader's poll stage counts, also when no card answered.
  const pollStats={polls:9,fieldFailed:0,silent:3,partial:1,anticollisionFailed:0,selectFailed:0,selected:5,versionFailed:0,
    readFailed:0,collisions:0,errorIrq:4096};
  await assert.rejects(connection.readNfc({page:4,count:2}),{code:'nfc-no-card',pollStats});
  peer.stdin.write('N 1 04112233445566 68 0 0004040201001103\n');
  assert.deepEqual(await connection.readNfc({page:4,count:2}),{version:1,
    card:{uid:'04112233445566',atqa:68,sak:0,getVersion:'0004040201001103'},page:4,count:2,dataHex:'70777e858c939aa1',pollStats});
  await assert.rejects(connection.readNfc({page:250,count:7}),{code:'nfc-invalid'});
  peer.stdin.write('N 1 deadbeef 4 8\n');
  await assert.rejects(connection.readNfc({page:4,count:1}),{code:'nfc-not-type2'});
  await assert.rejects(connection.setVolume(101),{code:'volume-invalid'});
  // Screen touches arrive as events while recording.
  const touching=connection.recordSensors({sensors:['screenTouch'],intervalMs:20,durationMs:600});
  setTimeout(()=>{peer.stdin.write('S 1 100 50\n');peer.stdin.write('S 1 140 60\n');peer.stdin.write('S 0 0 0\n');},150);
  const touches=(await touching).samples.map(s=>s.value);
  assert.deepEqual(touches.map(t=>[t.phase,t.x,t.y]),[['down',100,50],['move',140,60],['up',140,60]]);
  // Motion v2: keyframes with a hold, a read while held, limp, release, and a read from idle.
  assert.equal(connection.negotiatedCapabilities().versions.motion,2);
  const framed=await connection.moveFrames({frames:[{yaw:200,pitch:450,durationMs:300},{yaw:0,pitch:300,durationMs:300}],holdMs:3000});
  assert.deepEqual(framed,{version:1,status:'reached',holding:true,observed:{yaw:0,pitch:300}});
  const held=await connection.readServos();
  assert.equal(held.status,'read');assert.equal(held.holding,true);assert.equal(held.pitch.angle,300);
  assert.equal(held.pitch.temperature,33);assert.equal(held.yaw.load,-120);
  assert.deepEqual(await connection.setTorque({torque:'limp',holdMs:2000}),{version:1,status:'reached',holding:true,observed:{yaw:0,pitch:300}});
  assert.equal((await connection.readServos()).yaw.torque,false);
  assert.equal((await connection.setTorque({torque:'release'})).holding,false);
  assert.equal((await connection.readServos()).holding,false);
  await assert.rejects(connection.moveFrames({frames:[{yaw:0,pitch:651}]}),{code:'motion-invalid'});
  await assert.rejects(connection.moveFrames({frames:new Array(9).fill({yaw:0,pitch:450})}),{code:'motion-invalid'});
  await assert.rejects(connection.setTorque({torque:'release',holdMs:10}),{code:'motion-invalid'});
  await assert.rejects(connection.setTorque({torque:'hold'}),{code:'motion-invalid'});
  assert.deepEqual(await connection.rotateYaw({velocity:-300,durationMs:300}),{version:1,status:'reached',holding:false});
  assert.equal((await connection.rotateYaw({velocity:300,durationMs:200,holdMs:1000,torque:'limp'})).holding,true);
  await connection.setTorque({torque:'release'});
  for(const bad of [{velocity:0,durationMs:300},{velocity:1001,durationMs:300},{velocity:100,durationMs:20001},{velocity:100,durationMs:300,torque:'stiff'}])
    await assert.rejects(connection.rotateYaw(bad),{code:'motion-invalid'});
  const ring=await toolsContext.tools.execute({calls:[{type:'tool-call',id:'ring-effect',name:'stackchan_light_ring',
    arguments:JSON.stringify({color:'#FF2300',durationMs:250})}],signal:new AbortController().signal});
  assert.equal(ring.results[0].result.isError,false);
  assert.deepEqual(ring.results[0].result.value,{version:1,status:'completed'});
  assert.equal(connection.ringSnapshot().permission,'allowed');
  for(const size of [4,5,6,7,2501,262144]){
    peer.stdin.write(`L ${size}\n`);
    const photo=await connection.captureCamera();
    const expected=Buffer.alloc(size);for(let i=0;i<size;++i)expected[i]=i;
    expected[0]=255;expected[1]=216;expected[size-2]=255;expected[size-1]=217;
    assert.deepEqual(photo,{mediaType:'image/jpeg',width:640,height:480,jpeg:expected});
  }
  for (let window = 0; window < 2; ++window)
    await Promise.all(Array.from({ length: 20 }, () => connection.sendOutput(pcm)));
  assert.deepEqual(await connection.drainOutput(), { playbackIdle: true, discarded: false, nextSequence: '41' });
  const discarded = Array.from({length:20}, () => connection.sendOutput(pcm).catch(error => error.code));
  assert.deepEqual(await connection.interruptOutput(), { playbackIdle: true, discarded: true, nextSequence: '61' });
  assert.ok((await Promise.all(discarded)).every(value => value === 'playback-interrupted'));
  assert.equal((await connection.sendOutput(pcm)).accepted, true);
  assert.equal((await connection.drainOutput()).nextSequence, '62');
  readAbort.abort(); await reading; assert.ok(inputs >= 40);
  const fenced=assert.rejects(connection.moveHead({yaw:0,pitch:450}),{code:'stopped'});
  const fencedRing=assert.rejects(connection.setRing({color:'#FF2300'}),{code:'stopped'});
  assert.deepEqual(await connection.stop(), { deviceIdle: true, bootId: 'b'.repeat(32), epoch: '2' });
  const stoppedStatus=(await readStatus()).value;
  assert.deepEqual(stoppedStatus.battery,{version:1,status:'waiting'});
  assert.deepEqual(stoppedStatus.ambient,{version:1,status:'waiting'});
  assert.deepEqual(stoppedStatus.headTouch,{version:2,status:'waiting'});
  assert.deepEqual(stoppedStatus.imu,{version:1,status:'waiting'});
  await Promise.all([fenced,fencedRing]);
  assert.equal((await connection.start()).epoch, '3');
  assert.equal((await connection.readInput()).epoch, 3n);
  assert.equal((await connection.stop()).epoch, '4');
  for(let i=0;i<100&&connection.cameraSnapshot().status!=='current';++i)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(connection.cameraSnapshot().permission,'allowed');assert.equal(connection.cameraSnapshot().phase,'idle');
  assert.ok(cameraPhases.has('capturing')&&cameraPhases.has('transferring')&&cameraPhases.has('idle'));
  console.log('Real TLS → C++ camera pull, native expression, motion, ring and sensor reports, resource Stop, PCM and drain passed. Sensor, JPEG, codec and renderer inputs use fixtures.');

  let nextTranscript = '', capturedFrames = 0, warmups = 0, abortedWarmups = 0, disposedSynthesizers = 0;
  voice = createLocalVoice({ getConnection: () => connection, factories: {
    audio: () => ({
      async start() {},
      async process(pcm) {
        ++capturedFrames;
        return { segment: { pcm: pcm.subarray(0, 2), sampleRate: 16000, reason: 'silence', continuation: false } };
      },
      async dispose() {},
    }),
    recognition: () => ({
      async warmup() {},
      async transcribe() { const text = nextTranscript; nextTranscript = ''; return { text }; },
      async dispose() {},
    }),
    synthesis: () => ({
      async warmup({ signal }) {
        ++warmups;
        await new Promise((_, reject) => {
          const abort = () => { ++abortedWarmups; reject(signal.reason); };
          if (signal.aborted) abort();
          else signal.addEventListener('abort', abort, { once: true });
        });
      },
      async *synthesize() { assert.fail('pending warmup must not produce PCM'); },
      async dispose() { ++disposedSynthesizers; },
    }),
  } });
  const bridge = new VoiceBridge({ voice, exitTarget: 'device-idle', dsh: {
    async bind(id) {
      assert.equal(id, 'warmup-fixture');
      return { async ask() { assert.fail('Stop must not reach the DSH session'); } };
    },
  } });
  assert.equal((await bridge.enter('warmup-fixture')).state, 'bridged');
  assert.equal(connection.snapshot().phase, 'active');
  await waitFor(() => capturedFrames > 0, 'Device AudioEngine must produce frames while TTS is starting');
  assert.deepEqual([warmups, abortedWarmups], [1, 0]);
  nextTranscript = '停止';
  await waitFor(() => bridge.status().state === 'idle', 'Mac Stop must wait for the real C++ stopped receipt');
  assert.deepEqual([abortedWarmups, disposedSynthesizers], [1, 1]);
  assert.equal(connection.snapshot().phase, 'idle');
  assert.equal(String(connection.snapshot().epoch), '6');
  assert.equal(bridge.status().lastError, null);

  const beforeHome = capturedFrames;
  assert.equal((await bridge.enter('warmup-fixture')).state, 'bridged');
  await waitFor(() => capturedFrames > beforeHome, 'Second session must capture during its own TTS warmup');
  assert.deepEqual([warmups, abortedWarmups], [2, 1]);
  peer.stdin.write('H\n');
  await waitFor(() => deviceAtHome && bridge.status().state === 'recovering' && voice.canReconnect(),
    'Device Home and Mac cancellation must each finish; a closed link has no stopped receipt');
  assert.equal(connection.snapshot().phase, 'closed');
  assert.deepEqual([abortedWarmups, disposedSynthesizers], [2, 2]);
  console.log('Real TLS and C++ AgentSession: capture continued during TTS warmup; voice Stop reached idle and device-local Home closed both sides without a forged stopped receipt.');
  clearInterval(clock);
  await verifyHostCrash(pairing,process.argv[2]);
} finally {
  readAbort?.abort();
  await reading?.catch(() => {});
  clearInterval(clock); ws?.terminate(); await transport?.close(); lines?.close();
  await voice?.dispose().catch(() => {});
  await toolsContext?.fiber.dispose();
  if (peer && peer.exitCode === null && peer.signalCode === null) {
    const exited = once(peer, 'exit'); peer.stdin.end();
    const kill = setTimeout(() => peer.kill('SIGKILL'), 1000);
    try { const [code] = await exited; assert.equal(code, 0); } finally { clearTimeout(kill); }
  }
  if (peer) assert.equal(peer.exitCode, 0);
  await rm(root, { recursive: true, force: true });
}

async function verifyHostCrash(pairing, executable) {
  const deviceId = '123456abcdef';
  // This subprocess uses the real Mac-side WSS transport. The test supervisor
  // owns the device clock and can withhold its carrier-close notification.
  const hostCode = `
    import { once } from 'node:events';
    import assert from 'node:assert/strict';
    const {createAgentTransport}=await import(process.argv[1]);
    const [pairing]=await once(process,'message');
    const transport=createAgentTransport({pairing,deviceId:'123456abcdef'});
    const ready=once(transport.events,'connection');
    process.send({port:(await transport.listen({host:'127.0.0.1',port:0})).port});
    try {
      const [connection]=await ready;
      assert.equal(connection.batterySnapshot(),undefined);
      assert.equal(connection.ambientSnapshot(),undefined);
      process.send({idle:connection.snapshot().epoch});
      const [start]=await once(process,'message');
      assert.equal(start,'start');
      process.send({active:(await connection.start()).epoch});
      const [command]=await once(process,'message');
      if(command==='queue') {
        const pcm=Buffer.alloc(480); pcm.writeInt16LE(-32768); pcm.writeInt16LE(32767,2);
        void connection.sendOutput(pcm).catch(()=>{});
        await once(process,'message'); // The supervisor SIGKILLs this process.
      } else {
        assert.equal(command,'stop');
        process.send({stopped:(await connection.stop()).epoch});
      }
    } finally {
      await transport.close();
      process.disconnect();
    }`;
  const processes = [];
  const sockets = [];
  let deviceSocket;
  const device = spawn(executable,['--stdio'],{stdio:['pipe','pipe','inherit']});
  const deviceExit = once(device,'exit');
  const deviceLines = createInterface({input:device.stdout});
  const status = [];
  const commands = [];
  let capture = 0, pendingOutput = 0, deviceCloses = 0;
  const send = line => device.stdin.write(line+'\n');
  let initialHello;
  device.stdin.on('error',()=>{});
  deviceLines.on('line', line=>{
    if (line.startsWith('Q ')) {
      const [phase,epoch,attached,input,output,opens,closes,writes]=line.slice(2).split(' ');
      status.push({phase,epoch:Number(epoch),attached:attached==='1',input:Number(input),
        output:Number(output),opens:Number(opens),closes:Number(closes),writes:Number(writes)});
      return;
    }
    if (line==='C') { ++deviceCloses; deviceSocket?.close(); return; }
    if (line.startsWith('T ')) {
      // The fixture emits its first hello before the Mac listener is ready.
      // Later hello messages are forwarded to the new socket normally.
      const message=line.slice(2);
      if (initialHello===undefined&&JSON.parse(message).type==='hello') initialHello=message;
      else if(deviceSocket?.readyState===WebSocket.OPEN)deviceSocket.send(message);
      return;
    }
    if (line.startsWith('B ')) {
      ++capture;
      if(deviceSocket?.readyState===WebSocket.OPEN)deviceSocket.send(Buffer.from(line.slice(2),'hex'));
      return;
    }
    assert.fail('unexpected output from the device crash fixture');
  });
  async function launchHost() {
    const child = spawn(process.execPath, ['--input-type=module','-e',hostCode,new URL('../src/agent-transport.mjs',import.meta.url).href],
      {stdio:['ignore','ignore','inherit','ipc']});
    const exit = once(child,'exit');
    processes.push({child,exit});
    const messages = [];
    child.on('message',message=>messages.push(message));
    child.send(pairing);
    await waitFor(()=>messages.some(message=>message.port),'Mac host bound a private loopback listener');
    deviceSocket = new WebSocket(`wss://127.0.0.1:${messages[0].port}/audio`,'sion-agent-v1',{
      ca:pairing.record.ca,servername:'sion-host',rejectUnauthorized:true,
      headers:{Authorization:`Bearer ${pairing.record.local_token}`,'X-Sion-Pair-Id':pairing.record.pair_id,'X-Sion-Device-Id':deviceId},
    });
    sockets.push(deviceSocket);
    deviceSocket.on('error',()=>{});
    await once(deviceSocket,'open', {signal:AbortSignal.timeout(3000)});
    deviceSocket.on('message',(bytes,binary)=>{
      if(binary){++pendingOutput;send('B '+bytes.toString('hex'));}
      else {commands.push(JSON.parse(bytes).type);send('T '+bytes);}
    });
    return {child,exit,messages,socket:deviceSocket};
  }
  async function expectDevice(expected) {
    const previous=status.length;
    send('Q');
    await waitFor(()=>status.length>previous,'device state checkpoint');
    assert.deepEqual(status.at(-1),expected);
  }
  try {
    const original=await launchHost();
    await waitFor(()=>!!initialHello,'initial device hello retained');
    original.socket.send(initialHello);
    await waitFor(()=>original.messages.some(message=>message.idle==='0'),'host authenticated the idle device');
    original.child.send('start');
    await waitFor(()=>commands.includes('start'),'first start reached the device');
    // P pumps the audio worker before the session; E drives only the session clock.
    send('P 1');
    await waitFor(()=>original.messages.some(message=>message.active==='1'),'first device lease opened');
    send('P 12');
    await waitFor(()=>capture>0,'audio engine captured before the host exit');
    original.child.send('queue');
    await waitFor(()=>pendingOutput===1,'one host audio frame queued before the crash');
    const beforeCrash={phase:'active',epoch:1,attached:true,input:0,output:1,opens:1,closes:0,writes:0};
    await expectDevice(beforeCrash);

    const closed=once(original.socket,'close',{signal:AbortSignal.timeout(3000)});
    assert.equal(original.child.kill('SIGKILL'),true);
    assert.deepEqual(await original.exit,[null,'SIGKILL']);
    await closed;

    // No Closed event enters the C++ session. Only its own clock reaches expiry.
    send('E 14999');
    await expectDevice(beforeCrash);
    send('E 15000');
    const draining={...beforeCrash,phase:'draining',epoch:2,attached:false,output:0};
    await expectDevice(draining);
    assert.equal(deviceCloses,1);
    send('A');
    await expectDevice(draining);
    const captureBefore=capture;
    send('P 15001');
    const idle={...draining,phase:'idle',closes:1};
    await expectDevice(idle);
    assert.equal(capture,captureBefore);
    assert.deepEqual(commands,['start']);

    const replacement=await launchHost();
    send('A');
    await waitFor(()=>replacement.messages.some(message=>message.idle==='2'),'fresh host authenticated after drain');
    await expectDevice({...idle,attached:true});
    replacement.child.send('start');
    await waitFor(()=>commands.filter(type=>type==='start').length===2,'fresh host explicitly requested start');
    send('P 15002');
    await waitFor(()=>replacement.messages.some(message=>message.active==='3'),'fresh lease advanced epoch');
    await expectDevice({...idle,phase:'active',epoch:3,attached:true,opens:2});
    replacement.child.send('stop');
    await waitFor(()=>commands.includes('stop'),'fresh host sent a matching Stop');
    send('P 15003');
    await waitFor(()=>replacement.messages.some(message=>message.stopped==='4'),'fresh host received the real resource acknowledgement');
    assert.deepEqual(await replacement.exit,[0,null]);
    await expectDevice({...idle,epoch:4,attached:true,opens:2,closes:2});
    console.log('SIGKILL of the real Mac carrier: with device close withheld, the C++ lease expired exactly at 15,000 ms, discarded queued PCM and closed the codec. A new authenticated host explicitly started epoch 3 and stopped at epoch 4.');
  } finally {
    for(const socket of sockets)socket.terminate();
    for(const {child,exit} of processes){
      if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
      await exit;
    }
    device.stdin.end();
    deviceLines.close();
    const cleanup=setTimeout(()=>device.kill('SIGKILL'),1000);
    try{assert.deepEqual(await deviceExit,[0,null]);}finally{clearTimeout(cleanup);}
  }
}
