import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Duplex, PassThrough, Transform } from 'node:stream';
import { connect as connectTls } from 'node:tls';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { WebSocket } from 'ws';
import { createPairing } from '../src/pairing.mjs';
import { createAgentTransport } from '../src/agent-transport.mjs';
import { createVoiceDiagnostics, createVoiceDiagnosticStore } from '../src/voice-diagnostics.mjs';
import { AUDIO, decodePcm, encodePcm } from '../src/agent-protocol.mjs';
import { createAgentRelay, openAgentRelayStream } from '../src/agent-relay.mjs';
import { USB_AGENT_ALPN, USB_AGENT_CIPHER, USB_AGENT_PREAMBLE, RELAY_AGENT_ALPN, RELAY_AGENT_PREAMBLE,
  USB_STANDBY_PROBE, USB_STANDBY_READY, waitForUsbReady, usbTlsIdentity, relayTlsIdentity } from '../src/agent-usb-wire.mjs';

const deviceId = '123456abcdef';
const bootId = 'b'.repeat(32);
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
const waitClosed = stream => stream.closed ? Promise.resolve() : new Promise(resolve => stream.once('close', resolve));
let directory, pairing, relayIdentity;
test.before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'sion-agent-usb-'));
  createPairing(join(directory, 'pair'), 'wss://192.168.1.2:9080/audio');
  pairing = JSON.parse(await readFile(join(directory, 'pair', 'pairing.json'), 'utf8'));
  // Separate certificate authority from the appliance identity.
  const cert=join(directory,'relay.pem'),key=join(directory,'relay.key');
  execFileSync('openssl',['req','-new','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=localhost',
    '-addext','subjectAltName=DNS:localhost','-out',cert,'-keyout',key],{stdio:'ignore'});
  relayIdentity={cert:await readFile(cert),key:await readFile(key)};
});
test.after(() => rm(directory, { recursive: true, force: true }));

function endpointPair(t) {
  let preamble = false;
  const hostToDevice = new Transform({ transform(bytes, _encoding, write) {
    if (preamble) { write(null, bytes); return; }
    assert.equal(bytes.toString('ascii'), USB_AGENT_PREAMBLE);
    preamble = true;
    write();
  } });
  const deviceToHost = new PassThrough();
  const host = Duplex.from({ writable: hostToDevice, readable: deviceToHost });
  const device = Duplex.from({ writable: deviceToHost, readable: hostToDevice });
  for (const endpoint of [host, device]) endpoint.on('error', () => {});
  t.after(() => { host.destroy(); device.destroy(); });
  return { host, device };
}

function startClient(t, stream, { token = pairing.record.local_token, device = deviceId, alpn = USB_AGENT_ALPN, relay = false } = {}) {
  const credentials = (relay ? relayTlsIdentity : usbTlsIdentity)(device, pairing.record.pair_id, token);
  const client = connectTls({
    socket: stream, minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2', ciphers: USB_AGENT_CIPHER,
    ALPNProtocols: [alpn], pskCallback: () => credentials,
    // The only enabled ciphersuite requires the client and server to prove the PSK.
    rejectUnauthorized: false,
  });
  client.on('error', () => {});
  t.after(() => client.destroy());
  return client;
}

function frame(value) {
  const isBinary = Buffer.isBuffer(value);
  const payload = isBinary ? value : Buffer.from(JSON.stringify(value));
  const prefix = Buffer.from([isBinary ? 2 : 1, payload.length >> 8, payload.length & 255]);
  return Buffer.concat([prefix, payload]);
}

async function* readFrames(client) {
  let buffer = Buffer.alloc(0);
  for await (const data of client) {
    buffer = Buffer.concat([buffer, data]);
    while (buffer.length >= 3) {
      const size = buffer.readUInt16BE(1);
      assert.ok(size > 0 && size <= AUDIO.maxMessageBytes);
      if (buffer.length < size + 3) break;
      const kind = buffer[0];
      const body = buffer.subarray(3, size + 3);
      buffer = buffer.subarray(size + 3);
      if (kind === 1) yield JSON.parse(body);
      else if (kind === 2) yield body;
      else yield { kind, body };
    }
  }
}

function fixture(t, options = {}) {
  const transport = createAgentTransport({ pairing, deviceId, timeoutMs: 1500, heartbeatMs: 1000, ...options });
  t.after(() => transport.close());
  return transport;
}

function hello(overrides = {}) {
  return frame({ type: 'hello', protocol: 1, device_id: deviceId, pair_id: pairing.record.pair_id,
    boot_id: bootId, epoch: '0', phase: 'idle', playback_fence: 1, ...overrides });
}

test('USB burst keeps the control receipt and emits bounded, content-free capture diagnostics',
  { timeout: 6000 }, async t => {
    const samples = [];
    const voiceDiagnostics = createVoiceDiagnostics('usb', sample => samples.push(sample));
    const { client, connection } = await connected(t, fixture(t, { recoverInput: true, voiceDiagnostics }));
    const received = readFrames(client);
    const starting = connection.start();
    const { value: start } = await received.next();
    client.write(frame({ type: 'started', request_id: start.request_id, boot_id: bootId, epoch: '1' }));
    await starting;
    const output = connection.sendOutput(Buffer.alloc(480));
    await received.next();
    const capture = Array.from({ length: 64 }, (_, sequence) => frame(encodePcm({
      kind: 1, epoch: 1n, sequence: BigInt(sequence), pcm: Buffer.alloc(960, sequence),
    })));
    client.write(Buffer.concat([...capture, frame({ type: 'output', boot_id: bootId, epoch: '1', sequence: '0' })]));
    assert.equal((await output).accepted, true);
    assert.equal(connection.snapshot().phase, 'active');
    const { frames, generation } = await connection.readInputBatch();
    // A 640 ms burst is ordinary lateness: nothing is dropped.
    assert.equal(generation, 0);
    assert.deepEqual(frames.map(item => item.sequence), [0n, 1n, 2n, 3n]);
    // The device then skips six capture frames. The 60 queued ones retire with them.
    const second = connection.sendOutput(Buffer.alloc(480));
    await received.next();
    client.write(Buffer.concat([frame(encodePcm({ kind: 1, epoch: 1n, sequence: 70n, pcm: Buffer.alloc(960, 70) })),
      frame({ type: 'output', boot_id: bootId, epoch: '1', sequence: '1' })]));
    assert.equal((await second).accepted, true);
    const resumed = await connection.readInputBatch();
    assert.equal(resumed.generation, 1);
    assert.deepEqual(resumed.frames.map(item => item.sequence), [70n]);

    const stopping = connection.stop();
    const { value: stop } = await received.next();
    client.write(frame({ type: 'stopped', request_id: stop.request_id, boot_id: bootId,
      epoch: '2', resources_stopped: true }));
    assert.equal((await stopping).deviceIdle, true);
    assert.deepEqual(samples.map(sample => sample.event), ['capture-started', 'first-input-gap', 'capture-ended']);
    const last = samples.at(-1);
    assert.equal(last.outcome, 'stop-ack');
    assert.equal(last.inputFrames, 65);
    assert.equal(last.queueDepthMax, 64);
    assert.equal(last.droppedByCapacity, 0);
    assert.equal(last.droppedByDevice, 66);
    const logs = JSON.stringify(samples);
    for (const privateValue of [deviceId, bootId, pairing.record.pair_id, pairing.record.local_token, 'pcm'])
      assert.ok(!logs.includes(privateValue));
  });

test('voice traces rotate private files, survive reopening and reject a linked destination', async t => {
  const profile = await mkdtemp(join(tmpdir(), 'sion-diagnostic-profile-'));
  t.after(() => rm(profile, { recursive: true, force: true }));
  const diagnostics = join(profile, '.stackchan-diagnostics');
  const filename = join(diagnostics, 'voice.jsonl');
  const previous = join(diagnostics, 'voice.previous.jsonl');
  await mkdir(diagnostics, { mode: 0o700 });
  await writeFile(filename, Buffer.alloc(512 * 1024), { mode: 0o600 });
  let unavailable = 0;
  const openStore = () => createVoiceDiagnosticStore(profile, () => unavailable++);
  let store = openStore();
  store.write({ event: 'capture-started' });
  await store.flush();
  assert.equal((await lstat(previous)).size, 512 * 1024);
  assert.equal((await lstat(filename)).mode & 0o777, 0o600);
  store = openStore();
  store.write({ event: 'capture-ended' });
  await store.flush();
  const events = (await readFile(filename, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line).event);
  assert.deepEqual(events, ['capture-started', 'capture-ended']);
  await rm(filename);
  await symlink(previous, filename);
  store = openStore();
  store.write({ event: 'link-ended' });
  await store.flush();
  assert.equal(unavailable, 1);
  assert.equal((await lstat(previous)).size, 512 * 1024);
});

test('voice traces keep four older files, oldest dropped first', async t => {
  const profile = await mkdtemp(join(tmpdir(), 'sion-diagnostic-chain-'));
  t.after(() => rm(profile, { recursive: true, force: true }));
  const diagnostics = join(profile, '.stackchan-diagnostics');
  const filename = join(diagnostics, 'voice.jsonl');
  const older = n => join(diagnostics, n === 1 ? 'voice.previous.jsonl' : `voice.previous.${n}.jsonl`);
  await mkdir(diagnostics, { mode: 0o700 });
  for (let round = 1; round <= 6; round++) {
    await writeFile(filename, Buffer.alloc(512 * 1024, round), { mode: 0o600 });
    const store = createVoiceDiagnosticStore(profile, () => assert.fail('store unavailable'));
    store.write({ event: 'round' });
    await store.flush();
  }
  // Rounds 6, 5, 4, 3 are kept as .previous, .2, .3, .4; rounds 1 and 2 are gone.
  for (const [n, round] of [[1, 6], [2, 5], [3, 4], [4, 3]]) assert.equal((await readFile(older(n)))[0], round);
  await assert.rejects(lstat(join(diagnostics, 'voice.previous.5.jsonl')), { code: 'ENOENT' });
});

test('USB standby ignores ordinary bytes, accepts only an exact fragmented ready line and can be cancelled', async t => {
  const writes=[];
  const host = new Duplex({read(){},write(bytes,_encoding,done){writes.push(bytes.toString('ascii'));done();}});
  t.after(()=>host.destroy());
  const signal=new AbortController();
  const ready=waitForUsbReady(host,signal.signal);
  assert.deepEqual(writes,[USB_STANDBY_PROBE]);
  let resolved=false;
  ready.then(()=>{resolved=true;});
  host.push('xSIONU0 READY\nSIONU0 READY!\n');
  await nextTurn();
  assert.equal(resolved,false);
  host.push(USB_STANDBY_READY.slice(0,5));
  host.push(USB_STANDBY_READY.slice(5));
  await ready;
  const pending=waitForUsbReady(host,signal.signal);
  signal.abort();
  await assert.rejects(pending,{name:'AbortError'});
  assert.equal(host.listenerCount('readable'),0);
});

test('a listening USB standby writes nothing and resolves only on the ready line the firmware offers', async t => {
  let written = 0;
  const host = new Duplex({read(){},write(_bytes,_encoding,done){written++;done();}});
  t.after(()=>host.destroy());
  const ready = waitForUsbReady(host, new AbortController().signal, { listenOnly: true });
  let resolved = false;
  ready.then(()=>{resolved=true;});
  host.push('I (312) boot: factory log line\n');   // what another firmware might print
  await new Promise(resolve=>setTimeout(resolve,700));
  assert.equal(resolved,false); assert.equal(written,0);
  host.push(USB_STANDBY_READY);
  await ready;
  assert.equal(written,0);
});

test('ready lines still arriving before TLS are skipped up to the first TLS record', { timeout: 6000 }, async t => {
  const transport = fixture(t);
  const ports = endpointPair(t);
  const ready = transport.attachUsb(ports.host);
  // The firmware keeps offering its ready line until it sees the Host's first byte.
  ports.device.write(USB_STANDBY_READY + USB_STANDBY_READY.slice(1));
  const client = startClient(t, ports.device);
  await once(client, 'secureConnect');
  client.write(hello());
  const connection = await ready;
  assert.ok(connection);
});

async function connected(t, transport) {
  const ports = endpointPair(t);
  const ready = transport.attachUsb(ports.host);
  const client = startClient(t, ports.device);
  await once(client, 'secureConnect');
  const greeting = hello();
  for (const part of [greeting.subarray(0, 2), greeting.subarray(2, 8), greeting.subarray(8)]) {
    await new Promise((resolve, reject) => client.write(part, error => error ? reject(error) : resolve()));
  }
  return { client, connection: await ready, ports };
}

test('an authenticated idle USB connection can send TLS close before releasing the port', async t => {
  const transport=fixture(t);
  const {client,connection,ports}=await connected(t,transport);
  const end=once(client,'end',{signal:AbortSignal.timeout(1000)});
  client.resume();
  const closed=connection.close({graceful:true});
  await end;
  assert.equal(ports.host.closed,false);
  client.end();
  await closed;
  assert.equal(ports.host.closed,true);
  assert.equal(transport.connection,undefined);
});

test('encrypted USB stream runs split control, bidirectional PCM, drain and Stop through AgentConnection',
  { timeout: 6000 }, async t => {
    const transport = fixture(t);
    const { client, connection } = await connected(t, transport);
    assert.equal(client.getCipher().name, USB_AGENT_CIPHER);
    assert.equal(client.alpnProtocol, USB_AGENT_ALPN);
    assert.equal(transport.connection, connection);
    assert.equal(connection.snapshot().phase, 'idle');
    const received = readFrames(client);
    const starting = connection.start();
    const { value: start } = await received.next();
    assert.equal(start.type, 'start');
    client.write(Buffer.concat([
      frame({ type: 'started', request_id: start.request_id, boot_id: bootId, epoch: '1' }),
      frame(encodePcm({ kind: 1, epoch: 1n, sequence: 0n, pcm: Buffer.alloc(960, 17) })),
    ]));
    await starting;
    assert.deepEqual((await connection.readInput()).pcm, Buffer.alloc(960, 17));
    const output = connection.sendOutput(Buffer.alloc(480, 29));
    const { value: pcm } = await received.next();
    assert.deepEqual(decodePcm(pcm, 2).pcm, Buffer.alloc(480, 29));
    client.write(frame({ type: 'output', boot_id: bootId, epoch: '1', sequence: '0' }));
    await output;
    const draining = connection.drainOutput();
    const { value: drain } = await received.next();
    assert.equal(drain.type, 'drain_output');
    client.write(frame({ type: 'output_drained', request_id: drain.request_id, boot_id: bootId,
      epoch: '1', next_sequence: '1' }));
    await draining;
    const stopping = connection.stop();
    const { value: stop } = await received.next();
    assert.equal(stop.type, 'stop');
    client.write(frame({ type: 'stopped', request_id: stop.request_id, boot_id: bootId,
      epoch: '2', resources_stopped: true }));
    assert.equal((await stopping).deviceIdle, true);
  });

test('a burst of 32 USB capture frames keeps its order and can still stop', { timeout: 6000 }, async t => {
  const { client, connection } = await connected(t, fixture(t));
  const received = readFrames(client);
  const starting = connection.start();
  const { value: start } = await received.next();
  client.write(frame({ type: 'started', request_id: start.request_id, boot_id: bootId, epoch: '1' }));
  await starting;

  const output = connection.sendOutput(Buffer.alloc(480));
  await received.next();
  const capture = Array.from({ length: 32 }, (_, sequence) => encodePcm({
    kind: 1, epoch: 1n, sequence: BigInt(sequence), pcm: Buffer.alloc(960, sequence),
  }));
  // The receipt is ordered behind the burst. There is no pending input reader yet.
  client.write(Buffer.concat([...capture.map(frame), frame({ type: 'output', boot_id: bootId, epoch: '1', sequence: '0' })]));
  await output;
  for (const [sequence, encoded] of capture.entries()) {
    const { sequence: receivedSequence, pcm } = await connection.readInput();
    assert.equal(receivedSequence, BigInt(sequence));
    assert.deepEqual(pcm, decodePcm(encoded, 1).pcm);
  }

  const stopping = connection.stop();
  const { value: stop } = await received.next();
  assert.equal(stop.type, 'stop');
  client.write(frame({ type: 'stopped', request_id: stop.request_id, boot_id: bootId, epoch: '2', resources_stopped: true }));
  assert.equal((await stopping).deviceIdle, true);
});

test('wrong USB PSK, device, protocol or Agent hello never publishes a connection', { timeout: 6000 }, async t => {
  const transport = fixture(t);
  for (const overrides of [{ token: 'fa'.repeat(32) }, { device: 'abcdef123456' }, { alpn: 'lan' }, {}]) {
    const ports = endpointPair(t);
    const mismatchedHello = Object.keys(overrides).length === 0;
    const rejected = assert.rejects(transport.attachUsb(ports.host), {
      code: mismatchedHello ? 'protocol-invalid' : 'disconnected',
    });
    const client = startClient(t, ports.device, overrides);
    client.once('secureConnect', () => client.write(hello({ device_id: 'abcdef123456' })));
    await rejected;
    await waitClosed(ports.host);
    assert.equal(transport.connection, undefined);
  }
});

test('the USB idle lease is renewed in TLS without issuing an audio command', { timeout: 6000 }, async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { client, connection } = await connected(t, fixture(t));
  t.mock.timers.tick(4000);
  const { value } = await readFrames(client).next();
  assert.deepEqual(value, { kind: 3, body: Buffer.of(0) });
  assert.equal(connection.snapshot().phase, 'idle');
});

test('invalid frames, unplug and unauthenticated hello timeout release the USB stream', { timeout: 6000 }, async t => {
  const transport = fixture(t, { timeoutMs: 350, heartbeatMs: 100 });
  const silent = endpointPair(t);
  await assert.rejects(transport.attachUsb(silent.host), { code: 'hello-timeout' });
  assert.equal(silent.host.destroyed, true);
  await waitClosed(silent.host);
  for (const action of ['invalid frame', 'unplug']) {
    const { client, connection, ports } = await connected(t, transport);
    const disconnected = once(connection, 'disconnect');
    if (action === 'unplug') ports.host.destroy();
    else client.write(Buffer.from([2, 8, 1])); // 2049 bytes is rejected from the header alone.
    await disconnected;
    await waitClosed(ports.host);
    assert.equal(transport.connection, undefined);
    assert.equal(connection.snapshot().phase, 'closed');
  }
});

test('USB and LAN share one owner and cannot evict each other', { timeout: 6000 }, async t => {
  const transport = fixture(t);
  const { port } = await transport.listen({ host: '127.0.0.1', port: 0 });
  const lan = () => {
    const socket = new WebSocket(`wss://127.0.0.1:${port}/audio`, 'sion-agent-v1', {
      ca: pairing.record.ca, servername: 'sion-host', headers: {
        Authorization: `Bearer ${pairing.record.local_token}`,
        'X-Sion-Pair-Id': pairing.record.pair_id, 'X-Sion-Device-Id': deviceId,
      },
    });
    socket.on('error', () => {});
    t.after(() => socket.terminate());
    return socket;
  };
  const usb = await connected(t, transport);
  await assert.rejects(once(lan(), 'open'), /409/);
  assert.equal(transport.connection, usb.connection);
  usb.connection.close();
  await waitClosed(usb.ports.host);
  const socket = lan();
  await once(socket, 'open');
  const online = once(transport.events, 'connection');
  socket.send(hello().subarray(3), { binary: false });
  const [connection] = await online;
  const candidate = endpointPair(t);
  await assert.rejects(transport.attachUsb(candidate.host), { code: 'connection-busy' });
  assert.equal(candidate.host.destroyed, false);
  assert.equal(transport.connection, connection);
});

test('USB teardown retains ownership until the stream handle actually closes', { timeout: 6000 }, async t => {
  const transport = fixture(t, { timeoutMs: 75, heartbeatMs: 25 });
  let closed;
  const stream = new Duplex({ read() {}, write(_bytes, _encoding, callback) { callback(); },
    destroy(_error, callback) { closed = callback; } });
  try {
    await assert.rejects(transport.attachUsb(stream), { code: 'hello-timeout' });
    assert.equal(stream.closed, false);
    const candidate = endpointPair(t);
    await assert.rejects(transport.attachUsb(candidate.host), { code: 'connection-busy' });
    let transportClosed = false;
    const shutdown = transport.close().then(() => { transportClosed = true; });
    await nextTurn();
    assert.equal(transportClosed, false);
    closed();
    await shutdown;
    assert.equal(stream.closed, true);
  } finally { if (!stream.closed) closed?.(); }
});

async function relayFixture(t,{waitMs=3000}={}) {
  const roomId='a'.repeat(32),hostToken='1'.repeat(64),deviceToken='2'.repeat(64);
  const digest=token=>createHash('sha256').update(token,'ascii').digest('hex');
  const room={roomId,hostTokenSha256:digest(hostToken),deviceTokenSha256:digest(deviceToken)};
  const server=createAgentRelay({...relayIdentity,rooms:[room],waitMs});
  t.after(()=>server.close());
  const {port}=await server.listen();
  const common={endpoint:`wss://localhost:${port}`,roomId,ca:relayIdentity.cert,timeoutMs:2500};
  return { server,host:{...common,token:hostToken},device:{...common,token:deviceToken,role:'device'} };
}

async function relayPeer(t, config, options={}) {
  const device=await openAgentRelayStream(config);
  t.after(()=>device.destroy());
  const [preamble]=await once(device,'data');
  assert.equal(preamble.toString(),RELAY_AGENT_PREAMBLE);
  return {device,client:startClient(t,device,{alpn:RELAY_AGENT_ALPN,relay:true,...options})};
}

test('relay routes authenticated audio, captions and Stop with no Mac listener', {timeout:8000},async t=>{
  const relay=await relayFixture(t);
  const transport=fixture(t);
  const request=new AbortController();
  const ready=transport.attachRelay({...relay.host,signal:request.signal});
  ready.catch(()=>{});
  const usb=endpointPair(t);
  await assert.rejects(transport.attachUsb(usb.host),{code:'connection-busy'});
  const {device,client}=await relayPeer(t,relay.device);
  await once(client,'secureConnect');
  assert.equal(client.alpnProtocol,RELAY_AGENT_ALPN);
  client.write(hello({caption:1}));
  const connection=await ready;
  request.abort(); // The initiating UI request no longer owns the authenticated stream.
  await assert.rejects(openAgentRelayStream(relay.device),{code:'relay-connection-failed'});
  assert.equal(transport.connection,connection);
  const received=readFrames(client);
  const starting=connection.start();
  const {value:start}=await received.next();
  assert.equal(start.type,'start');
  client.write(Buffer.concat([
    frame({type:'started',request_id:start.request_id,boot_id:bootId,epoch:'1'}),
    frame(encodePcm({kind:1,epoch:1n,sequence:0n,pcm:Buffer.alloc(960,41)})),
  ]));
  await starting;
  assert.deepEqual((await connection.readInput()).pcm,Buffer.alloc(960,41));
  assert.equal(connection.sendCaption('user','你好，Sion'),true);
  const {value:caption}=await received.next();
  assert.equal(caption.type,'caption');
  assert.equal(Buffer.from(caption.text_hex,'hex').toString(),'你好，Sion');
  const audio=connection.sendOutput(Buffer.alloc(480,26));
  const {value:pcm}=await received.next();
  assert.deepEqual(decodePcm(pcm,2).pcm,Buffer.alloc(480,26));
  client.write(frame({type:'output',boot_id:bootId,epoch:'1',sequence:'0'}));
  await audio;
  const stopping=connection.stop();
  const {value:stop}=await received.next();
  assert.equal(stop.type,'stop');
  client.write(frame({type:'stopped',request_id:stop.request_id,boot_id:bootId,epoch:'2',resources_stopped:true}));
  assert.equal((await stopping).deviceIdle,true);
  const offline=once(transport.events,'disconnect');
  device.destroy();await offline;
  assert.equal(transport.connection,undefined);
});

test('relay credentials, server name and fresh paired PSK are verified separately', {timeout:8000},async t=>{
  const relay=await relayFixture(t);
  await assert.rejects(openAgentRelayStream({...relay.device,token:relay.host.token}),{code:'relay-connection-failed'});
  await assert.rejects(openAgentRelayStream({...relay.device,endpoint:relay.device.endpoint.replace('localhost','127.0.0.1')}),{code:'relay-connection-failed'});
  const transport=fixture(t);
  for(const incompatible of [{token:'ab'.repeat(32)},{relay:false}]){
    const rejected=assert.rejects(transport.attachRelay(relay.host),{code:'disconnected'});
    const {client,device}=await relayPeer(t,relay.device,incompatible);
    client.once('secureConnect',()=>client.write(hello()));
    await rejected;await waitClosed(device);
    assert.equal(transport.connection,undefined);
  }
  const ready=transport.attachRelay(relay.host);
  ready.catch(()=>{});
  const {client}=await relayPeer(t,relay.device);
  await once(client,'secureConnect');client.write(hello({boot_id:'c'.repeat(32),epoch:'0'}));
  assert.equal((await ready).snapshot().bootId,'c'.repeat(32));
});

test('pending rendezvous is cancelled by shutdown and an unpaired socket expires', {timeout:5000},async t=>{
  const relay=await relayFixture(t,{waitMs:700});
  const transport=fixture(t);
  const pending=assert.rejects(transport.attachRelay(relay.host),{code:'relay-cancelled'});
  await transport.close();
  await pending;
  await assert.rejects(openAgentRelayStream(relay.device),{code:'relay-closed'});
});
