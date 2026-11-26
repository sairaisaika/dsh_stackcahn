import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { duplexPair } from 'node:stream';
import { connect as connectTls } from 'node:tls';
import { USB_AGENT_ALPN, USB_AGENT_CIPHER, USB_AGENT_PREAMBLE, usbTlsIdentity } from '../src/agent-usb-wire.mjs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import net from 'node:net';
import { WebSocket } from 'ws';
import { createPairing } from '../src/pairing.mjs';
import { createAgentTransport } from '../src/agent-transport.mjs';
import { AUDIO, CAPTION_BYTES, MAX_U64, encodePcm, decodePcm, decodeControl } from '../src/agent-protocol.mjs';

const deviceId = '123456abcdef', bootId = 'b'.repeat(32);
let root, pairing, otherPairing;
test.before(async () => {
  root = await mkdtemp(join(tmpdir(), 'sion-agent-tls-'));
  for (const name of ['one', 'other']) createPairing(join(root, name), 'wss://192.168.1.2:9080/audio');
  pairing = JSON.parse(await readFile(join(root, 'one', 'pairing.json'), 'utf8'));
  otherPairing = JSON.parse(await readFile(join(root, 'other', 'pairing.json'), 'utf8'));
});
test.after(async () => { await rm(root, { recursive: true, force: true }); });

async function fixture(t, options = {}) {
  const transport = createAgentTransport({ pairing, deviceId, ...options });
  t.after(() => transport.close());
  const address = await transport.listen({ host: '127.0.0.1', port: 0 });
  function client(overrides = {}) {
    const ws = new WebSocket(`wss://127.0.0.1:${address.port}/audio`, 'sion-agent-v1', {
      ca: pairing.record.ca, servername: 'sion-host', rejectUnauthorized: true,
      headers: { Authorization: `Bearer ${pairing.record.local_token}`,
        'X-Sion-Pair-Id': pairing.record.pair_id, 'X-Sion-Device-Id': deviceId }, ...overrides,
    });
    ws.on('error', () => {}); t.after(() => ws.terminate()); return ws;
  }
  async function connect({ epoch = '0', hello = {} } = {}) {
    const connected = once(transport.events, 'connection'); const ws = client(); await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'hello', protocol: 1, device_id: deviceId, pair_id: pairing.record.pair_id,
      boot_id: bootId, epoch, phase: 'idle', ...hello }));
    const [connection] = await connected; return { ws, connection };
  }
  return { transport, client, connect };
}
async function start(ws, connection) {
  const received = once(ws, 'message'); const pending = connection.start();
  const [bytes] = await received; const request = JSON.parse(bytes);
  assert.equal(request.type, 'start');
  const epoch = (BigInt(request.epoch) + 1n).toString();
  ws.send(JSON.stringify({ type: 'started', request_id: request.request_id, boot_id: bootId, epoch }));
  await pending; return epoch;
}
const send = (ws, value) => ws.send(JSON.stringify(value));

// 只连接内存 Duplex；走公开 attachUsb、真实 TLS/协议，不创建监听器。
async function memoryUsbInput(t) {
  const [host, device] = duplexPair();
  let inputArrived;
  const arrivals = [], ages = [], gaps = [];
  const transport = createAgentTransport({ pairing, deviceId, recoverInput: true,
    voiceDiagnostics: {
      startCapture() {}, endCapture() {}, closeLink() {},
      inputFrame(at, queued) { arrivals.push({ at, queued }); inputArrived?.(); },
      inputRead(age) { ages.push(age); },
      inputGap(count, reason) { gaps.push({ count, reason }); },
    },
  });
  let tls;
  t.after(async () => { tls?.destroy(); device.destroy(); host.destroy(); await transport.close(); });
  const preamble = once(device, 'data');
  const attaching = transport.attachUsb(host);
  attaching.catch(() => {});
  assert.equal((await preamble)[0].toString('ascii'), USB_AGENT_PREAMBLE);
  const credentials = usbTlsIdentity(deviceId, pairing.record.pair_id, pairing.record.local_token);
  tls = connectTls({ socket: device, minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2',
    ciphers: USB_AGENT_CIPHER, ALPNProtocols: [USB_AGENT_ALPN],
    pskCallback: () => credentials, rejectUnauthorized: false,
  });
  tls.on('error', () => {});
  const peer = new EventEmitter();
  let pending = Buffer.alloc(0);
  tls.on('data', bytes => {
    pending = Buffer.concat([pending, bytes]);
    while (pending.length >= 3) {
      const length = pending.readUInt16BE(1);
      if (pending.length < length + 3) break;
      const kind = pending[0], payload = pending.subarray(3, length + 3);
      pending = pending.subarray(length + 3);
      if (kind === 1) peer.emit('message', payload);
    }
  });
  function writeFrame(value, binary = false) {
    const payload = binary ? value : Buffer.from(value, 'utf8');
    const header = Buffer.alloc(3);
    header[0] = binary ? 2 : 1; header.writeUInt16BE(payload.length, 1);
    tls.write(Buffer.concat([header, payload]));
  }
  peer.send = value => writeFrame(value);
  await once(tls, 'secureConnect');
  peer.send(JSON.stringify({ type: 'hello', protocol: 1, device_id: deviceId,
    pair_id: pairing.record.pair_id, boot_id: bootId, epoch: '0', phase: 'idle' }));
  const connection = await attaching;
  const epoch = await start(peer, connection);
  const pcm = Buffer.alloc(AUDIO.samples * AUDIO.inputChannels * 2);
  async function frame(sequence) {
    const arrived = new Promise(resolve => { inputArrived = resolve; });
    writeFrame(encodePcm({ kind: 1, epoch: BigInt(epoch), sequence: BigInt(sequence), pcm }), true);
    await arrived; inputArrived = undefined;
  }
  return { connection, frame, arrivals, ages, gaps };
}

for (const trajectory of ['consumer pause', 'concentrated arrival']) {
  test(`memory USB 827ms ${trajectory} keeps the same 83 frames`, { timeout: 5000 }, async t => {
    const { connection, frame, arrivals, ages, gaps } = await memoryUsbInput(t);
    let now = 0;
    t.mock.method(performance, 'now', () => now);
    // 同样的 0..82、10ms 音频；只改变 Host 到达时刻，不等待墙钟。
    for (let i = 0; i < 83; i++) {
      now = trajectory === 'consumer pause' ? i * 10 : 827;
      await frame(i);
      assert.equal(connection.inputGeneration, 0);
      assert.equal(connection.input.length, i + 1);
    }
    now = 827;
    assert.deepEqual(arrivals.map(entry => entry.at),
      Array.from({ length: 83 }, (_, i) => trajectory === 'consumer pause' ? i * 10 : 827));
    assert.equal(Math.max(...arrivals.map(entry => entry.queued)), 83);
    const sequences = [];
    let oldBatch;
    while (sequences.length < 83) {
      const batch = await connection.readInputBatch();
      oldBatch ??= batch;
      assert.equal(batch.generation, 0);
      assert.ok(batch.frames.length >= 1 && batch.frames.length <= 4);
      sequences.push(...batch.frames.map(value => Number(value.sequence)));
    }
    assert.deepEqual(sequences, Array.from({ length: 83 }, (_, i) => i));
    assert.deepEqual(ages, Array.from({ length: 83 }, (_, i) => trajectory === 'consumer pause' ? 827 - i * 10 : 0));
    assert.equal(connection.input.length, 0);
    assert.deepEqual(gaps, []);
    assert.equal(connection.snapshot().phase, 'active');
    // 真正的序号缺口才换代；丢弃排队的83，保留85。旧 batch 的代次随即过期。
    now = 837; await frame(83);
    assert.equal(connection.inputGeneration, 0);
    now = 847; await frame(85);
    assert.deepEqual(gaps, [{ count: 2, reason: 'device' }]);
    const next = await connection.readInputBatch();
    assert.equal(next.generation, 1);
    assert.notEqual(oldBatch.generation, next.generation);
    assert.deepEqual(next.frames.map(value => Number(value.sequence)), [85]);
    assert.equal(connection.snapshot().phase, 'active');
  });
}

test('memory USB capacity boundary is 400 frames independently of the 827ms traces', { timeout: 5000 }, async t => {
  const { connection, frame, arrivals, ages, gaps } = await memoryUsbInput(t);
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  for (let i = 0; i < 400; i++) {
    now = i * 10;
    await frame(i);
    assert.equal(connection.inputGeneration, 0);
    assert.equal(connection.input.length, i + 1);
  }
  assert.deepEqual(gaps, []);
  now = 4000;
  await frame(400);
  assert.equal(Math.max(...arrivals.map(entry => entry.queued)), 400);
  assert.deepEqual(gaps, [{ count: 400, reason: 'capacity' }]);
  assert.equal(connection.inputGeneration, 1);
  assert.equal(connection.input.length, 1);
  const batch = await connection.readInputBatch();
  assert.equal(batch.generation, 1);
  assert.deepEqual(batch.frames.map(value => Number(value.sequence)), [400]);
  assert.deepEqual(ages, [0]);
  assert.equal(connection.snapshot().phase, 'active');
});

test('battery reports require negotiated active epochs and expire without a new reading', async t => {
  const {ws,connection}=await (await fixture(t)).connect({hello:{battery:1}});
  assert.equal(connection.negotiatedCapabilities().versions.battery,1);
  assert.deepEqual(connection.batterySnapshot(),{version:1,status:'waiting'});
  const epoch=await start(ws,connection);
  const sample={type:'battery_state',boot_id:bootId,epoch,percent:61,direction:'charging'};
  const publish=async value=>{
    const pong=once(ws,'pong');
    send(ws,value);
    ws.ping();
    await pong;
  };
  await publish(sample);
  assert.deepEqual(connection.batterySnapshot(),{version:1,status:'current',percent:61,direction:'charging'});
  assert.deepEqual(connection.batterySnapshot(performance.now()+6500),{version:1,status:'stale'});
  await publish({...sample,percent:null,direction:'unknown'});
  assert.deepEqual(connection.batterySnapshot(),{version:1,status:'unavailable'});
  assert.throws(()=>decodeControl(Buffer.from(JSON.stringify({...sample,percent:101}))));
  assert.throws(()=>decodeControl(Buffer.from(JSON.stringify({...sample,direction:'unknown'}))));
  const stopMessage=once(ws,'message');
  const stopping=connection.stop();
  const stop=JSON.parse((await stopMessage)[0]);
  await publish(sample);
  assert.deepEqual(connection.batterySnapshot(),{version:1,status:'waiting'});
  send(ws,{type:'stopped',boot_id:bootId,request_id:stop.request_id,epoch:String(BigInt(epoch)+1n),resources_stopped:true});
  assert.equal((await stopping).deviceIdle,true);
  const next=await start(ws,connection);
  await publish(sample);
  assert.deepEqual(connection.batterySnapshot(),{version:1,status:'waiting'});
  await publish({...sample,epoch:next,percent:0,direction:'discharging'});
  assert.deepEqual(connection.batterySnapshot(),{version:1,status:'current',percent:0,direction:'discharging'});
});

test('ambient telemetry exposes partial raw readings only in the current active epoch',async t=>{
  const {ws,connection}=await (await fixture(t)).connect({hello:{ambient:1}});
  assert.equal(connection.negotiatedCapabilities().versions.ambient,1);
  assert.deepEqual(connection.ambientSnapshot(),{version:1,status:'waiting'});
  const epoch=await start(ws,connection);
  const sample={type:'ambient_state',boot_id:bootId,epoch,light:{channel0:0,channel1:65535},proximity_raw:null};
  const publish=async value=>{
    const pong=once(ws,'pong');
    send(ws,value);ws.ping();await pong;
  };
  await publish(sample);
  assert.deepEqual(connection.ambientSnapshot(),{version:1,status:'current',light:sample.light});
  assert.deepEqual(connection.ambientSnapshot(performance.now()+6100),{version:1,status:'stale'});
  await publish({...sample,light:null,proximity_raw:0});
  assert.deepEqual(connection.ambientSnapshot(),{version:1,status:'current',proximityRaw:0});
  await publish({...sample,light:null,proximity_raw:null});
  assert.deepEqual(connection.ambientSnapshot(),{version:1,status:'unavailable'});
  assert.throws(()=>decodeControl(Buffer.from(JSON.stringify({...sample,light:{channel0:65536,channel1:0}}))));
  assert.throws(()=>decodeControl(Buffer.from(JSON.stringify({...sample,proximity_raw:2048}))));
  const stoppingMessage=once(ws,'message');
  const stopping=connection.stop();
  const stop=JSON.parse((await stoppingMessage)[0]);
  await publish(sample);
  assert.deepEqual(connection.ambientSnapshot(),{version:1,status:'waiting'});
  send(ws,{type:'stopped',boot_id:bootId,request_id:stop.request_id,epoch:String(BigInt(epoch)+1n),resources_stopped:true});
  await stopping;
  const next=await start(ws,connection);
  await publish(sample);
  assert.deepEqual(connection.ambientSnapshot(),{version:1,status:'waiting'});
  await publish({...sample,epoch:next,proximity_raw:2047});
  assert.deepEqual(connection.ambientSnapshot(),{version:1,status:'current',light:sample.light,proximityRaw:2047});
});

test('head touch reports distinguish idle channels, read failure, and expired or retired samples',async t=>{
  const {ws,connection}=await (await fixture(t)).connect({hello:{head_touch:1}});
  const waiting={version:1,status:'waiting'};
  assert.equal(connection.negotiatedCapabilities().versions.headTouch,1);
  assert.deepEqual(connection.headTouchSnapshot(),waiting);
  const epoch=await start(ws,connection);
  const sample={type:'head_touch_state',boot_id:bootId,epoch,levels:[0,2,3]};
  const publish=async value=>{
    const pong=once(ws,'pong');
    send(ws,value);ws.ping();await pong;
  };
  await publish(sample);
  assert.deepEqual(connection.headTouchSnapshot(),{version:1,status:'current',levels:[0,2,3]});
  assert.deepEqual(connection.headTouchSnapshot(performance.now()+1000),{version:1,status:'stale'});
  await publish({...sample,levels:null});
  assert.deepEqual(connection.headTouchSnapshot(),{version:1,status:'unavailable'});
  await publish({...sample,levels:[0,0,0]});
  assert.deepEqual(connection.headTouchSnapshot(),{version:1,status:'current',levels:[0,0,0]});
  for(const levels of [[0,1],[0,1,2,3],[-1,0,0],[0,1,4],[0,1.5,2]])
    assert.throws(()=>decodeControl(Buffer.from(JSON.stringify({...sample,levels}))));
  const stopMessage=once(ws,'message');
  const stopping=connection.stop();
  const stop=JSON.parse((await stopMessage)[0]);
  await publish(sample);
  assert.deepEqual(connection.headTouchSnapshot(),waiting);
  send(ws,{type:'stopped',boot_id:bootId,request_id:stop.request_id,epoch:String(BigInt(epoch)+1n),resources_stopped:true});
  await stopping;
  const next=await start(ws,connection);
  await publish(sample);
  assert.deepEqual(connection.headTouchSnapshot(),waiting);
  await publish({...sample,epoch:next});
  assert.deepEqual(connection.headTouchSnapshot(),{version:1,status:'current',levels:[0,2,3]});
});

test('v2 head gestures are retained across snapshots, bounded, deduplicated and retired at Stop',async t=>{
  const {ws,connection}=await (await fixture(t)).connect({hello:{head_touch:2}});
  assert.equal(connection.negotiatedCapabilities().versions.headTouch,2);
  const epoch=await start(ws,connection);
  const gesture={type:'head_touch_gesture',boot_id:bootId,epoch,sequence:1,kind:'tap',duration_ms:50,peak:2,age_ms:400};
  const publish=async value=>{
    const pong=once(ws,'pong');
    send(ws,value);ws.ping();await pong;
  };
  for(let sequence=1;sequence<=5;sequence++)await publish({...gesture,sequence});
  const ages=connection.headTouchSnapshot().recentGestures;
  assert.deepEqual(ages.map(event=>event.sequence),[2,3,4,5]);
  assert.ok(ages.every(event=>event.ageMs>=400));
  await publish({...gesture,sequence:5,age_ms:0,kind:'hold'});
  assert.equal(connection.headTouchSnapshot().recentGestures.at(-1).kind,'tap');
  assert.deepEqual(connection.headTouchSnapshot(performance.now()+29601).recentGestures,[]);
  for(const patch of [{peak:0},{age_ms:3000},{sequence:0},{duration_ms:60001},{kind:'left'}])
    assert.throws(()=>decodeControl(Buffer.from(JSON.stringify({...gesture,...patch}))));

  const incoming=once(ws,'message');
  const stopping=connection.stop();
  const stop=JSON.parse((await incoming)[0]);
  await publish({...gesture,sequence:6});
  assert.deepEqual(connection.headTouchSnapshot(),{version:2,status:'waiting'});
  send(ws,{type:'stopped',boot_id:bootId,request_id:stop.request_id,epoch:String(BigInt(epoch)+1n),resources_stopped:true});
  await stopping;
  const next=await start(ws,connection);
  await publish({...gesture,sequence:7});
  assert.deepEqual(connection.headTouchSnapshot().recentGestures,[]);
  await publish({...gesture,epoch:next});
  assert.deepEqual(connection.headTouchSnapshot().recentGestures.map(event=>event.sequence),[1]);
});

test('the hello states whether the device stays linked while it waits', async t => {
  const plain = await (await fixture(t)).connect();
  assert.equal(plain.connection.standbyMode, 0);
  const f = await fixture(t);
  const refused = f.client(); await once(refused, 'open');
  const closed = once(refused, 'close');
  refused.send(JSON.stringify({ type: 'hello', protocol: 1, device_id: deviceId, pair_id: pairing.record.pair_id,
    boot_id: bootId, epoch: '0', phase: 'idle', standby: 1 }));
  await closed; // 1 meant an on-device wake phrase; no supported firmware sends it.
});
test('a linked-standby device can ask for attention and be told it is merely waiting', async t => {
  const { ws, connection } = await (await fixture(t)).connect({ hello: { standby: 2, ring: 1, voice_indicator: 1, head_touch: 2 } });
  assert.equal(connection.standbyMode, 2);
  let attentions = 0; const gestures = []; const intents = [];
  connection.onAttention = intent => { attentions++; intents.push(intent); };
  connection.onHeadTouchGesture = gesture => gestures.push(gesture);
  const epoch = await start(ws, connection);
  const incoming = once(ws, 'message');
  connection.setVoiceIndicator('standby');
  assert.deepEqual(JSON.parse((await incoming)[0]), { type: 'voice_indicator', boot_id: bootId, epoch, state: 'standby' });
  ws.send(JSON.stringify({ type: 'attention', boot_id: bootId, epoch }));
  ws.send(JSON.stringify({ type: 'attention', boot_id: bootId, epoch, intent: 'sleep' }));
  ws.send(JSON.stringify({ type: 'head_touch_gesture', boot_id: bootId, epoch, sequence: 1, kind: 'hold', duration_ms: 600, peak: 2, age_ms: 10 }));
  ws.send(JSON.stringify({ type: 'head_touch_gesture', boot_id: bootId, epoch, sequence: 1, kind: 'hold', duration_ms: 600, peak: 2, age_ms: 30 }));
  for (let i = 0; i < 100 && gestures.length < 1; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(attentions, 2);
  assert.deepEqual(intents, ['toggle', 'sleep']);
  assert.deepEqual(gestures, [{ kind: 'hold', durationMs: 600, peak: 2 }]); // A repeated report is one gesture.
  const plain = await (await fixture(t)).connect({ hello: { ring: 1, voice_indicator: 1 } });
  const plainEpoch = await start(plain.ws, plain.connection);
  plain.connection.setVoiceIndicator('standby'); // Not a state this device declared.
  const closed = once(plain.ws, 'close');
  plain.ws.send(JSON.stringify({ type: 'attention', boot_id: bootId, epoch: plainEpoch }));
  await closed; // Attention is only valid from a linked-standby device.
});
test('raw head-strip readings are tallied and logged with each health sample, gestures one by one', async t => {
  const logged = [];
  const voiceDiagnostics = { stage: (event, fields) => logged.push([event, structuredClone(fields)]), startCapture() {}, endCapture() {}, closeLink() {},
    inputFrame() {}, inputGap() {}, inputRead() {}, usbRead() {} };
  const { ws, connection } = await (await fixture(t, { voiceDiagnostics })).connect({ hello: { health: 1, head_touch: 2 } });
  const gestures = [];
  connection.onHeadTouchGesture = gesture => gestures.push(gesture);
  const epoch = await start(ws, connection);
  const send = message => ws.send(JSON.stringify({ boot_id: bootId, epoch, ...message }));
  for (const levels of [[0, 0, 0], [1, 0, 0], [2, 1, 0], null, [0, 0, 3]]) send({ type: 'head_touch_state', levels });
  send({ type: 'head_touch_gesture', sequence: 1, kind: 'tap', duration_ms: 90, peak: 1, age_ms: 5 });
  send({ type: 'health_state', sequence: 1, uptime_ms: 40500, chip_decicelsius: 450, busy_permille: [20, 0], top_task: 'esp_',
    top_permille: 9, gap_ms: [21, 40, 20], touch_errors: 0, battery: 100, charging: false, discharging: false, brightness: 100, mouth_ticks: 0 });
  for (let i = 0; i < 100 && !logged.some(([event]) => event === 'head-touch-window'); i++) await new Promise(r => setTimeout(r, 5));
  assert.deepEqual(logged.find(([event]) => event === 'head-touch-gesture')[1], { kind: 'tap', durationMs: 90, peak: 1 });
  assert.deepEqual(gestures, [{ kind: 'tap', durationMs: 90, peak: 1 }]);
  assert.deepEqual(logged.find(([event]) => event === 'head-touch-window')[1],
    { samples: 5, unreadable: 1, touched: [2, 1, 1], strong: [1, 0, 1], peak: [2, 1, 3] });
  send({ type: 'health_state', sequence: 2, uptime_ms: 70500, chip_decicelsius: 450, busy_permille: [20, 0], top_task: 'esp_',
    top_permille: 9, gap_ms: [21, 40, 20], touch_errors: 0, battery: 100, charging: false, discharging: false, brightness: 100, mouth_ticks: 0 });
  await new Promise(r => setTimeout(r, 30));
  assert.equal(logged.filter(([event]) => event === 'head-touch-window').length, 1);  // A window with no readings is not logged.
});
test('device health samples are accepted only when declared and logged as numbers', async t => {
  const logged = [];
  const voiceDiagnostics = { stage: (event, fields) => logged.push([event, fields]), startCapture() {}, endCapture() {}, closeLink() {},
    inputFrame() {}, inputGap() {}, inputRead() {}, usbRead() {} };
  const { ws, connection } = await (await fixture(t, { voiceDiagnostics })).connect({ hello: { health: 1 } });
  assert.equal(connection.negotiatedCapabilities().versions.health, 1);
  const epoch = await start(ws, connection);
  const sample = { type: 'health_state', boot_id: bootId, epoch, sequence: 3, uptime_ms: 70500, chip_decicelsius: 497,
    busy_permille: [20, null], top_task: 'esp_', top_permille: 9, gap_ms: [21, 40, 20], touch_errors: 0,
    battery: 100, charging: true, discharging: false, brightness: 70, mouth_ticks: 12 };
  ws.send(JSON.stringify(sample));
  for (let i = 0; i < 100 && !logged.some(([event]) => event === 'device-health'); i++) await new Promise(r => setTimeout(r, 5));
  const [, fields] = logged.find(([event]) => event === 'device-health');
  assert.deepEqual(fields, { sequence: 3, uptimeMs: 70500, chipCelsius: 49.7, busyPermille: [20, null], topTask: 'esp_', topPermille: 9,
    touchGapMs: 21, lvglGapMs: 40, loopGapMs: 20, touchErrors: 0, battery: 100, charging: true, discharging: false, brightness: 70, mouthOpenTicks: 12 });
  assert.equal(connection.phase, 'active');
  const plain = await (await fixture(t)).connect();
  const plainEpoch = await start(plain.ws, plain.connection);
  const closed = once(plain.ws, 'close');
  plain.ws.send(JSON.stringify({ ...sample, epoch: plainEpoch })); // Not declared by this device.
  await closed;
  const bad = await (await fixture(t)).connect({ hello: { health: 1 } });
  const badEpoch = await start(bad.ws, bad.connection);
  const rejected = once(bad.ws, 'close');
  bad.ws.send(JSON.stringify({ ...sample, epoch: badEpoch, top_task: 'a"b<' })); // Only a short plain tag is accepted.
  await rejected;
});
test('voice status sends one current-epoch update per transition when advertised', async t => {
  const {ws,connection}=await (await fixture(t)).connect({hello:{ring:1,voice_indicator:1}});
  connection.setVoiceIndicator('waiting'); // Before Start, there is no active epoch.
  const epoch=await start(ws,connection);
  let incoming=once(ws,'message');
  connection.setVoiceIndicator('listening');
  assert.deepEqual(JSON.parse((await incoming)[0]),{type:'voice_indicator',boot_id:bootId,epoch,state:'listening'});
  incoming=once(ws,'message');
  connection.setVoiceIndicator('listening');
  connection.setVoiceIndicator('waiting');
  assert.deepEqual(JSON.parse((await incoming)[0]),{type:'voice_indicator',boot_id:bootId,epoch,state:'waiting'});
  incoming=once(ws,'message');
  const stopping=connection.stop();
  connection.setVoiceIndicator('listening');
  const stop=JSON.parse((await incoming)[0]);
  assert.equal(stop.type,'stop');
  send(ws,{type:'stopped',boot_id:bootId,request_id:stop.request_id,epoch:String(BigInt(epoch)+1n),resources_stopped:true});
  await stopping;
});

test('late capability receipts after Stop cannot cancel a new session on the same authenticated socket', async t => {
  const { ws, connection } = await (await fixture(t)).connect({ hello: { camera: 1, expression: 1, motion: 1, ring: 1 } });
  const oldEpoch = await start(ws, connection);
  let incoming = once(ws, 'message');
  const stopping = connection.stop();
  const stop = JSON.parse((await incoming)[0]);
  assert.equal(stop.type, 'stop');
  send(ws, { type: 'stopped', boot_id: bootId, epoch: String(BigInt(oldEpoch) + 1n), request_id: stop.request_id, resources_stopped: true });
  assert.equal((await stopping).deviceIdle, true);
  const newEpoch = await start(ws, connection);

  incoming = once(ws, 'message');
  const expression = connection.setExpression('sad');
  const command = JSON.parse((await incoming)[0]);
  const current = { boot_id: bootId, epoch: newEpoch, request_id: command.request_id };
  const old = { ...current, epoch: oldEpoch };
  // Keep the request id equal to show that epoch is independently checked.
  send(ws, { ...old, type: 'expression_result', expression: 'sad', status: 'unavailable' });
  send(ws, { ...old, type: 'motion_result', code: 'reached', yaw: 100, pitch: 450 });
  send(ws, { ...old, type: 'camera_meta', bytes: '2048', width: '640', height: '480' });
  send(ws, { ...old, type: 'camera_complete' });
  send(ws, { ...old, type: 'ring_result', code: 'completed' });
  send(ws, { ...current, type: 'expression_result', expression: 'sad', status: 'applied' });
  assert.deepEqual(await expression, { version: 1, expression: 'sad', status: 'applied' });
  assert.equal(connection.snapshot().phase, 'active');
});

test('captions are opt-in, scoped to active epochs, and clipped on UTF-8 boundaries', async t=>{
  const old=await (await fixture(t)).connect();
  await start(old.ws,old.connection);
  assert.equal(old.connection.sendCaption('user','private text'),false);
  const {ws,connection}=await (await fixture(t)).connect({hello:{caption:1}});
  assert.equal(connection.sendCaption('user','idle text'),false);
  const epoch=await start(ws,connection);
  const received=once(ws,'message');
  assert.equal(connection.sendCaption('user','你好\r\n\0"\\'+('喜'.repeat(500))),true);
  const [raw]=await received;
  const message=JSON.parse(raw);
  assert.ok(raw.length<=AUDIO.maxMessageBytes);
  assert.deepEqual({type:message.type,boot_id:message.boot_id,epoch:message.epoch,speaker:message.speaker},
    {type:'caption',boot_id:bootId,epoch,speaker:'user'});
  const bytes=Buffer.from(message.text_hex,'hex');
  assert.ok(bytes.length<=CAPTION_BYTES);
  const decoded=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  assert.ok(decoded.startsWith('你好\n "\\'));
  assert.ok(decoded.endsWith('...'));
  Object.defineProperty(connection.socket,'bufferedAmount',{value:AUDIO.maxMessageBytes+1,configurable:true});
  assert.equal(connection.sendCaption('assistant','ordinary caption'),false);
  const required=once(ws,'message');
  assert.equal(connection.sendCaption('assistant','required caption',{required:true}),true);
  assert.equal(Buffer.from(JSON.parse((await required)[0]).text_hex,'hex').toString(),'required caption');
  delete connection.socket.bufferedAmount;
  const stop=once(ws,'message');
  const stopped=connection.stop();
  assert.equal(connection.sendCaption('assistant','late reply'),false);
  const command=JSON.parse((await stop)[0]);
  assert.equal(command.type,'stop');
  send(ws,{type:'stopped',boot_id:bootId,epoch:String(BigInt(epoch)+1n),request_id:command.request_id,resources_stopped:true});
  await stopped;
});

test('camera status is authenticated, passive, epoch bound and expires; old peers remain unknown',async t=>{
  const f=await fixture(t);const {ws,connection}=await f.connect({hello:{camera:1,camera_status:1}});
  assert.equal(connection.cameraSnapshot().permission,'unknown');
  const report={type:'camera_state',boot_id:bootId,epoch:'0',permission:'disabled',phase:'idle',busy:false,error:''};
  const tick=()=>new Promise(resolve=>setTimeout(resolve,10));
  send(ws,report);await tick();assert.equal(connection.cameraSnapshot().permission,'disabled');
  assert.equal(connection.snapshot().phase,'idle');
  const received=connection.cameraReport.receivedAt;
  assert.equal(connection.cameraSnapshot(received+6000).status,'stale');
  assert.equal(connection.cameraSnapshot(received+6000).permission,'unknown');
  const epoch=await start(ws,connection);assert.equal(connection.cameraSnapshot().permission,'unknown');
  send(ws,report);await tick();assert.equal(connection.cameraSnapshot().permission,'unknown');
  send(ws,{...report,epoch,permission:'allowed',phase:'transferring',busy:true});await tick();
  assert.equal(connection.cameraSnapshot().phase,'transferring');
  const ended=once(connection,'disconnect');ws.close();await ended;
  assert.equal(connection.cameraSnapshot().capability,'disconnected');assert.equal(connection.cameraSnapshot().permission,'unknown');
  const g=await fixture(t);const old=await g.connect({hello:{camera:1}});
  assert.equal(old.connection.cameraSnapshot().status,'unavailable');assert.equal(old.connection.cameraSnapshot().permission,'unknown');
});
test('camera status rejects an unadvertised stream, wrong identity and future epoch',async t=>{
  for(const patch of [{capability:false},{boot_id:'d'.repeat(32)},{epoch:'1'}]){
    const f=await fixture(t),{ws,connection}=await f.connect({hello:{camera:1,...(patch.capability===false?{}:{camera_status:1})}});
    const ended=once(connection,'disconnect');
    send(ws,{type:'camera_state',boot_id:patch.boot_id??bootId,epoch:patch.epoch??'0',permission:'allowed',phase:'idle',busy:false,error:''});
    await ended;assert.equal(connection.snapshot().phase,'closed');
  }
});

test('playback fence capability is explicit; old peers do not receive unsupported commands', async t => {
  const f=await fixture(t);const {ws,connection}=await f.connect();await start(ws,connection);
  await assert.rejects(connection.drainOutput(),{code:'playback-unsupported'});
  assert.equal(connection.snapshot().phase,'active');
});

test('drain requires matching fence receipt after output credits while input remains active', async t => {
  const f=await fixture(t);const {ws,connection}=await f.connect({hello:{playback_fence:1}});
  const epoch=await start(ws,connection);
  const frame=once(ws,'message');const output=connection.sendOutput(Buffer.alloc(480));await frame;
  const received=once(ws,'message');let done=false;
  const draining=connection.drainOutput().then(value=>{done=true;return value;});
  const command=JSON.parse((await received)[0]);assert.equal(command.next_sequence,'1');
  await assert.rejects(connection.sendOutput(Buffer.alloc(480)),{code:'playback-busy'});
  send(ws,{type:'output',boot_id:bootId,epoch,sequence:'0'});await output;assert.equal(done,false);
  const input=connection.readInput();ws.send(encodePcm({kind:1,epoch:BigInt(epoch),sequence:0n,pcm:Buffer.alloc(960)}));
  await input;assert.equal(done,false);
  send(ws,{type:'output_drained',request_id:command.request_id,boot_id:bootId,epoch,next_sequence:'1'});
  assert.deepEqual(await draining,{playbackIdle:true,discarded:false,nextSequence:'1'});
  assert.equal(connection.snapshot().phase,'active');
});

test('interrupt retires pending output without accepting it and next playback keeps sequence',async t=>{
  const f=await fixture(t);const {ws,connection}=await f.connect({hello:{playback_fence:1}});const epoch=await start(ws,connection);
  const received=once(ws,'message');const pending=connection.sendOutput(Buffer.alloc(480));
  const rejection=assert.rejects(pending,{code:'playback-interrupted'});await received;
  const commandRead=once(ws,'message');const interrupt=connection.interruptOutput();
  const command=JSON.parse((await commandRead)[0]);await rejection;
  send(ws,{type:'output',boot_id:bootId,epoch,sequence:'0'}); // late, previously sent credit
  send(ws,{type:'output_interrupted',request_id:command.request_id,boot_id:bootId,epoch,next_sequence:'1'});
  assert.equal((await interrupt).discarded,true);
  const next=once(ws,'message');const writing=connection.sendOutput(Buffer.alloc(480));
  assert.equal(decodePcm((await next)[0],2).sequence,1n);
  send(ws,{type:'output',boot_id:bootId,epoch,sequence:'1'});await writing;
});

test('Stop supersedes playback drain and still waits for full resource release',async t=>{
  const f=await fixture(t);const {ws,connection}=await f.connect({hello:{playback_fence:1}});const epoch=await start(ws,connection);
  const drainRead=once(ws,'message');const draining=connection.drainOutput();const rejection=assert.rejects(draining,{code:'stopped'});
  const drain=JSON.parse((await drainRead)[0]);
  const stopRead=once(ws,'message');const stopping=connection.stop();const stop=JSON.parse((await stopRead)[0]);await rejection;
  send(ws,{type:'output_drained',request_id:drain.request_id,boot_id:bootId,epoch,next_sequence:'0'});
  send(ws,{type:'stopped',request_id:stop.request_id,boot_id:bootId,epoch:'2',resources_stopped:true});
  assert.equal((await stopping).deviceIdle,true);
});

test('fence wrong boundary or premature receipt closes instead of claiming completion',async t=>{
  for(const wrongBoundary of [true,false]){
    const f=await fixture(t);const {ws,connection}=await f.connect({hello:{playback_fence:1}});const epoch=await start(ws,connection);
    const frame=once(ws,'message');const output=connection.sendOutput(Buffer.alloc(480));const outputRejected=assert.rejects(output);await frame;
    const commandRead=once(ws,'message');const drain=connection.drainOutput();const rejected=assert.rejects(drain);
    const command=JSON.parse((await commandRead)[0]);
    send(ws,{type:'output_drained',request_id:command.request_id,boot_id:bootId,epoch,next_sequence:wrongBoundary?'2':'1'});
    await Promise.all([rejected,outputRejected]);assert.equal(connection.snapshot().phase,'closed');await f.transport.close();
  }
});

test('fence timeout and cancellation invalidate connection without claiming playback idle',async t=>{
  for(const cancel of [false,true]){
    const f=await fixture(t,{timeoutMs:150,heartbeatMs:50});const {ws,connection}=await f.connect({hello:{playback_fence:1}});await start(ws,connection);
    ws.on('message',bytes=>{const m=JSON.parse(bytes);if(m.type==='renew')send(ws,{type:'renewed',boot_id:bootId,epoch:m.epoch});});
    const abort=new AbortController();const pending=connection.drainOutput({signal:abort.signal});
    const rejected=assert.rejects(pending,{code:cancel?'cancelled':'playback-timeout'});if(cancel)abort.abort();await rejected;
    assert.equal(connection.snapshot().phase,'closed');await f.transport.close();
  }
});

test('PCM wire format is explicit, lossless for uint64 and rejects padding, shape and control errors', () => {
  const pcm = Buffer.alloc(960); pcm.writeInt16LE(-32768); pcm.writeInt16LE(32767, 2);
  const bytes = encodePcm({ kind: 1, epoch: 0x0102030405060708n, sequence: MAX_U64 - 1n,
    readStartedUs: 42n, pcm });
  assert.equal(bytes.length, 992);
  assert.equal(bytes.subarray(0, 32).toString('hex'),
    '53494131010000000102030405060708fffffffffffffffe000000000000002a');
  const decoded = decodePcm(bytes, 1); assert.deepEqual(decoded.pcm, pcm);
  assert.equal(decoded.sequence, MAX_U64 - 1n); assert.equal(decoded.readStartedUs, 42n);
  bytes[32] = 1; assert.equal(decoded.pcm[0], 0); // returned payload owns its bytes
  for (const at of [0, 4, 5, 6, 7]) {
    const bad = Buffer.from(bytes); bad[at] ^= 8; assert.throws(() => decodePcm(bad, 1));
  }
  assert.throws(() => decodePcm(bytes.subarray(1), 1));
  assert.throws(() => encodePcm({ kind: 2, epoch: 1n, sequence: 0n, pcm }));
  assert.throws(() => decodeControl(Buffer.from('{"type":"hello","epoch":"-1"}')));
  assert.throws(() => decodeControl(Buffer.from([0xff])));
});

test('real TLS validates CA and hostname; upgrade refuses wrong credentials, identity and browser origin', async t => {
  const f = await fixture(t);
  for (const overrides of [{ ca: otherPairing.record.ca }, { servername: 'wrong-host' }]) {
    const ws = f.client(overrides); await once(ws, 'error'); assert.notEqual(ws.readyState, WebSocket.OPEN);
  }
  const headers = { Authorization: `Bearer ${pairing.record.local_token}`,
    'X-Sion-Pair-Id': pairing.record.pair_id, 'X-Sion-Device-Id': deviceId };
  for (const change of [{ Authorization: 'Bearer wrong' }, { 'X-Sion-Device-Id': '000000000000' },
    { 'X-Sion-Pair-Id': '0'.repeat(32) }, { Origin: 'https://example.invalid' }]) {
    const ws = f.client({ headers: { ...headers, ...change } });
    const [, response] = await once(ws, 'unexpected-response');
    assert.equal(response.statusCode, 401); response.resume(); ws.terminate();
  }
  assert.equal(f.transport.connection, undefined);
});

test('one authenticated connection starts, carries bounded PCM, and confirms hardware stop before re-entry', async t => {
  const f = await fixture(t); const { ws, connection } = await f.connect();
  assert.equal(connection.snapshot().phase, 'idle');
  const duplicate = f.client(); const [, rejected] = await once(duplicate, 'unexpected-response');
  assert.equal(rejected.statusCode, 409); rejected.resume(); duplicate.terminate();
  const epoch = await start(ws, connection);
  const capture = connection.readInput();
  ws.send(encodePcm({ kind: 1, epoch: BigInt(epoch), sequence: 0n, readStartedUs: 123n, pcm: Buffer.alloc(960, 7) }));
  assert.equal((await capture).pcm[0], 7);
  const received = once(ws, 'message'); const output = connection.sendOutput(Buffer.alloc(480, 3));
  const [bytes, binary] = await received; assert.equal(binary, true);
  const frame = decodePcm(bytes, 2); assert.equal(frame.sequence, 0n); assert.equal(frame.pcm[0], 3);
  send(ws, { type: 'output', boot_id: bootId, epoch, sequence: '0' });
  assert.deepEqual(await output, { accepted: true }); // not playback-completed
  const request = once(ws, 'message'); const stopping = connection.stop(); let finished = false;
  stopping.then(() => { finished = true; });
  const stop = JSON.parse((await request)[0]); assert.equal(stop.type, 'stop'); assert.equal(finished, false);
  assert.equal(connection.snapshot().phase, 'stopping');
  ws.send(encodePcm({ kind: 1, epoch: BigInt(epoch), sequence: 1n, pcm: Buffer.alloc(960) }));
  send(ws, { type: 'stopped', request_id: stop.request_id, boot_id: bootId,
    epoch: '2', resources_stopped: true });
  assert.equal((await stopping).deviceIdle, true); assert.equal(connection.snapshot().phase, 'idle');
  assert.equal(await start(ws, connection), '3');
  const disconnected = once(connection, 'disconnect');
  ws.send(encodePcm({ kind: 1, epoch: 1n, sequence: 2n, pcm: Buffer.alloc(960) }));
  await disconnected; assert.equal(connection.snapshot().phase, 'closed');
});

test('input overflow and duplicate sequence fail the connection rather than silently lose capture', async t => {
  for (const mode of ['overflow', 'duplicate']) {
    const f = await fixture(t); const { ws, connection } = await f.connect(); await start(ws, connection);
    const disconnected = once(connection, 'disconnect');
    for (let i = 0; i < (mode === 'overflow' ? AUDIO.inputQueueFrames + 1 : 2); i++)
      ws.send(encodePcm({ kind: 1, epoch: 1n, sequence: mode === 'overflow' ? BigInt(i) : 0n, pcm: Buffer.alloc(960) }));
    const [failure] = await disconnected;
    assert.equal(failure.code, mode === 'overflow' ? 'input-overflow' : 'protocol-invalid');
    assert.equal(failure.protocolCode, mode === 'overflow' ? undefined : 'input-order');
    await assert.rejects(connection.readInput(), e => e.code === 'not-active');
    await f.transport.close();
  }
});

test('live input keeps a burst in order and survives a four second backlog with an authenticated Stop', async t => {
  const { ws, connection } = await (await fixture(t, { recoverInput: true })).connect();
  const epoch = await start(ws, connection);
  const sendFrames = async (from, to) => {
    const settled = Promise.race([once(ws, 'pong'), once(connection, 'disconnect')]);
    for (let sequence = from; sequence <= to; sequence++)
      ws.send(encodePcm({ kind: 1, epoch: BigInt(epoch), sequence: BigInt(sequence), pcm: Buffer.alloc(960) }));
    ws.ping();
    await settled;
  };
  await sendFrames(0, 63);
  assert.equal(connection.snapshot().phase, 'active');
  const first = await connection.readInputBatch({ limit: 4 });
  // A Host pause shorter than the backlog loses nothing.
  assert.deepEqual(first.frames.map(frame => frame.sequence), [0n, 1n, 2n, 3n]);
  assert.equal(first.generation, 0);

  // 60 remain. 340 more fill the backlog; one more retires it and keeps the link.
  await sendFrames(64, 404);
  assert.equal(connection.snapshot().phase, 'active');
  const resumed = await connection.readInputBatch({ limit: 4 });
  assert.deepEqual(resumed.frames.map(frame => frame.sequence), [404n]);
  assert.equal(resumed.generation, 1);

  const incoming = once(ws, 'message');
  const stopping = connection.stop();
  const stop = JSON.parse((await incoming)[0]);
  assert.equal(stop.type, 'stop');
  send(ws, { type: 'stopped', boot_id: bootId, request_id: stop.request_id,
    epoch: String(BigInt(epoch) + 1n), resources_stopped: true });
  assert.equal((await stopping).deviceIdle, true);
  assert.equal(await start(ws, connection), '3');
  assert.equal(connection.inputGeneration, 0);
});

test('late readers still receive queued audio and a device capture gap only resets the consumer', async t => {
  const { ws, connection } = await (await fixture(t, { recoverInput: true })).connect();
  const epoch = BigInt(await start(ws, connection));
  const sendFrame = async sequence => {
    const delivered = once(ws, 'pong');
    ws.send(encodePcm({ kind: 1, epoch, sequence, pcm: Buffer.alloc(960) }));
    ws.ping();
    await delivered;
  };
  await sendFrame(0n);
  await delay(260);
  const late = await connection.readInputBatch();
  assert.deepEqual(late.frames.map(frame => frame.sequence), [0n]);
  assert.equal(late.generation, 0);

  // The device skipped 1..4 while its own send queue was congested.
  await sendFrame(5n);
  const resumed = await connection.readInputBatch();
  assert.deepEqual(resumed.frames.map(frame => frame.sequence), [5n]);
  assert.equal(resumed.generation, 1);
  await sendFrame(6n);
  assert.equal((await connection.readInputBatch()).generation, 1);
  assert.equal(connection.snapshot().phase, 'active');

  // A replayed frame is still a protocol error.
  const closed = once(connection, 'disconnect');
  ws.send(encodePcm({ kind: 1, epoch, sequence: 6n, pcm: Buffer.alloc(960) }));
  assert.equal((await closed)[0].code, 'protocol-invalid');
});

test('output window is bounded and Stop rejects pending output without claiming playback finished', async t => {
  const f = await fixture(t); const { ws, connection } = await f.connect(); await start(ws, connection);
  const outputs = Array.from({ length: AUDIO.outputWindowFrames }, () => connection.sendOutput(Buffer.alloc(480)));
  const results = Promise.allSettled(outputs);
  await assert.rejects(connection.sendOutput(Buffer.alloc(480)), e => e.code === 'backpressure');
  const stoppedRequest = new Promise(resolve => ws.on('message', (bytes, binary) => {
    if (!binary) { const value = JSON.parse(bytes); if (value.type === 'stop') resolve(value); }
  }));
  const stopping = connection.stop(); const request = await stoppedRequest;
  assert.ok((await results).every(result => result.status === 'rejected' && result.reason.code === 'stopped'));
  send(ws, { type: 'stopped', request_id: request.request_id, boot_id: bootId, epoch: '2', resources_stopped: true });
  assert.equal((await stopping).deviceIdle, true);
});

test('cancellation, stale stop receipt and disconnect never produce a successful idle acknowledgement', async t => {
  for (const mode of ['cancel', 'stale', 'disconnect']) {
    const f = await fixture(t); const { ws, connection } = await f.connect(); await start(ws, connection);
    const received = once(ws, 'message'); const abort = new AbortController();
    const stopping = connection.stop({ signal: abort.signal }); const rejected = assert.rejects(stopping);
    const request = JSON.parse((await received)[0]);
    if (mode === 'cancel') abort.abort();
    else if (mode === 'disconnect') ws.terminate();
    else send(ws, { type: 'stopped', request_id: request.request_id, boot_id: bootId, epoch: '1', resources_stopped: true });
    await rejected; assert.equal(connection.snapshot().phase, 'closed'); await f.transport.close();
  }
});

test('missing hello and heartbeat are bounded; listener closes and cannot restart', async t => {
  const f = await fixture(t, { timeoutMs: 100, heartbeatMs: 25 });
  const silent = f.client(); await once(silent, 'open'); await once(silent, 'close');
  const { ws, connection } = await f.connect(); await start(ws, connection);
  const lost = once(connection, 'disconnect'); await lost;
  assert.equal(connection.snapshot().phase, 'closed');
  await f.transport.close(); await f.transport.close();
  await assert.rejects(f.transport.listen({ host: '127.0.0.1', port: 0 }), e => e.code === 'already-started');
});

test('output receipt timeout fails pending audio even while heartbeat is healthy', async t => {
  const f = await fixture(t, { timeoutMs: 150, heartbeatMs: 25 });
  const { ws, connection } = await f.connect(); await start(ws, connection);
  ws.on('message', (bytes, binary) => {
    if (!binary) { const message = JSON.parse(bytes);
      if (message.type === 'renew') send(ws, { type: 'renewed', boot_id: bootId, epoch: message.epoch });
    }
  });
  await assert.rejects(connection.sendOutput(Buffer.alloc(480)), error => error.code === 'output-timeout');
  assert.equal(connection.snapshot().phase, 'closed');
});

test('bad hello, oversize messages and unacknowledged Start cannot activate a session', async t => {
  for (const mode of ['identity', 'oversize', 'fragments', 'start-timeout']) {
    const f = await fixture(t, { timeoutMs: 150, heartbeatMs: 25 });
    if (mode === 'start-timeout') {
      const { connection } = await f.connect();
      await assert.rejects(connection.start(), error => error.code === 'command-timeout');
    } else {
      const ws = f.client(); await once(ws, 'open'); const closed = once(ws, 'close');
      if (mode === 'oversize') ws.send(Buffer.alloc(2049));
      else if (mode === 'fragments') {
        for (let i = 0; i < 34; i++) ws.send(Buffer.from([1]), { fin: i === 33 });
      }
      else send(ws, { type: 'hello', protocol: 1, device_id: '000000000000', pair_id: pairing.record.pair_id,
        boot_id: bootId, epoch: '0', phase: 'idle' });
      await closed;
    }
    assert.equal(f.transport.connection, undefined); await f.transport.close();
  }
});

test('read cancellation only removes its own wait; a later read still receives input', async t => {
  const f = await fixture(t); const { ws, connection } = await f.connect(); await start(ws, connection);
  const abort = new AbortController(); const pending = connection.readInput({ signal: abort.signal });
  const rejected = assert.rejects(pending, error => error.code === 'cancelled');
  await assert.rejects(connection.readInput(), error => error.code === 'reader-busy');
  abort.abort(); await rejected;
  ws.send(encodePcm({ kind: 1, epoch: 1n, sequence: 0n, pcm: Buffer.alloc(960) }));
  assert.equal((await connection.readInput()).sequence, 0n);
  assert.equal(connection.snapshot().phase, 'active');
});

test('listener close races bind safely and a closed listener releases the actual port', async () => {
  const transport = createAgentTransport({ pairing, deviceId });
  const starting = transport.listen({ host: '127.0.0.1', port: 0 });
  const rejected = assert.rejects(starting, error => error.code === 'closed');
  await transport.close(); await rejected;
  const second = createAgentTransport({ pairing, deviceId });
  const { port } = await second.listen({ host: '127.0.0.1', port: 0 }); await second.close();
  const probe = net.createServer();
  try { probe.listen(port, '127.0.0.1'); await once(probe, 'listening'); }
  finally { await new Promise(resolve => probe.close(resolve)); }
  const passive = createAgentTransport({ pairing, deviceId });
  await assert.rejects(passive.listen({ host: '0.0.0.0' })); await passive.close();
});

test('uint64 epochs stay exact above JS safe integers and reserve the final stop fence', async t => {
  const f = await fixture(t); const { ws, connection } = await f.connect({ epoch: '9007199254740992' });
  assert.equal(await start(ws, connection), '9007199254740993');
  const other = await fixture(t); const full = await other.connect({ epoch: MAX_U64.toString() });
  await assert.rejects(full.connection.start(), e => e.code === 'epoch-exhausted');
  assert.equal(full.connection.snapshot().phase, 'idle');
});

test('versioned expression reply is matched while audio remains active; unsupported peers receive no command',async t=>{
 const f=await fixture(t);const {ws,connection}=await f.connect({hello:{expression:1}});const epoch=await start(ws,connection);
 const received=once(ws,'message');const pending=connection.setExpression('sad');const command=JSON.parse((await received)[0]);
 await assert.rejects(connection.setExpression('happy'),{code:'expression-busy'});
 const input=connection.readInput();ws.send(encodePcm({kind:1,epoch:BigInt(epoch),sequence:0n,pcm:Buffer.alloc(960)}));await input;
 send(ws,{...command,type:'expression_result',status:'unavailable'});assert.deepEqual(await pending,{version:1,expression:'sad',status:'unavailable'});
 await assert.rejects(connection.setExpression('invented'),{code:'expression-invalid'});assert.equal(connection.snapshot().phase,'active');
 const old=await fixture(t);const peer=await old.connect();await start(peer.ws,peer.connection);
 await assert.rejects(peer.connection.setExpression('happy'),{code:'expression-unsupported'});assert.equal(peer.connection.snapshot().phase,'active');
});
test('Stop preempts expression and ignores its in-flight result before the Stop receipt',async t=>{
 const f=await fixture(t);const {ws,connection}=await f.connect({hello:{expression:1}});const epoch=await start(ws,connection);
 const read=once(ws,'message'),pending=connection.setExpression('happy'),rejected=assert.rejects(pending,{code:'stopped'});const expression=JSON.parse((await read)[0]);
 const readStop=once(ws,'message'),stopping=connection.stop(),command=JSON.parse((await readStop)[0]);await rejected;
 send(ws,{...expression,type:'expression_result',status:'applied'});
 send(ws,{type:'stopped',boot_id:bootId,epoch:String(BigInt(epoch)+1n),request_id:command.request_id,resources_stopped:true});
 assert.equal((await stopping).deviceIdle,true);
});
test('wrong expression receipt and cancelled calls close the connection rather than claiming completion',async t=>{
 for(const cancel of [false,true]){
  const f=await fixture(t);const {ws,connection}=await f.connect({hello:{expression:1}});await start(ws,connection);
  const abort=new AbortController(),read=once(ws,'message'),pending=connection.setExpression('angry',{signal:abort.signal});const rejected=assert.rejects(pending);
  const command=JSON.parse((await read)[0]);
  if(cancel)abort.abort();else send(ws,{...command,type:'expression_result',expression:'happy',status:'applied'});
  await rejected;assert.equal(connection.snapshot().phase,'closed');
 }
});

test('camera capability is optional and disabled response preserves the active audio session',async t=>{
 const f=await fixture(t),old=await f.connect();await start(old.ws,old.connection);
 await assert.rejects(old.connection.captureCamera(),{code:'camera-unsupported'});old.connection.close();await once(old.ws,'close');
 const {ws,connection}=await f.connect({hello:{camera:1}});await start(ws,connection);
 const received=once(ws,'message'),photo=connection.captureCamera();
 const request=JSON.parse((await received)[0]);assert.equal(request.type,'capture_camera');
 await assert.rejects(connection.captureCamera(),{code:'camera-busy'});
 send(ws,{type:'camera_error',boot_id:bootId,epoch:'1',request_id:request.request_id,code:'disabled'});
 await assert.rejects(photo,{code:'camera-disabled'});assert.equal(connection.snapshot().phase,'active');
 const reading=connection.readInput();ws.send(encodePcm({kind:1,epoch:1n,sequence:0n,pcm:Buffer.alloc(960)}));await reading;
});
test('camera cancellation after partial transfer discards bytes without completing a photo',async t=>{
 const f=await fixture(t),{ws,connection}=await f.connect({hello:{camera:1}});await start(ws,connection);
 let received=once(ws,'message');const photo=connection.captureCamera();const req=JSON.parse((await received)[0]);
 const identity={boot_id:bootId,epoch:'1',request_id:req.request_id};
 received=once(ws,'message');send(ws,{type:'camera_meta',...identity,bytes:'2000',width:'640',height:'480'});
 assert.equal(JSON.parse((await received)[0]).offset,'0');
 received=once(ws,'message');send(ws,{type:'camera_chunk',...identity,offset:'0',data:Buffer.alloc(1024).toString('base64')});
 assert.equal(JSON.parse((await received)[0]).offset,'1024');
 send(ws,{type:'camera_error',...identity,code:'cancelled'});await assert.rejects(photo,{code:'camera-cancelled'});
 assert.equal(connection.snapshot().phase,'active');assert.equal(connection.cameraRequest,null);
});
test('camera Stop rejects partial result and discards in-flight photo until resource acknowledgement',async t=>{
 const f=await fixture(t),{ws,connection}=await f.connect({hello:{camera:1}});await start(ws,connection);
 let received=once(ws,'message');const photo=connection.captureCamera();const req=JSON.parse((await received)[0]);
 const rejected=assert.rejects(photo,{code:'stopped'});
 received=once(ws,'message');const stopping=connection.stop();const stop=JSON.parse((await received)[0]);
 send(ws,{type:'camera_meta',boot_id:bootId,epoch:'1',request_id:req.request_id,bytes:'4',width:'1',height:'1'});
 send(ws,{type:'stopped',boot_id:bootId,epoch:'2',request_id:stop.request_id,resources_stopped:true});
 await rejected;assert.equal((await stopping).deviceIdle,true);assert.equal(connection.cameraRequest,null);
});
test('camera rejects wrong request correlation and tool Abort closes the connection',async t=>{
 for(const variant of ['request','epoch','boot','abort']){
  const child=await fixture(t),{ws,connection}=await child.connect({hello:{camera:1}});await start(ws,connection);
  const controller=new AbortController(),received=once(ws,'message'),photo=connection.captureCamera({signal:controller.signal});
  const reject=assert.rejects(photo);const req=JSON.parse((await received)[0]);
  if(variant==='abort')controller.abort();
  else send(ws,{type:'camera_meta',boot_id:variant==='boot'?'e'.repeat(32):bootId,epoch:variant==='epoch'?'3':'1',request_id:variant==='request'?'d'.repeat(32):req.request_id,bytes:'4',width:'1',height:'1'});
  await reject;assert.equal(connection.snapshot().phase,'closed');assert.equal(connection.cameraRequest,null);
 }
});

test('light ring version, RGB, cancellation and Stop are scoped to the active connection', async t => {
  const old = await fixture(t);
  const legacy = await old.connect();
  await start(legacy.ws, legacy.connection);
  await assert.rejects(legacy.connection.setRing({color:'#FF2300'}), {code:'ring-unsupported'});

  const fixtureV1 = await fixture(t);
  const {ws,connection} = await fixtureV1.connect({hello:{ring:1}});
  const epoch = await start(ws,connection);
  const state = {type:'ring_state',boot_id:bootId,epoch,permission:'allowed',phase:'lit',error:''};
  send(ws,state);
  for(let i=0;i<100&&!connection.ringReport;i++)await new Promise(resolve=>setTimeout(resolve,2));
  assert.equal(connection.ringSnapshot().phase,'lit');
  assert.equal(connection.ringSnapshot(connection.ringReport.receivedAt+6000).permission,'unknown');
  await assert.rejects(connection.setRing({color:'#FG0000'}),{code:'ring-invalid'});

  const abort=new AbortController();
  let incoming=once(ws,'message');
  const first=connection.setRing({color:'#FF2300',durationMs:250},{signal:abort.signal});
  const cancelled=assert.rejects(first,{code:'ring-cancelled'});
  const command=JSON.parse((await incoming)[0]);
  assert.equal(command.type,'set_ring');
  assert.equal(command.rgb,'ff2300');
  assert.equal(command.duration_ms,'250');
  await assert.rejects(connection.setRing({color:'#FFFFFF'}),{code:'ring-busy'});
  incoming=once(ws,'message');abort.abort();
  assert.equal(JSON.parse((await incoming)[0]).request_id,command.request_id);
  send(ws,{type:'ring_result',boot_id:bootId,epoch,request_id:command.request_id,code:'cancelled'});
  await cancelled;
  assert.equal(connection.snapshot().phase,'active');

  incoming=once(ws,'message');
  const next=assert.rejects(connection.setRing({color:'#FF2300'}),{code:'stopped'});
  const later=JSON.parse((await incoming)[0]);
  incoming=once(ws,'message');
  const stopping=connection.stop();
  const stop=JSON.parse((await incoming)[0]);
  send(ws,{type:'ring_result',boot_id:bootId,epoch,request_id:later.request_id,code:'completed'});
  const nextEpoch=String(BigInt(epoch)+1n);
  send(ws,{type:'stopped',boot_id:bootId,epoch:nextEpoch,request_id:stop.request_id,resources_stopped:true});
  await next;
  assert.equal((await stopping).deviceIdle,true);
  assert.equal(connection.ringSnapshot().permission,'unknown');
});

test('capability versions reflect the authenticated hello and disappear on disconnect',async t=>{
  const f=await fixture(t);
  const {ws,connection}=await f.connect({hello:{camera:1,ring:1,caption:1}});
  assert.deepEqual(connection.negotiatedCapabilities(),{active:false,captionRequested:true,versions:{
    audio:1,playbackFence:0,expression:0,camera:1,motion:0,ring:1,
  },inFlight:{camera:false,motion:false,ring:false}});
  await start(ws,connection);
  assert.equal(connection.negotiatedCapabilities().active,true);
  const done=once(connection,'disconnect');
  ws.close();
  await done;
  assert.equal(connection.negotiatedCapabilities(),null);
});


test('listener reports an occupied pair port without displacing the current owner', async t => {
  const existing = createAgentTransport({ pairing, deviceId });
  const waiting = createAgentTransport({ pairing, deviceId });
  t.after(async () => { await waiting.close(); await existing.close(); });
  const actual = await existing.listen({ host: '127.0.0.1', port: 0 });
  await assert.rejects(waiting.listen({ host: actual.address, port: actual.port }), { code: 'listen-port-in-use' });
  await assert.rejects(waiting.listen({ host: actual.address, port: 0 }), { code: 'already-started' });
});
test('a status line is sent only to faces that advertise caption 2', async t=>{
  const plain=await (await fixture(t)).connect({hello:{caption:1}});
  await start(plain.ws,plain.connection);
  assert.equal(plain.connection.sendCaption('status','思考中'),false);
  const {ws,connection}=await (await fixture(t)).connect({hello:{caption:2}});
  assert.equal(connection.captionRequested,true);
  await start(ws,connection);
  const received=once(ws,'message');
  assert.equal(connection.sendCaption('status','思考中'),true);
  const message=JSON.parse((await received)[0]);
  assert.equal(message.speaker,'status');
  assert.equal(Buffer.from(message.text_hex,'hex').toString(),'思考中');
});
