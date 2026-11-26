// Opt-in rehearsal with an isolated DSH Web profile, local speech, and fixture device/model.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { dirname, join, resolve, sep } from 'node:path';
import { networkInterfaces, tmpdir } from 'node:os';
import { createServer as createTcpServer } from 'node:net';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { constants } from 'node:fs';
import { cp, lstat, mkdtemp, writeFile, readFile, mkdir, realpath, rm, symlink } from 'node:fs/promises';
import { EventEmitter, once } from 'node:events';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import sharp from 'sharp';
import { Duplex, PassThrough, Transform } from 'node:stream';
import { connect as connectTls } from 'node:tls';
import { KokoroBackend } from '../src/local-speech.mjs';
import { AUDIO, CAMERA, encodePcm, decodePcm } from '../src/agent-protocol.mjs';
import { randomUUID } from 'node:crypto';
import { execFileSync, fork, spawn } from 'node:child_process';
import { createAgentRelay, openAgentRelayStream } from '../src/agent-relay.mjs';
import { relayConfigName } from '../src/agent-relay-config.mjs';
import { prepareAgentRelay } from './prepare_agent_relay.mjs';
import { exerciseCppDevice } from './test_dsh_native_device.mjs';
import { createUsbTrialCut } from './usb_trial_control.mjs';
import { USB_AGENT_ALPN, USB_AGENT_CIPHER, USB_AGENT_PREAMBLE, RELAY_AGENT_ALPN, RELAY_AGENT_PREAMBLE,
  USB_STANDBY_PROBE, USB_STANDBY_READY, usbTlsIdentity, relayTlsIdentity } from '../src/agent-usb-wire.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
const root = join(repository, '.local');
const dshDirectory = process.argv[2];
assert.ok(dshDirectory, 'Pass an npm prefix or the bundled DSH runtime directory');
const expectedDshVersion = process.argv.find(arg => arg.startsWith('--dsh-version='))?.slice('--dsh-version='.length) ?? '0.2.2-rc.3';
const usbPty = process.argv.includes('--usb-pty');
const cppDeviceOption = process.argv.find(arg => arg.startsWith('--cpp-device='));
const cppDevice = cppDeviceOption && resolve(cppDeviceOption.slice('--cpp-device='.length));
const cppFirstFrameStop = process.argv.includes('--cpp-first-frame-stop');
const usbStandby = process.argv.includes('--usb-standby');
const pairingProbeOption = process.argv.find(arg => arg.startsWith('--pair-through-pty='));
const pairingProbe = pairingProbeOption ? resolve(pairingProbeOption.slice('--pair-through-pty='.length)) : null;
const identifyUsbDevice = process.argv.includes('--identify-device');
const noLanPairing = process.argv.includes('--no-lan-pairing');
const wired = process.argv.includes('--usb') || usbPty;
const relayed = process.argv.includes('--relay');
const lanInterface = process.argv.find(arg => arg.startsWith('--lan-interface='))?.slice('--lan-interface='.length);
const installedLan = lanInterface !== undefined;
const slowStream = process.argv.includes('--slow-stream');
const previewEnabled = !process.argv.includes('--no-preview');
const packageOption = process.argv.find(arg => arg.startsWith('--package='));
const tarball = packageOption ? resolve(packageOption.slice('--package='.length)) : null;
const managedOption = process.argv.find(arg => arg.startsWith('--managed-from='));
const managedFrom = managedOption ? resolve(managedOption.slice('--managed-from='.length)) : null;
const checkVoicePreview = process.argv.includes('--check-voice-preview');
const waitOption = process.argv.find(arg => arg.startsWith('--wait-before-connect='));
const waitBeforeConnect = waitOption ? Number(waitOption.slice('--wait-before-connect='.length)) : 0;
assert.ok(!waitOption || (managedFrom && Number.isInteger(waitBeforeConnect) && waitBeforeConnect >= 0 && waitBeforeConnect <= 25000),
  'Use --wait-before-connect=<0–25000 ms> with --managed-from');
const upgradeOption = process.argv.find(arg => arg.startsWith('--upgrade-from='));
const upgradeFrom = upgradeOption ? resolve(upgradeOption.slice('--upgrade-from='.length)) : null;
const capabilities = process.argv.includes('--capabilities');
const headTouchV40 = process.argv.includes('--head-touch-v40');
const reconnect = process.argv.includes('--reconnect');
const relayStandby = process.argv.includes('--relay-standby');
const lanStandby = process.argv.includes('--lan-standby');
const automatic = relayStandby || lanStandby;
const standbyField = lanStandby ? 'lanStandby' : 'relayStandby';
const captionOnlyTest = process.argv.includes('--caption-only');
const checkConversationReport = process.argv.includes('--check-conversation-report');
const longConversation = process.argv.includes('--long-conversation');
const oversizedReply = process.argv.includes('--oversized-reply');
const sessionSwitch = process.argv.includes('--switch-session');
const latencyLogs = process.argv.includes('--latency-logs');
const voiceTrace = process.argv.includes('--voice-trace');
const hostUsbCut = process.argv.includes('--host-usb-cut');
const standbyTtsCheck = process.argv.find(arg=>arg.startsWith('--standby-tts-check='))?.split('=')[1];
const latencyView = process.argv.includes('--latency-view');
const liveDisable = process.argv.includes('--live-disable');
const profileRecovery = process.argv.includes('--profile-recovery');
const photoOption = process.argv.find(arg => arg.startsWith('--model-photo='));
const photoMode = photoOption?.slice('--model-photo='.length);
assert.ok(!tarball || tarball.endsWith('.tgz'), 'Pass --package=/path/to/dsh-stackchan-0.1.0.tgz');
assert.ok(!cppFirstFrameStop || (cppDevice && !photoOption), 'Use --cpp-first-frame-stop with the C++ voice-only rehearsal');
assert.ok(!cppDevice || (capabilities && (relayed || usbPty || installedLan) && !usbStandby && tarball && !automatic && !reconnect &&
  !slowStream && !longConversation && !sessionSwitch && !latencyView && !liveDisable),
  'Use --cpp-device=<C++ peer> with the installed manual LAN, relay or USB PTY service');
assert.ok(!capabilities || (tarball && (relayed || usbPty || installedLan) && previewEnabled), 'Use --capabilities with --package and --relay, --usb-pty or --lan-interface=<name>, with production speech');
assert.ok(!headTouchV40 || capabilities, 'Use --head-touch-v40 with --capabilities');
assert.ok(!managedFrom || capabilities, 'Use --managed-from=<isolated fixture profile> with --capabilities');
assert.ok(!checkVoicePreview || managedFrom, 'Use --check-voice-preview with --managed-from');
assert.ok(!installedLan || (capabilities && lanInterface), 'Use --lan-interface=<name> with --capabilities');
assert.ok(!usbPty || (capabilities && !reconnect && (!photoOption || cppDevice)),
  'Use --usb-pty with --capabilities and the default fixture model or the C++ camera peer');
assert.ok(!usbStandby || (usbPty && !headTouchV40 && !liveDisable && !longConversation && !sessionSwitch),
  'Use --usb-standby with the normal --usb-pty capabilities rehearsal');
assert.ok(!pairingProbe || usbPty, 'Use --pair-through-pty=<compiled C++ pairing probe> with --usb-pty');
assert.ok(!identifyUsbDevice || pairingProbe, 'Use --identify-device with --pair-through-pty');
assert.ok(!noLanPairing || pairingProbe, 'Use --no-lan-pairing with --pair-through-pty and v50 firmware sources');
assert.ok(!photoOption || (capabilities && ['vision', 'text'].includes(photoMode)), 'Use --model-photo=vision or --model-photo=text with --capabilities');
assert.ok(!reconnect || (capabilities && !photoOption && !slowStream), 'Use --reconnect with --capabilities and the default fixture model');
assert.ok(!relayStandby || (relayed && reconnect), 'Use --relay-standby with --relay and --reconnect');
assert.ok(!lanStandby || (installedLan && reconnect), 'Use --lan-standby with --lan-interface and --reconnect');
assert.ok(!captionOnlyTest || (relayStandby && !latencyLogs), 'Use --caption-only with --relay-standby and no latency logs');
assert.ok(!checkConversationReport || captionOnlyTest, 'Use --check-conversation-report with --caption-only');
assert.ok(!longConversation || (capabilities && !automatic && !photoMode && !slowStream),
  'Use --long-conversation with the installed service, default fixture model, and manual connect');
assert.ok(!oversizedReply || longConversation, 'Use --oversized-reply with --long-conversation');
assert.ok(!sessionSwitch || (capabilities && !automatic && !photoMode && !slowStream),
  'Use --switch-session with the installed service, default fixture model, and manual connect');
assert.ok(!latencyLogs || capabilities, 'Use --latency-logs with the installed service via --capabilities');
assert.ok(!voiceTrace || usbStandby, 'Use --voice-trace with the installed USB standby service');
assert.ok(!hostUsbCut || (voiceTrace && managedFrom), 'Use --host-usb-cut with the installed trace and managed voice');
assert.ok(standbyTtsCheck===undefined||(usbStandby&&managedFrom&&latencyLogs&&['cold','retained'].includes(standbyTtsCheck)),
  'Use --standby-tts-check=cold|retained with USB standby, managed voice and latency logs');
assert.ok(!latencyView || capabilities, 'Use --latency-view with the installed service via --capabilities');
assert.ok(!upgradeFrom || (capabilities && latencyView && upgradeFrom.endsWith('.tgz') && upgradeFrom !== tarball),
  'Use --upgrade-from=<older tarball> with --capabilities, --latency-view and a separate --package');
assert.ok(!liveDisable || (usbPty && managedFrom && !latencyView && !latencyLogs && !sessionSwitch && !slowStream),
  'Use --live-disable with --usb-pty and --managed-from, without latency, session-switch, or slow-stream flags');
assert.ok(!profileRecovery || (installedLan && !lanStandby && managedFrom && !sessionSwitch && !slowStream && !photoMode),
  'Use --profile-recovery with the installed LAN service and managed voice, without session-switch, slow-stream, or photo flags');
assert.ok(previewEnabled || slowStream, 'The comparison requires --slow-stream');
assert.ok(Number(wired)+Number(relayed)+Number(installedLan)<=1,'Choose one rehearsal transport');
const fixturePort = '/dev/cu.usbmodemfixture';
const fromDsh = createRequire(join(resolve(dshDirectory), 'package.json'));
const dshManifest = fromDsh.resolve('@deepseek-ai/dsh/package.json');
const dshPackage = JSON.parse(await readFile(dshManifest, 'utf8'));
assert.equal(dshPackage.version, expectedDshVersion);
const importDsh = name => import(pathToFileURL(fromDsh.resolve(name)).href);
await mkdir(root,{recursive:true,mode:0o700});
// An ancestor package named dsh-stackchan would let Node resolve this checkout
// instead of the bundle installed in the isolated DSH profile.
const directory = await mkdtemp(join(await realpath(tmpdir()), 'sion-dsh-native-rehearsal-'));
const ptyFixture = fileURLToPath(new URL('./test_dsh_native_voice_usb_pty.py', import.meta.url));
const ptyState = join(directory, 'usb-pty');
const workspace = join(directory, 'workspace');
await mkdir(workspace);
const pairingDir = join(directory, 'pairing');
const installation = { python: join(root,'voice-dev/venv/bin/python'), assetsDirectory: join(root,'voice-dev/assets'),
  audioDirectory: join(root,'audio-vqe-dev'), whisperBinary: resolve(root,'../work/whisper-v1.9.5/build-sion/bin/whisper-cli'),
  temporaryDirectory: join(directory,'utterances') };
process.chdir(workspace);
process.env.DSH_HOME = join(directory, 'dsh');
process.env.DSH_TELEMETRY_MODE = 'DISABLED';
const { createLaunchEnvironmentSnapshot } = await importDsh('@deepseek-ai/dsh-launch-environment');
const { loadProfileDirectory } = await importDsh('@deepseek-ai/dsh-app-boot');
const { initializeProfileFromDefault, runProfile } = await importDsh('@deepseek-ai/dsh/profile-boot');
const profile = 'sion-voice-fixture';
const sessionId = 'session-' + randomUUID();
const deviceId='123456abcdef';
const model = photoMode === 'vision' ? 'deepseek-flash' : photoMode === 'text' ? 'deepseek-v4-pro' : 'local-voice-test';
const defaultModel = photoMode === 'vision' ? 'deepseek-v4-pro' : photoMode === 'text' ? 'deepseek-flash' : model;
const desktopSeed = 'This conversation already has desktop context.';
const selectedPreferences = { sessionId, asrBackend: 'whisper.cpp', ttsBackend: 'kokoro', language: 'zh',
  ...(latencyView ? { measureLatency: true } : {}),
  ...(wired ? { transport: 'usb', usbPort: fixturePort } : { transport: relayed ? 'relay' : 'lan' }) };

function manageBundle(operation, value, ...flags) {
  const executable = join(dirname(dshManifest), dshPackage.bin.dsh);
  execFileSync(process.execPath, [executable, 'plugin', '--profile', profile, operation, value, ...flags], {
    cwd: directory, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 90000,
    env: { PATH: process.env.PATH, DSH_HOME: process.env.DSH_HOME, DSH_TELEMETRY_MODE: 'DISABLED', CI: '1',
      // Keep the Desktop-bundled executable in CLI mode for its child invocations.
      ...(process.env.ELECTRON_RUN_AS_NODE === '1' ? { ELECTRON_RUN_AS_NODE: '1' } : {}) },
  });
}
async function copyManagedVoice(profileDir) {
  const source = join(managedFrom, '.stackchan-voice');
  const destination = join(profileDir, '.stackchan-voice');
  await mkdir(destination, {mode: 0o700});
  let copied = false;
  for (const [name, version] of [['active.json', 1], ['active-whisper-worker.json', 2], ['active-aec-v12.json', 3]]) {
    const pointer = await readFile(join(source, name)).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (!pointer) continue;
    const value = JSON.parse(pointer);
    assert.equal(value.version, version);
    assert.match(value.generation, /^[a-f0-9]{32}$/u);
    const original = join(source, value.generation);
    const copy = join(destination, value.generation);
    // Preserve timestamps for Python's .pyc cache. macOS cp can clone the
    // entire directory on APFS instead of allocating a copy of each model.
    if (process.platform === 'darwin') {
      await assert.rejects(lstat(copy), { code: 'ENOENT' });
      execFileSync('/bin/cp', ['-cRpP', original, copy], { timeout: 90000 });
    } else {
      await cp(original, copy, {
        recursive: true, verbatimSymlinks: true, preserveTimestamps: true,
        mode: constants.COPYFILE_FICLONE, errorOnExist: true, force: false,
      });
    }
    await writeFile(join(destination, name), pointer, {flag: 'wx', mode: 0o600});
    copied = true;
  }
  assert.ok(copied, 'The managed rehearsal requires a published voice environment');
}

function framePeer(peer,client) {
  peer.send = value => {
    const binary=Buffer.isBuffer(value);
    const bytes=binary?value:Buffer.from(value);
    client.write(Buffer.concat([Buffer.of(binary?2:1,bytes.length>>8,bytes.length&255),bytes]));
  };
  let buffer=Buffer.alloc(0);
  client.on('data',chunk=>{
    buffer=Buffer.concat([buffer,chunk]);
    while(buffer.length>=3){
      const type=buffer[0],size=buffer.readUInt16BE(1);
      if(buffer.length<3+size)break;
      const body=buffer.subarray(3,3+size);buffer=buffer.subarray(3+size);
      if(type===3){assert.deepEqual(body,Buffer.of(0));continue;}
      peer.emit('message',body,type===2);
    }
  });
}
function usbDevice(record) {
  let preamble = true;
  const hostToDevice = new Transform({ transform(bytes, encoding, callback) {
    if (!preamble) { callback(null, bytes); return; }
    preamble = false;
    if (bytes.toString('ascii') !== USB_AGENT_PREAMBLE) callback(new Error('Missing USB preamble'));
    else callback();
  } });
  const deviceToHost = new PassThrough();
  const host = Duplex.from({ writable: hostToDevice, readable: deviceToHost });
  const device = Duplex.from({ writable: deviceToHost, readable: hostToDevice });
  for (const stream of [host,device]) stream.on('error', ()=>{});
  const closed = new Promise(resolve => host.once('close',resolve));
  let client;
  const peer = new EventEmitter();
  peer.terminate = () => { client?.destroy(); device.destroy(); host.destroy(); };
  let handshake;
  const secure = new Promise((resolve,reject)=>{ handshake={resolve,reject}; });
  secure.catch(()=>{});
  return { peer, secure, open(port) {
    assert.equal(port,fixturePort);
    assert.equal(client,undefined);
    const credentials = usbTlsIdentity(deviceId,record.pair_id,record.local_token);
    client = connectTls({ socket:device,minVersion:'TLSv1.2',maxVersion:'TLSv1.2',ciphers:USB_AGENT_CIPHER,
      pskCallback:()=>credentials,rejectUnauthorized:false,ALPNProtocols:[USB_AGENT_ALPN] });
    client.on('error',handshake.reject);
    client.once('secureConnect',handshake.resolve);
    framePeer(peer,client);
    return {stream:host,ready:Promise.resolve(),close(){host.destroy();return closed;}};
  } };
}

async function pairThroughUsbPty(ctx, localUrl) {
  const state = ptyState+'.pairing';
  const captured = join(directory, 'committed-device-identity.json');
  const child = spawn(installation.python, [ptyFixture, 'pairing', state, pairingProbe, deviceId, captured],
    {stdio: ['pipe', 'ignore', 'inherit', 'pipe']});
  const status = child.stdio[3];
  const closed = new Promise(resolve => child.once('close', resolve));
  child.on('error', error => status.destroy(error));
  child.stdin.on('error', () => {});
  try {
    let ready='';
    status.setEncoding('ascii');status.on('data', value => { ready += value; });
    await once(status, 'end', {signal: AbortSignal.timeout(3000)});
    assert.equal(ready, 'ready\n');
    const invoke = (method,args) => ctx.typertGateway.invoke({
      namespace: 'stackchanPairing', method, args,
      peer: {id: 'pairing-fixture-owner', ctx, principal: {kind: 'owner'}, signal: AbortSignal.timeout(15000), interactions: 'none'},
    });
    const execute = request => invoke('execute',{request});
    const empty = await execute({action:'snapshot'});
    assert.equal(empty.activePairId, '');
    let pairingDeviceId = deviceId;
    if (identifyUsbDevice) {
      const identified = await invoke('identify',{port:fixturePort});
      assert.deepEqual(identified, {deviceId});
      assert.deepEqual(await execute({action:'snapshot'}), empty);
      pairingDeviceId = identified.deviceId;
      console.log('Installed owner Pairing Remote read the C++ device number over USB without changing the pairing journal.');
    }
    const prepared = await execute({action:'prepare', revision:empty.revision, deviceId:pairingDeviceId, localUrl});
    assert.equal(prepared.activePairId, '');
    assert.match(prepared.candidatePairId, /^[a-f0-9]{32}$/u);
    const serial = {deviceId, port:fixturePort, authorizeUsb:true};
    const bounced = {code:'stackchan/pairing-failed'};
    await assert.rejects(execute({action:'install', revision:prepared.revision, ...serial}), bounced);
    const pending = await execute({action:'snapshot'});
    assert.equal(pending.pending, 'install');
    assert.equal(pending.activePairId, '');
    assert.equal(pending.candidatePairId, prepared.candidatePairId);
    const beforeRetry = await readFile(join(pairingDir,'state.json'));
    await assert.rejects(execute({action:'install', revision:pending.revision, ...serial}), bounced);
    assert.deepEqual(await readFile(join(pairingDir,'state.json')), beforeRetry);
    const reconciled = await execute({action:'inspect', revision:pending.revision, ...serial});
    assert.equal(reconciled.pending, '');
    assert.equal(reconciled.candidatePairId, '');
    assert.equal(reconciled.activePairId, prepared.candidatePairId);
    assert.deepEqual(reconciled.observed, {state:'paired',pairId:prepared.candidatePairId});
    assert.equal(reconciled.connected, false);
    const record = JSON.parse(await readFile(captured, 'utf8'));
    assert.equal(record.pair_id, reconciled.activePairId);
    assert.equal(record.local_url, localUrl);
    child.stdin.end();
    assert.equal(await closed, 0);
    console.log('Installed owner Pairing Remote reconciled the C++ device write over pySerial after a lost acknowledgement. A retry did not replay the mutation.');
    return {record};
  } finally {
    child.stdin.end();
    if (child.exitCode === null) child.kill();
    await closed;
    await rm(state, {force:true});
  }
}

async function startUsbPty(record, {standby=false}={}) {
  await rm(ptyState,{force:true});
  const child=spawn(installation.python,[ptyFixture,'bridge',ptyState],{stdio:['pipe','pipe','inherit','pipe']});
  const closed=new Promise(resolve=>child.once('close',resolve));
  let client;
  let tapped=false, announced=false;
  const probed=Promise.withResolvers(), ended=Promise.withResolvers();
  const peer=new EventEmitter();
  const status=child.stdio[3];
  const stream=Duplex.from({writable:child.stdin,readable:child.stdout});
  stream.on('error',()=>{});
  child.on('error',error=>status.destroy(error));
  peer.terminate=()=>{client?.destroy();stream.destroy();child.kill();return closed;};
  try {
    let reply='';
    status.setEncoding('ascii');status.on('data',value=>{reply+=value;});
    await once(status,'end',{signal:AbortSignal.timeout(3000)});
    assert.equal(reply,'ready\n');
  }catch(error){await peer.terminate();throw new Error('USB PTY bridge did not open its test terminal',{cause:error});}
  const secure=(async()=>{
    const prefix=Buffer.from(USB_AGENT_PREAMBLE,'ascii');
    const signal=AbortSignal.timeout(8000);
    for(;;){
      let bytes;
      while(!(bytes=stream.read(prefix.length))){
        assert.ok(!stream.destroyed&&!stream.readableEnded,'PTY closed before the USB preamble');
        await once(stream,'readable',{signal});
      }
      if(standby&&bytes.toString('ascii')===USB_STANDBY_PROBE){
        probed.resolve();
        if(tapped&&!announced){announced=true;stream.write(USB_STANDBY_READY,'ascii');}
        continue;
      }
      assert.deepEqual(bytes,prefix);
      if(standby)assert.ok(announced,'USB attempted TLS before a device touch');
      break;
    }
    const credentials=usbTlsIdentity(deviceId,record.pair_id,record.local_token);
    client=connectTls({socket:stream,minVersion:'TLSv1.2',maxVersion:'TLSv1.2',ciphers:USB_AGENT_CIPHER,
      pskCallback:()=>credentials,rejectUnauthorized:false,ALPNProtocols:[USB_AGENT_ALPN]});
    client.on('error',()=>{});
    client.once('end',ended.resolve);
    framePeer(peer,client);
    await once(client,'secureConnect',{signal});
    assert.equal(client.alpnProtocol,USB_AGENT_ALPN);
  })().catch(error=>{throw new Error('USB PTY device did not receive the preamble and complete TLS',{cause:error});});
  secure.catch(()=>{});
  return {peer,secure,closed,probed:probed.promise,ended:ended.promise,tap(){tapped=true;}};
}
async function makeRelay(pairId) {
  const certFile=join(directory,'relay.pem'),keyFile=join(directory,'relay.key');
  execFileSync('openssl',['req','-new','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=localhost',
    '-addext','subjectAltName=DNS:localhost','-out',certFile,'-keyout',keyFile],{stdio:'ignore'});
  const source=join(directory,'relay-options.json'), output=join(directory,'relay-bundle');
  await writeFile(source,JSON.stringify({endpoint:'wss://localhost:8443/',pairId,certFile,keyFile,caFile:certFile,bindPort:0}),{mode:0o600});
  await prepareAgentRelay(source,output);
  const serverDirectory=join(output,'relay'), descriptors=join(output,'profile');
  const published=JSON.parse(await readFile(join(serverDirectory,'relay.json'),'utf8'));
  const [cert,key]=await Promise.all([readFile(join(serverDirectory,published.certFile)),readFile(join(serverDirectory,published.keyFile))]);
  const mac=JSON.parse(await readFile(join(descriptors,relayConfigName),'utf8'));
  const {record:device}=JSON.parse(await readFile(join(descriptors,'.stackchan-relay-device.json'),'utf8'));
  const service=createAgentRelay({cert,key,rooms:published.rooms,...(relayStandby?{waitMs:1200}:{})});
  try {
    const {port}=await service.listen({host:published.host,port:published.port});
    // This isolated test substitutes the OS-assigned port without changing credentials.
    const endpoint='wss://localhost:'+port+'/';
    return { service,host:{...mac,endpoint},device:{endpoint,roomId:device.room_id,ca:device.ca,token:device.token,role:'device'} };
  } catch(error) { await service.close();throw error; }
}
async function relayDevice(config,record) {
  const stream=await openAgentRelayStream(config);
  try {
    const [bytes]=await once(stream,'data',{signal:AbortSignal.timeout(3000)});
    assert.equal(bytes.toString(),RELAY_AGENT_PREAMBLE);
    const credentials=relayTlsIdentity(deviceId,record.pair_id,record.local_token);
    const client=connectTls({socket:stream,minVersion:'TLSv1.2',maxVersion:'TLSv1.2',ciphers:USB_AGENT_CIPHER,
      pskCallback:()=>credentials,rejectUnauthorized:false,ALPNProtocols:[RELAY_AGENT_ALPN]});
    client.on('error',()=>{});
    const peer=new EventEmitter();
    peer.terminate=()=>{client.destroy();stream.destroy();};
    framePeer(peer,client);
    await once(client,'secureConnect',{signal:AbortSignal.timeout(5000)});
    return peer;
  } catch(error) { stream.destroy();throw error; }
}

async function listenLanPort(host, port = 0) {
  const server = createTcpServer(connection => connection.destroy());
  server.listen({ host, port, exclusive: true });
  await once(server, 'listening');
  return server;
}

async function confirmLanListenerReleased(url) {
  const endpoint = new URL(url);
  const released = await listenLanPort(endpoint.hostname, Number(endpoint.port));
  await new Promise(resolve => released.close(resolve));
  console.log('Installed LAN used the paired private address, recovered from a busy port, required the device hello, and released its listener on shutdown.');
}

async function lanDevice(url, record) {
  const client = new WebSocket(url, 'sion-agent-v1', {
    ca: record.ca, servername: 'sion-host', rejectUnauthorized: true,
    headers: { Authorization: 'Bearer ' + record.local_token,
      'X-Sion-Pair-Id': record.pair_id, 'X-Sion-Device-Id': deviceId },
  });
  client.on('error', () => {});
  try {
    await once(client, 'open', { signal: AbortSignal.timeout(5000) });
    // Match the ESP WebSocket client's transport heartbeat during ASR/TTS warmup.
    const keepalive = setInterval(() => { if (client.readyState === WebSocket.OPEN) client.ping(); }, 5000);
    keepalive.unref();
    client.once('close', () => clearInterval(keepalive));
    return client;
  } catch (error) {
    client.terminate();
    throw error;
  }
}

const fixtureJpeg = () => sharp({ create: { width: 640, height: 480, channels: 3, background: '#242ca4' } }).jpeg().toBuffer();

async function simulatedCapabilities(send, boot, withHeadTouch = headTouchV40) {
  const jpeg = await fixtureJpeg();
  const taken = [];
  const moves = [];
  const expressions = [];
  const rings = [];
  let hold = false;
  const held = [];
  const deliver = value => { if (hold) held.push(value); else send(value); };
  return {
    taken, moves, expressions, rings,
    advertise: { expression: 1, motion: 1, ring: 1, camera: 1, camera_status: 1,
      ...(withHeadTouch ? { head_touch: 1 } : {}) },
    reportHeadTouch(epoch, levels) {
      assert.ok(withHeadTouch);
      send({ type: 'head_touch_state', boot_id: boot, epoch: String(epoch), levels });
    },
    receive(message, reply) {
      switch (message.type) {
        case 'capture_camera':
          taken.push(message);
          deliver({ ...reply, type: 'camera_meta', bytes: String(jpeg.length), width: '640', height: '480' });
          break;
        case 'camera_next': {
          const offset = Number(message.offset);
          assert.equal(message.request_id, taken.at(-1)?.request_id);
          if (offset === jpeg.length) send({ ...reply, type: 'camera_complete' });
          else send({ ...reply, type: 'camera_chunk', offset: message.offset, data: jpeg.subarray(offset, offset + CAMERA.chunkBytes).toString('base64') });
          break;
        }
        case 'move_head':
          moves.push(message);
          deliver({ ...reply, type: 'motion_result', code: 'reached', yaw: Number(message.yaw), pitch: Number(message.pitch) });
          break;
        case 'set_expression':
          expressions.push({ ...reply, type: 'expression_result', expression: message.expression, status: 'applied' });
          deliver(expressions.at(-1));
          break;
        case 'set_ring':
          rings.push(message);
          deliver({ ...reply, type: 'ring_result', code: 'completed' });
          break;
      }
    },
    report(epoch) {
      const state = { boot_id: boot, epoch: String(epoch), permission: 'allowed', phase: 'idle', error: '' };
      send({ ...state, type: 'motion_state' });
      send({ ...state, type: 'ring_state' });
      send({ ...state, type: 'camera_state', busy: false });
    },
    waitForStop() { hold = true; },
    sendLateResults() {
      hold = false;
      for (const result of held.splice(0)) send(result);
      if (expressions.length) send(expressions.at(-1));
    },
  };
}
function deepSeekFixtureStream(res, number) {
  const send = (type, fields = {}) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
  send('message_start', { message: { id: `msg_fixture_${number}`, type: 'message', role: 'assistant', model,
    content: [], usage: { input_tokens: 15 } } });
  let index = 0;
  return {
    startText() { send('content_block_start', { index, content_block: { type: 'text', text: '' } }); },
    text(text) { send('content_block_delta', { index, delta: { type: 'text_delta', text } }); },
    closeText() { send('content_block_stop', { index }); index++; },
    photo(id) {
      send('content_block_start', { index, content_block: { type: 'tool_use', id, name: 'stackchan_take_photo', input: {} } });
      send('content_block_stop', { index });
      index++;
    },
    finish(stopReason) {
      send('message_delta', { delta: { stop_reason: stopReason }, usage: { output_tokens: 8 } });
      send('message_stop');
      res.end();
    },
  };
}

const requests = [];
const pictureCall = 'toolu_sion_fixture_photo';
const finalTurnRequest = photoMode ? 5 : 4;
let offeredPhotoTool = false;
let photoResultPending = false;
const firstSentence = '语音回复。';
const playbackReply = '这里有一段关于今天的天气和日常生活的语音，'.repeat(oversizedReply ? 420 : 6).slice(0, -1) + '。';
if (oversizedReply) assert.ok(playbackReply.length > 8000);
let playbackTurn;
const responseText = turn => (turn === playbackTurn || (cppDevice && turn === 6))
  ? playbackReply : firstSentence + '第 ' + turn + ' 轮测试完成。';
const openReplies = new Set();
let releaseLastReply;
const lastReply = new Promise(resolve => { releaseLastReply = resolve; });
let heldSessionSwitchTurn, releaseSessionSwitchReply;
const sessionSwitchReply = new Promise(resolve => { releaseSessionSwitchReply = resolve; });
const server = createServer(async (req, res) => {
  // An unavailable fixture Files API exercises the SDK's supported inline-image fallback.
  if (photoMode && req.url === '/v1/files') { req.resume(); res.writeHead(404).end(); return; }
  const path = photoMode ? '/v1/messages' : '/v1/chat/completions';
  if (req.method !== 'POST' || req.url !== path) { res.writeHead(404).end(); return; }
  let chunks = '';
  for await (const chunk of req) chunks += chunk;
  const data = JSON.parse(chunks);
  const number = requests.push(data.messages);
  const turn = photoMode && number > 2 ? number - 1 : number;
  if (turn === heldSessionSwitchTurn) await sessionSwitchReply;
  if (turn === 4 && !slowStream) {
    if (reconnect) openReplies.add(turn);
    await lastReply;
    if (reconnect) openReplies.delete(turn);
  }
  res.writeHead(200, {'Content-Type':'text/event-stream'});
  if (photoMode) {
    assert.equal(data.model, model, 'Use the existing session model even when the DSH default differs');
    const stream = deepSeekFixtureStream(res, number);
    stream.startText();
    if (number === 2) {
      offeredPhotoTool = data.tools?.some(tool => tool.name === 'stackchan_take_photo') === true;
      photoResultPending = true;
      stream.text('我先拍一张照片。');
      stream.closeText();
      stream.photo(pictureCall);
      stream.finish('tool_use');
      return;
    }
    if (slowStream && turn > 1) {
      openReplies.add(turn);
      stream.text(firstSentence);
      if (turn === 4) await lastReply;
      else await delay(1600);
      stream.text(responseText(turn).slice(firstSentence.length));
      openReplies.delete(turn);
    } else stream.text(responseText(turn));
    if (number === 3) photoResultPending = false;
    stream.closeText();
    stream.finish('end_turn');
    return;
  }
  const base={id:'chatcmpl-'+turn,object:'chat.completion.chunk',created:1,model};
  const write = (delta, finishReason = null) => {
    const frame = {...base, choices: [{index: 0, delta, finish_reason: finishReason}]};
    res.write('data: ' + JSON.stringify(frame) + '\n\n');
  };
  if (slowStream && turn > 1) {
    openReplies.add(turn);
    write({role:'assistant',content:firstSentence});
    if (turn === 4) await lastReply;
    else await delay(1600);
    write({content:responseText(turn).slice(firstSentence.length)});
    openReplies.delete(turn);
  } else {
    write({role:'assistant',content:responseText(turn)});
  }
  write({},'stop');
  res.end('data: [DONE]\n\n');
});
await new Promise((ok,fail)=>server.listen(0,'127.0.0.1',ok).once('error',fail));
const patch = join(directory, 'local.yml');
const endpoint = 'http://127.0.0.1:' + server.address().port;
const provider = photoMode ? 'deepseek-official' : 'local-voice-rehearsal';
await writeFile(patch,JSON.stringify([
  photoMode ? { id: 'llm-deepseek', config: { baseURL: endpoint, apiKeyEnv: 'DSH_NATIVE_FIXTURE_KEY', thinking: 'disabled' } } :
    {id:'llm-pi-ai',config:{providers:{[provider]:{
    api:'openai-completions',baseURL:endpoint+'/v1',apiKeyEnv:'DSH_NATIVE_FIXTURE_KEY',
    models:[{id:model,contextWindow:8192}],
  }}}},
  {id:'agent-default-model',config:{provider,model:defaultModel}},
  {id:'session-title-llm',disabled:true},
  {id:'deepseek-account',disabled:true},
  ...(tarball ? [] : [{ id: 'stackchan', config: { preferences: selectedPreferences } }]),
]));
const env = createLaunchEnvironmentSnapshot([{source:'process',values:{
  DSH_HOME:process.env.DSH_HOME,DSH_TELEMETRY_MODE:'DISABLED',DSH_NATIVE_FIXTURE_KEY:'local-fixture-only',
}}]);
let app, voiceRuntime, pairing, socket, timer, relay, lanReservation, standbyReplacement;
const openProfile = () => runProfile({profile,environment:env,patchFiles:[patch],
  resolvedProfile: { profile: loadProfileDirectory('dsh', join(process.env.DSH_HOME, 'profiles', profile), dshManifest), installAnchor: dshManifest },
  args:['--host','127.0.0.1','--port','0','--no-open']});
async function closeProfile() {
  await app.shutdown.shutdown(process.exitCode ?? 0);
  app = undefined;
}
const readHistory = (ctx, target = sessionId) => ctx.sessionController.events({address:{kind:'session',sessionId:target},maxMessages:40},AbortSignal.timeout(3000));
async function assertModelPhoto(ctx) {
  const user = requests[1].filter(message => message.role === 'user').at(-1);
  assert.match(JSON.stringify(user.content), /照片/);
  assert.equal(offeredPhotoTool, true, 'the installed tool must be visible to the model');
  const tool = requests[2].flatMap(message => message.content).find(block => block.type === 'tool_result' && block.tool_use_id === pictureCall);
  assert.ok(tool && !tool.is_error, 'the native tool result must be returned to the model');
  const recorded = (await readHistory(ctx)).records.find(({ event }) => event?.type === 'tool/result' && event.data.message.toolCallId === pictureCall);
  const recordedImage = recorded?.event.data.message.content.find(block => block.type === 'image');
  assert.ok(recordedImage?.attachment?.attachmentId, 'keep the real image in the original session history');
  const saved = await ctx.attachments.readImage(recordedImage.attachment);
  assert.ok(saved.data.length > 0);
  const images = tool.content.filter(block => block.type === 'image');
  if (photoMode === 'vision') {
    assert.equal(images.length, 1);
    const source = images[0].source;
    assert.equal(source.type, 'base64');
    assert.equal(source.media_type, 'image/jpeg');
    const { width, height, format } = await sharp(Buffer.from(source.data, 'base64')).metadata();
    assert.deepEqual({ width, height, format }, { width: 640, height: 480, format: 'jpeg' });
    return;
  }
  assert.equal(images.length, 0);
  assert.match(tool.content.map(block => block.text).join(' '), /image omitted because this model accepts text only/i);
}
async function readPreviousRelease(save) {
  // Reopening a profile in this process keeps the old ESM and generated Typert modules cached.
  const stage = fork(new URL('./dsh_native_voice_profile_stage.mjs', import.meta.url), [], {
    cwd: workspace, serialization: 'advanced', stdio: ['ignore', 'ignore', 'inherit', 'ipc'], timeout: 60000,
  });
  const exit = once(stage, 'exit');
  let result;
  stage.once('message', value => { result = value; });
  stage.send({ dshDirectory: resolve(repository, dshDirectory), profile, patch, sessionId, selectedPreferences, save });
  const [code, signal] = await exit;
  assert.equal(code, 0, `Fresh DSH process for the previous package exited: ${signal ?? code}`);
  assert.ok(result, 'Fresh DSH process returned its history and preferences after shutdown');
  return result;
}
async function seedSession(ctx) {
  const created = await ctx.sessionController.create({ sessionId, cwd: workspace,
    ...(sessionSwitch ? { agentPreset: 'standard' } : {}) });
  assert.equal(created.sessionId, sessionId);
  if (photoMode) ctx.agents.get(sessionId).model.select({provider,model});
  await ctx.sessionController.prompt({ sessionId, requestId: 'desktop-seed', mode: 'queue',
    content: [{ type: 'text', text: desktopSeed }] }, AbortSignal.timeout(5000));
  const deadline = Date.now() + 8000;
  while ((requests.length < 1 || ctx.agents.get(sessionId)?.status !== 'idle') && Date.now() < deadline) await delay(20);
  assert.equal(requests.length, 1);
  assert.equal(ctx.agents.get(sessionId).status, 'idle');
}
rehearsal: try {
  initializeProfileFromDefault(profile,'web');
  const profileDir=join(process.env.DSH_HOME,'profiles',profile);
  if (managedFrom) await copyManagedVoice(profileDir);
  const modules = join(profileDir, 'node_modules');
  const bundlePath = join(modules, 'dsh-stackchan');
  const manifestPath = join(profileDir, 'package.json');
  const readBundles = async () => JSON.parse(await readFile(manifestPath, 'utf8')).dsh.profile.bundles;
  const verifyPluginEntry = async source => assert.deepEqual(await readFile(join(bundlePath,'src/plugin.mjs')),
    execFileSync('tar',['-xOzf',source,'package/src/plugin.mjs']));
  const savePreferences = async (ctx, preferences) => {
    const row = ctx.settings.describe().find(item => item.ns === 'stackchan');
    await ctx.settings.mutate('stackchan', [{ op: 'set', path: ['preferences'], value: preferences }], row.revision);
  };
  let seedHistory, legacyPreferences;
  if (tarball) {
    app = await openProfile();
    assert.equal(app.ctx.get('stackchanSettings'), undefined);
    await seedSession(app.ctx);
    seedHistory = await readHistory(app.ctx);
    await closeProfile();
    manageBundle('add', upgradeFrom ?? tarball, '--ignore-scripts');
    assert.ok((await readBundles()).includes('dsh-stackchan'));
    assert.ok((await realpath(bundlePath)).startsWith(modules + sep), 'Resolve the installed artifact from the isolated profile');
    if (capabilities) {
      // This file belongs to the new rehearsal profile. Native Settings owns the
      // volatile preferences saved below, while these host paths are install options.
      let pairingPython=installation.python;
      if(usbPty){
        pairingPython=join(directory,'python-for-usb-fixture');
        const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
        const command=[installation.python,ptyFixture,'launch',ptyState].map(quote).join(' ');
        await writeFile(pairingPython,'#!/bin/sh\nexec '+command+' "$@"\n',{mode:0o700});
      }
      await writeFile(join(profileDir, 'cordis.patch.yml'), JSON.stringify([{ id: 'stackchan', config: {
        pairing: { directory: pairingDir, python: pairingPython, deviceAccess: usbPty },
        voice: { ...(managedFrom ? {} : installation), ...(latencyLogs ? { logLatency: true } : {}) },
      } }]));
    }
  } else {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.dsh.profile.bundles.push('dsh-stackchan');
    await writeFile(manifestPath, JSON.stringify(manifest));
    await mkdir(modules);
    await symlink(repository, bundlePath);
  }
  if (upgradeFrom) {
    await verifyPluginEntry(upgradeFrom);
    const previous = await readPreviousRelease(true);
    assert.deepEqual(previous.history, seedHistory);
    legacyPreferences = previous.preferences;
    manageBundle('add', tarball, '--ignore-scripts');
    assert.equal((await readBundles()).filter(name => name === 'dsh-stackchan').length, 1);
    await verifyPluginEntry(tarball);
  }
  app = await openProfile();
  if (tarball) {
    assert.deepEqual(await readHistory(app.ctx), seedHistory);
    const defaults=app.ctx.stackchanSettings.snapshot().preferences;
    if (upgradeFrom) {
      for(const [name,value] of Object.entries(legacyPreferences))assert.deepEqual(defaults[name],value);
      assert.equal(defaults.measureLatency,false);
      console.log('Official CLI replaced the installed older local package with the new one and preserved the existing preferences and session.');
    } else assert.equal(defaults.sessionId, '');
    const value = { ...app.ctx.stackchanSettings.snapshot().preferences, ...selectedPreferences };
    await savePreferences(app.ctx,value);
    await closeProfile();
    app = await openProfile();
    assert.deepEqual(app.ctx.stackchanSettings.snapshot().preferences, value);
    console.log('Official CLI installation kept the existing session and native preferences persisted across restart.');
  } else {
    await seedSession(app.ctx);
  }
  const {ctx}=app;
  const pluginEntry = tarball && [...ctx.loader.entries()].find(entry => entry.options.name === 'dsh-stackchan');
  if(tarball){
    assert.ok(pluginEntry,'the packaged StackChan entry is active in the isolated profile');
    const resolved=ctx.pluginPackages.packageOf(pluginEntry.options.name,pluginEntry.parent.tree.ctx.baseUrl);
    assert.equal(await realpath(resolved.manifestPath),await realpath(join(bundlePath,'package.json')),
      'DSH resolves StackChan from the isolated installation');
  }
  const voiceAction = (action) => ctx.typertGateway.invoke({
    namespace:'stackchanVoice',method:'execute',args:{action},
    peer:{id:'voice-fixture-owner',ctx,principal:{kind:'owner'},signal:AbortSignal.timeout(3000),interactions:'none'},
  });
  const readVoiceView = () => voiceAction('snapshot');
  const latencyEntries = () => ctx.logger.buffer.filter(record => record.name === 'stackchan-latency')
    .map(record => {
      assert.equal(record.type, 'info');
      assert.equal(record.args[0], 'STACKCHAN_VOICE_LATENCY %s');
      return JSON.parse(record.args[1]);
    });
  assert.ok(ctx.sessionController);
  assert.equal(ctx.stackchanSettings.snapshot().preferences.sessionId,sessionId);
  assert.equal(ctx.stackchanSettings.snapshot().preferences.measureLatency,latencyView);
  assert.equal(ctx.stackchanSettings.snapshot().applied,false);
  const lookup = () => ctx.sessionController.projections({sessionId}, AbortSignal.timeout(3000));
  const baseline = await lookup();
  assert.equal(baseline.kind,'sequenced');
  assert.deepEqual(await ctx.stackchanSettings.checkSession(),{status:'valid'});
  const hostModule = name => import(pathToFileURL(join(bundlePath, 'src', name)).href);
  const readyTimes = new Map();
  let whisperProcesses, synthesisProcesses, serialProcesses, audioProcesses, identityProcesses;
  if (managedFrom) {
    const {WhisperBackend, KokoroBackend: InstalledKokoro} = await hostModule('local-speech.mjs');
    const {LocalAudioFrontend} = await hostModule('local-audio.mjs');
    for (const [label, Class, method] of [
      ['asr', WhisperBackend, 'warmup'], ['tts', InstalledKokoro, 'warmup'], ['audio', LocalAudioFrontend, 'start'],
    ]) {
      const original = Class.prototype[method];
      Class.prototype[method] = async function (...args) {
        const started = performance.now();
        const value = await original.apply(this, args);
        if (!readyTimes.has(label)) readyTimes.set(label, {
          begin: started, finish: performance.now(),
        });
        return value;
      };
    }
    const {createVoiceInstallation} = await hostModule('voice-installation.mjs');
    const setup = createVoiceInstallation({profileDirectory: profileDir});
    const options = await setup.active();
    assert.equal(options.whisperProtocol, 1);
    const childProcesses = (predicate, pid=process.pid) => execFileSync('/bin/ps', ['-ax','-o','pid=,ppid=,command='], {encoding: 'utf8'})
      .split('\n').map(line => line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/u))
      .filter(fields => fields && Number(fields[2]) === pid && predicate(fields[3]))
      .map(fields => Number(fields[1]));
    whisperProcesses = pid => childProcesses(command => command.startsWith(options.whisperBinary + ' '),pid);
    synthesisProcesses = pid => childProcesses(command => command.includes('/scripts/local_speech.py --assets '),pid);
    audioProcesses = pid => childProcesses(command => command.includes('/scripts/local_audio.py '),pid);
    identityProcesses = pid => childProcesses(command => command.includes('/scripts/agent_pairing_identity.py '),pid);
    serialProcesses = () => childProcesses(command => command.includes(ptyFixture + ' launch ') && command.includes('/scripts/agent_usb_audio.py '));
    assert.deepEqual(whisperProcesses(), []);
    assert.deepEqual(synthesisProcesses(), []);
  }
  if (checkVoicePreview) {
    const before = await lookup();
    const requestCount = requests.length;
    for (const [voice, speechRate, language] of [['zf_001', 1.15, 'zh'], ['af_maple', 0.5, 'en']]) {
      const sample = await ctx.typertGateway.invoke({
        namespace: 'stackchanVoice', method: 'preview', args: { language: 'auto', voice, speechRate },
        peer: { id: 'voice-preview-owner', ctx, principal: { kind: 'owner' }, signal: AbortSignal.timeout(45000), interactions: 'none' },
      });
      assert.equal(sample.language, language);
      const wav = Buffer.from(sample.wav, 'base64');
      assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
      assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
      assert.equal(wav.readUInt16LE(22), 1);
      assert.equal(wav.readUInt32LE(24), 24000);
      assert.equal(wav.readUInt16LE(34), 16);
      assert.equal(wav.readUInt32LE(40), wav.length - 44);
      assert.ok(wav.length > 44 && wav.length <= 44 + 24000 * 2 * 8);
      assert.ok(wav.subarray(44).some(byte => byte !== 0));
      assert.deepEqual(synthesisProcesses(), []);
    }
    assert.deepEqual(await lookup(), before);
    assert.equal(requests.length, requestCount);
    const view = await readVoiceView();
    assert.equal(view.phase, 'stopped');
    assert.equal(view.connected, false);
    for (const processes of [whisperProcesses, audioProcesses, identityProcesses]) assert.deepEqual(processes(), []);
    console.log('Installed owner Remote preview produced local Mandarin and English WAV; no input workers, device identity or DSH messages.');
  }
  if(tarball){
    const { SettingsController } = await hostModule('settings-controller.mjs');
    const preferences = ctx.stackchanSettings.snapshot().preferences;
    const settings = new SettingsController({
      getSnapshot: () => ({ status: 'ready', writable: true, value: { preferences }, revision: 1 }),
      subscribe: () => () => {},
      mutate: () => assert.fail('checking a saved session cannot write preferences'),
    }, {
      async projections(request, signal) {
        const value = await ctx.typertGateway.invoke({
          namespace: 'session', method: 'projections', args: { request },
          peer: { id: 'settings-fixture-owner', ctx, principal: { kind: 'owner' }, signal, interactions: 'none' },
        });
        return { ok: true, value };
      },
    });
    try {
      await settings.checkSession();
      assert.equal(settings.getSnapshot().sessionCheck, 'verified');
      settings.edit('sessionId', 'session-' + randomUUID());
      await settings.checkSession();
      assert.equal(settings.getSnapshot().sessionCheck, 'missing');
      assert.deepEqual(ctx.stackchanSettings.snapshot().preferences, preferences);
      assert.deepEqual(await readHistory(ctx), seedHistory);
      console.log('Packaged settings checked the exact saved and missing IDs through DSH Session Remote without changing preferences or history.');
    } finally {
      settings.dispose();
    }
  }
  const { createVoiceRuntime } = await hostModule('voice-runtime.mjs');
  const { createLocalVoice } = await hostModule('local-voice.mjs');
  const { createPairingHost, localNetworkCandidates } = await hostModule('pairing-host.mjs');
  const { createAgentTransport } = await hostModule('agent-transport.mjs');
  const { python, assetsDirectory: assets, temporaryDirectory } = installation;
  const queue=[];
  const kokoro = new KokoroBackend({python,assets});
  try {
    const examples = [photoMode ? '请拍一张照片。' : '你好，第一轮测试。','你好，第二轮测试。','你好，第三轮测试。'];
    if (longConversation) examples.push('不要停止。');
    for (const text of examples) {
      const chunks=[];
      for await (const pcm of kokoro.synthesize(text,{language:'zh'})) chunks.push(pcm);
      queue.push(Buffer.concat(chunks));
    }
  } finally { await kokoro.dispose(); }
  const stop=await readFile(join(root,'audio-fixture-01/near.pcm'));
  pairing=createPairingHost({directory:pairingDir,python});
  let localUrl = 'wss://192.168.1.2:9080/audio';
  if (noLanPairing) {
    localUrl = '';
  } else if (usbPty) {
    const assigned = new Set(Object.values(networkInterfaces()).flatMap(entries => (entries ?? []).map(entry => entry.address)));
    const unavailable = ['10.255.255.254', '172.31.255.254', '192.168.255.254'].find(address => !assigned.has(address));
    assert.ok(unavailable, 'The USB fixture needs an unassigned LAN address');
    localUrl = `wss://${unavailable}:9080/audio`;
  } else if (installedLan) {
    const entry = localNetworkCandidates(networkInterfaces()).endpoints.find(candidate => candidate.interfaceName === lanInterface);
    assert.ok(entry, 'The selected interface must have an assigned private IPv4 address supported by DSH StackChan');
    const endpoint = new URL(entry.url);
    lanReservation = await listenLanPort(endpoint.hostname);
    endpoint.port = lanReservation.address().port;
    localUrl = endpoint.href;
  }
  const statePath=join(pairingDir,'state.json');
  let bundle;
  if (pairingProbe) {
    bundle = await pairThroughUsbPty(ctx, localUrl);
  } else {
    assert.equal((await pairing.call({action:'prepare',revision:0,deviceId,localUrl})).ok,true);
    const identity=JSON.parse(await readFile(statePath,'utf8'));
    identity.active=identity.candidate;
    identity.candidate=null;
    await writeFile(statePath,JSON.stringify(identity));
    bundle=JSON.parse(await readFile(join(pairingDir,identity.active,'pairing.json'),'utf8'));
  }
  if(relayed){
    relay=await makeRelay(bundle.record.pair_id);
    await writeFile(join(profileDir,relayConfigName),JSON.stringify(relay.host),{mode:0o600});
    assert.equal(ctx.stackchanSettings.snapshot().preferences.transport,'relay');
  }
  let usb=wired&&!usbPty?usbDevice(bundle.record):null;
  if(usb)socket=usb.peer;
  const voicePairing=usb?{
    async acquireIdentity(signal){const lease=await pairing.acquireIdentity(signal);return {...lease,openUsb:usb.open};},
  }:pairing;
  let address;
  const preferences=ctx.stackchanSettings.snapshot().preferences;
  const timings=[];
  voiceRuntime=capabilities ? ctx.stackchanVoice : createVoiceRuntime({ctx,pairing:voicePairing,installation,profileDirectory:profileDir,getPreferences:()=>preferences,
    onLatency:sample=>timings.push(sample),
    factories:{...(!previewEnabled ? { voice(config) {
      const voice = createLocalVoice(config);
      return { ...voice, async acquire(options) {
        const lease = await voice.acquire(options);
        return { ...lease, prepareSpeech: undefined };
      } };
    } } : {}), transport:config=>{
      const transport=createAgentTransport(config);
      const listen=transport.listen;
      transport.listen=async()=>{
        assert.ok(!relay,'Relay mode must not listen on the Host');
        address=await listen({host:'127.0.0.1',port:0});return address;
      };
      return transport;
    }},
  });
  await mkdir(temporaryDirectory,{mode:0o700});
  if (lanReservation) {
    await assert.rejects(voiceRuntime.execute('start'), { code: 'voice_port_in_use' });
    assert.equal((await readVoiceView()).phase, 'stopped');
    assert.equal((await pairing.call({ action: 'snapshot' })).ok, true, 'failed bind releases the active pairing lease');
    await new Promise(resolve => lanReservation.close(resolve));
    lanReservation = undefined;
  }
  assert.equal((await voiceRuntime.execute('start')).transport,wired?'usb':relay?'relay':'lan');
  if (usbPty) console.log(noLanPairing ? 'USB service started with no LAN address in the confirmed pairing.'
    : 'USB service started with an unassigned LAN address in the saved pairing record.');
  const wssUrl = installedLan ? localUrl : address ? `wss://127.0.0.1:${address.port}/audio` : null;
  if(latencyView)assert.deepEqual((await readVoiceView()).latency,{enabled:true,latest:null});
  if (waitBeforeConnect) {
    await delay(waitBeforeConnect);
    assert.equal(voiceRuntime.snapshot().connected, false);
    assert.equal(voiceRuntime.snapshot().applied, false);
    assert.deepEqual(whisperProcesses(), []);
    console.log('VOICE_WAIT_BEFORE_CONNECT '+JSON.stringify({
      waitMs:waitBeforeConnect, synthesisReady:readyTimes.has('tts'),
    }));
  }
  if (usbPty) usb=await startUsbPty(bundle.record,{standby:usbStandby});
  const connectStarted=performance.now();
  let connecting;
  if(usb){assert.equal(address,undefined);socket=usb.peer;}
  else if(relay){
    assert.equal(address,undefined);
    assert.equal(voiceRuntime.snapshot().connected,false);
    if(relayStandby){
      const armed = await voiceAction('arm-relay');
      assert.equal(armed.relayStandby,true);
      await delay(1750); // Includes the first isolated relay rendezvous expiry.
      const waiting = await readVoiceView();
      assert.equal(waiting.relayStandby,true);assert.equal(waiting.applied,false);assert.equal(waiting.connected,false);
    }else{
      connecting=voiceRuntime.execute('connect');connecting.catch(()=>{});
    }
    socket=await relayDevice(relay.device,bundle.record);
  }
  else{
    if(lanStandby){
      const armed=await voiceAction('arm-lan');
      assert.equal(armed.lanStandby,true);
      assert.equal(armed.connected,false);
      assert.equal(armed.applied,false);
    }
    socket = await lanDevice(wssUrl, bundle.record);
    if (installedLan) {
      assert.equal((await readVoiceView()).connected, false, 'WSS before hello cannot start a device session');
      await assert.rejects(voiceRuntime.execute('connect'), { code: lanStandby ? 'voice_busy' : 'voice_device_missing' });
    }
  }
  if (cppDevice) {
    if (usb) {
      connecting = voiceRuntime.execute('connect');
      connecting.catch(() => {});
      await Promise.race([usb.secure, connecting.then(() => usb.secure)]);
    }
    playbackTurn = 5;
    let photo;
    if (photoMode) {
      const jpegPath = join(directory, 'fixture-camera.jpg');
      await writeFile(jpegPath, await fixtureJpeg(), { mode: 0o600 });
      photo = {
        jpegPath,
        readyForPlayback: () => requests.length === 3 && !photoResultPending,
        verifyModelPhoto: () => assertModelPhoto(ctx),
        capture: async () => (await ctx.tools.execute({
          calls: [{ type: 'tool-call', id: randomUUID(), name: 'stackchan_take_photo', arguments: '{}' }],
          agent: ctx.agents.get(sessionId), signal: AbortSignal.timeout(15000),
        })).results[0].result,
      };
    }
    await exerciseCppDevice({
      executable: cppDevice, pairId: bundle.record.pair_id, socket, connecting, voiceRuntime,
      queue, stop, requests, desktopSeed, releaseLastReply, lateText: responseText(4),
      ctx, sessionId, baseline, lookup, history: () => readHistory(ctx),
      serialProcesses: usbPty ? serialProcesses : undefined,
      playbackStopFrames: cppFirstFrameStop ? 1 : 100,
      photo,
    });
    if (installedLan) {
      await assert.rejects(voiceRuntime.execute('shutdown'), { code: 'voice_release_unconfirmed' });
      const stoppedHost = await readVoiceView();
      assert.equal(stoppedHost.phase, 'stopped');
      assert.equal(stoppedHost.deviceIdleConfirmed, false);
      if (managedFrom) {
        assert.deepEqual(audioProcesses(), []);
        assert.deepEqual(whisperProcesses(), []);
        assert.deepEqual(synthesisProcesses(), []);
      }
      await confirmLanListenerReleased(wssUrl);
    }
    break rehearsal;
  }
  const boot='c'.repeat(32);
  const send=data=>socket.send(JSON.stringify(data));
  let device = capabilities ? await simulatedCapabilities(send, boot) : null;
  const hello=(withCaptions=true)=>send({type:'hello',protocol:1,device_id:deviceId,pair_id:bundle.record.pair_id,boot_id:boot,epoch:String(epoch),phase:'idle',playback_fence:1,...(withCaptions?{caption:1}:{}),...device?.advertise});
  let epoch=0n,sequence=0n,active=false,drains=0,outputFrames=0,nextOutput=0n,stops=0;
  let pacedPlayback;
  const outputSilence = Buffer.alloc(AUDIO.samples * 2);
  const captions=[];
  function acceptOutput(frame) {
    nextOutput = frame.sequence + 1n;
    send({type:'output',boot_id:boot,epoch:String(epoch),sequence:String(frame.sequence)});
  }
  const receive=(data,binary)=>{
    if(binary){
      assert.ok(active, 'no PCM on a stopped lease');
      assert.ok(openReplies.size === 0 && !photoResultPending, 'no PCM before the final model reply');
      const frame=decodePcm(data,2);
      assert.equal(frame.epoch,epoch);
      outputFrames++;
      if (pacedPlayback) {
        pacedPlayback.frames.push(frame);
        assert.ok(pacedPlayback.frames.length <= AUDIO.outputWindowFrames);
      } else acceptOutput(frame);
      return;
    }
    const message=JSON.parse(data);
    const reply={boot_id:boot,epoch:message.epoch,request_id:message.request_id};
    if(message.type==='caption'){
      if(message.speaker==='assistant') assert.ok(openReplies.size === 0 && !photoResultPending, 'no interim assistant caption');
      assert.ok(active);
      assert.equal(message.boot_id,boot);
      assert.equal(message.epoch,String(epoch));
      const text=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.from(message.text_hex,'hex'));
      captions.push([message.speaker,text]);
      return;
    }
    if(message.type==='start'||message.type==='stop'){
      active=message.type==='start';
      if(!active){
        stops++;
        if (pacedPlayback) pacedPlayback.discarded = pacedPlayback.frames.splice(0).length;
      }
      epoch=BigInt(message.epoch)+1n;
      sequence=0n;
      send({...reply,type:active?'started':'stopped',epoch:String(epoch),...(active?{}:{resources_stopped:true})});
      if (active) device?.report(epoch);
      else if (stops === 1) device?.sendLateResults();
    }else if(message.type==='renew'){
      send({type:'renewed',boot_id:boot,epoch:message.epoch});
      device?.report(epoch);
    }
    else if(message.type==='drain_output'){
      assert.ok(!pacedPlayback?.frames.length, 'cannot drain before all simulated output writes');
      drains++;
      send({...reply,type:'output_drained',next_sequence:String(nextOutput)});
    } else device?.receive(message, reply);
  };
  socket.on('message',receive);
  let input=Buffer.alloc(0),offset=0;
  timer=setInterval(()=>{
    if(!active)return;
    const pcm=Buffer.alloc(960);
    for(let i=0;i<240&&offset<input.length;i++,offset+=2)pcm.writeInt16LE(input.readInt16LE(offset),i*4);
    if (pacedPlayback) {
      const output = pacedPlayback.frames.shift();
      if (output) {
        pacedPlayback.played++;
        acceptOutput(output);
      }
      const reference = output?.pcm ?? outputSilence;
      pacedPlayback.reference.push(reference);
      const echo = pacedPlayback.reference.length > 4 ? pacedPlayback.reference.shift() : outputSilence;
      for (let i = 0; i < AUDIO.samples; i++) {
        const mixed = Math.round(0.75 * pcm.readInt16LE(i * 4) + 0.55 * echo.readInt16LE(i * 2));
        pcm.writeInt16LE(Math.max(-32768, Math.min(32767, mixed)), i * 4);
        pcm.writeInt16LE(reference.readInt16LE(i * 2), i * 4 + 2);
      }
    }
    socket.send(encodePcm({kind:1,epoch,sequence:sequence++,pcm}));
  },10);
  const until=async(check,label)=>{
    const limit=Date.now()+22000;
    while(!await check()&&Date.now()<limit)await delay(20);
    const { phase, lastError, connected, deviceIdleConfirmed } = voiceRuntime.snapshot();
    assert.ok(await check(),label+' '+JSON.stringify({phase,lastError,connected,deviceIdleConfirmed,requests:requests.length,drains,stops}));
  };
  if(wssUrl){hello();await until(()=>voiceRuntime.snapshot().connected,'LAN device sent authenticated hello');}
  if(!connecting&&!automatic&&!usbStandby){connecting=voiceRuntime.execute('connect');connecting.catch(()=>{});}
  if(usb){
    try {
      if(usbStandby){
        assert.equal((await voiceAction('arm-usb')).usbStandby,true);
        await Promise.race([usb.probed,usb.secure.then(()=>{throw Error('TLS before device approval');})]);
        assert.equal((await readVoiceView()).connected,false);
        assert.equal(active,false);
        usb.tap();
        await usb.secure;
      }else await Promise.race([usb.secure,connecting.then(()=>usb.secure)]);
    }
    catch(error){
      if(usbPty){
        const diagnostic=await readFile(`${ptyState}.error`,'utf8').catch(()=>'No PTY launcher diagnostic');
        console.error(diagnostic.trim());
      }
      throw error;
    }
    hello();
  }
  if(relay)hello();
  if(automatic||usbStandby)await until(()=>voiceRuntime.snapshot().phase==='active','device initiated the armed session');
  else assert.equal((await connecting).phase,'active');
  const firstWhisper = whisperProcesses?.();
  if (firstWhisper) assert.equal(firstWhisper.length, 1);
  console.log('VOICE_CONNECT '+JSON.stringify({elapsedMs:Math.round(performance.now()-connectStarted)}));
  const speechReadyAtConnect = readyTimes.has('tts');
  if (managedFrom) assert.ok(readyTimes.has('audio') && readyTimes.has('asr'));
  for(let i=0;i<2;i++){
    input=queue[i];offset=0;
    await until(()=>drains===i+1&&(latencyLogs?latencyEntries().length===i+1:device||timings.length===i+1),'spoken round '+(i+1));
    assert.equal(captions.length,2*(i+1));
    assert.equal(captions[2*i][0],'user');
    assert.ok(captions[2*i][1].trim());
    assert.deepEqual(captions[2*i+1],['assistant',responseText(i+2)]);
    if (latencyView) await until(()=>voiceRuntime.snapshot().latency.latest!==null,'latency summary from the installed service');
    if (device) continue;
    const sample=timings[i];
    assert.ok(Object.values(sample).every(value=>Number.isFinite(value)&&value>=0));
    assert.ok(sample.dshPromptToPublicTextMs>=0&&sample.dshPublicTextToTurnEndMs>=0);
    if(slowStream && previewEnabled) assert.ok(sample.ttsPreparedBeforeTurnEndMs>0,'local Kokoro must have an eligible chunk ready before DSH turn completion');
    if(!previewEnabled) assert.equal(sample.ttsPreparedBeforeTurnEndMs,undefined);
    console.log('VOICE_LATENCY '+JSON.stringify({round:i+1,
      ...Object.fromEntries(Object.entries(sample).map(([key,value])=>[key,Math.round(value)]))}));
  }
  if (managedFrom) {
    assert.equal(readyTimes.size, 3);
    const stages = Object.fromEntries([...readyTimes].map(([label, {begin, finish}]) =>
      [label, {beginMs: Math.round(begin-connectStarted), durationMs: Math.round(finish-begin)}]));
    console.log('VOICE_CONNECT_STAGES '+JSON.stringify({...stages, speechReadyAtConnect}));
  }
  assert.equal(requests.length,finalTurnRequest-1);
  if (firstWhisper) assert.deepEqual(whisperProcesses(), firstWhisper);
  assert.ok(requests[1].some(message=>message.role==='user'&&JSON.stringify(message.content).includes(desktopSeed)));
  const firstVoice = requests[1].filter(message=>message.role==='user').at(-1);
  const secondVoice = requests[finalTurnRequest-2];
  assert.ok(secondVoice.some(message=>message.role==='user'&&JSON.stringify(message.content)===JSON.stringify(firstVoice.content)));
  assert.ok(secondVoice.some(message=>message.role==='assistant'));
  if (photoMode) {
    assert.equal(device.taken.length, 1, 'the model request reached the camera exactly once');
    await assertModelPhoto(ctx);
    if (photoMode === 'vision') {
      console.log('DeepSeek Flash Messages follow-up carried the native tool result and a decodable 640×480 JPEG.');
    } else {
      console.log('DeepSeek Pro Messages follow-up delivered the explicit text-only image notice.');
    }
  }
  console.log('Two ASR, native DSH, and TTS rounds preserved the selected fixture session history.');
  const runTool = async (name, args, agent = ctx.agents.get(sessionId)) => (await ctx.tools.execute({
    calls: [{ type: 'tool-call', id: randomUUID(), name, arguments: JSON.stringify(args) }],
    agent, signal: AbortSignal.timeout(15000),
  })).results[0].result;
  const toolValue = async (name, args) => {
    const result = await runTool(name, args);
    assert.equal(result.isError, false, JSON.stringify(result));
    return result.value;
  };
  async function assertConversationReport(expected) {
    const report=await toolValue('stackchan_device_status',{});
    assert.deepEqual(report,(await readVoiceView()).capabilities);
    assert.deepEqual(report.conversation,expected);
    return report;
  }
  async function assertHeadTouchReport(expected) {
    const report = await toolValue('stackchan_device_status', {});
    assert.deepEqual(report.headTouch, expected);
    assert.deepEqual((await readVoiceView()).capabilities.headTouch, expected);
    return report;
  }
  let interruptedTools;
  if (device) {
    await until(()=>voiceRuntime.snapshot().camera.permission==='allowed','authenticated capability status');
    const status = await toolValue('stackchan_device_status', {});
    assert.equal(status.features.camera.permission, 'allowed');
    if (headTouchV40) {
      await assertHeadTouchReport({ version: 1, status: 'waiting' });
      device.reportHeadTouch(epoch, [0, 1, 3]);
      await until(() => voiceRuntime.snapshot().capabilities.headTouch?.status === 'current', 'v40 levels are current');
      const report = await assertHeadTouchReport({ version: 1, status: 'current', levels: [0, 1, 3] });
      assert.ok(report.notExposed.includes('screenTouchAndButtons'));
      await until(() => voiceRuntime.snapshot().capabilities.headTouch?.status === 'stale', 'v40 levels expired');
      await assertHeadTouchReport({ version: 1, status: 'stale' });
      device.reportHeadTouch(epoch, null);
      await until(() => voiceRuntime.snapshot().capabilities.headTouch?.status === 'unavailable', 'v40 read failure');
      await assertHeadTouchReport({ version: 1, status: 'unavailable' });
      console.log('Installed DSH tool and owner Remote agreed on v40 head touch, expiry and read failures.');
    }
    if(checkConversationReport) {
      const spoken=await assertConversationReport({replyMode:'spoken',captionChannel:'requested'});
      assert.equal(spoken.features.playbackFence.condition,'ready');
    }
    const { sessionId: otherId } = await ctx.sessionController.create({ cwd: workspace });
    const otherAgent = ctx.agents.get(otherId);
    assert.ok(otherAgent && otherAgent.id !== sessionId);
    const foreign = await runTool('stackchan_set_expression', { expression: 'happy' }, otherAgent);
    assert.equal(foreign.isError, true);
    assert.match(foreign.error.message, /not the session connected to Sion/);
    if (headTouchV40) {
      const foreignRead = await runTool('stackchan_device_status', {}, otherAgent);
      assert.equal(foreignRead.isError, true);
      assert.match(foreignRead.error.message, /not the session connected to Sion/);
    }
    assert.equal(device.expressions.length, 0);
    assert.deepEqual(await toolValue('stackchan_set_expression', { expression: 'happy' }), { version: 1, expression: 'happy', status: 'applied' });
    assert.deepEqual(await toolValue('stackchan_move_head', { yaw: -100, pitch: 450, durationMs: 250 }), {
      version: 1, status: 'reached', observed: { yaw: -100, pitch: 450 },
    });
    assert.deepEqual(await toolValue('stackchan_light_ring', { color: '#9032FF', durationMs: 250 }), { version: 1, status: 'completed' });
    const photo = await runTool('stackchan_take_photo', {});
    assert.equal(photo.isError, false, JSON.stringify(photo));
    assert.deepEqual(photo.content, [{ type: 'image', attachment: photo.value.attachment }]);
    const stored = await ctx.attachments.readImage(photo.value.attachment);
    const image = await sharp(stored.data).metadata();
    assert.deepEqual([image.width, image.height], [640, 480]);
    device.waitForStop();
    interruptedTools = Promise.all([
      runTool('stackchan_take_photo', {}),
      runTool('stackchan_move_head', { yaw: 200, pitch: 500 }),
    ]);
    interruptedTools.catch(()=>{});
    await until(()=>device.taken.length===(photoMode?3:2)&&device.moves.length===2,'pending photo and movement');
    console.log('Installed native tools used the authenticated '+voiceRuntime.snapshot().transport+' connection for camera, expression, motion and ring.');
  }
  input=queue[2];offset=0;
  await until(()=>requests.length===finalTurnRequest,'third voice request');
  if(slowStream) await until(()=>openReplies.has(4),'third voice reply has emitted its first sentence');
  async function disablePlugin() {
    await pluginEntry.update({disabled:true});
    await until(() => voiceRuntime.snapshot().phase === 'disposed' &&
      !ctx.typert.getPackage('dsh-stackchan','host') && !ctx.get('stackchanSettings'), 'Loader settled the live disable');
    await assert.rejects(readVoiceView(), {code:'gateway/definition-unavailable'});
    for (const name of ['device_status','take_photo','set_expression','move_head','light_ring'])
      assert.equal(ctx.tools.get('stackchan_'+name), undefined);
    assert.deepEqual(whisperProcesses(), []);
    assert.deepEqual(synthesisProcesses(), []);
    assert.deepEqual(serialProcesses(), []);
  }
  const beforeStop=outputFrames;
  const synthesisBeforeStop=standbyTtsCheck?synthesisProcesses():[];
  if(usbStandby)standbyReplacement=await startUsbPty(bundle.record,{standby:true});
  if (liveDisable) {
    assert.equal(ctx.agents.get(sessionId).status, 'running');
    assert.equal(whisperProcesses().length, 1);
    assert.equal(synthesisProcesses().length, 1);
    assert.equal(serialProcesses().length, 1);
    await disablePlugin();
    assert.equal(ctx.agents.get(sessionId).status, 'running', 'disable only detaches the robot from the pending DSH turn');
    assert.equal(stops, 1);
    assert.equal(active, false);
    assert.equal(voiceRuntime.snapshot().deviceIdleConfirmed, true);
    assert.equal((await pairing.call({action:'snapshot'})).ok,true,'disable releases the pairing lease');
    await socket.terminate();
  } else if (reconnect) {
    active=false;
    socket.off('message',receive);
    socket.terminate();
    await until(()=>{
      const state=voiceRuntime.snapshot();
      return automatic?state[standbyField]&&!state.connected&&state.phase==='listening':state.canReconnect;
    },'closed link and joined audio workers');
    const lost=voiceRuntime.snapshot();
    assert.equal(lost.phase,automatic?'listening':'fault');
    assert.equal(lost.connected,false);
    assert.equal(lost.deviceIdleConfirmed,false);
    assert.equal(stops,0);
  } else {
    input=stop;offset=0;
    await until(()=>stops===1&&voiceRuntime.snapshot().phase==='listening','spoken Stop');
    assert.equal(voiceRuntime.snapshot().deviceIdleConfirmed,true);
    if (headTouchV40) {
      device.reportHeadTouch(epoch - 1n, [3, 3, 3]);
      await assertHeadTouchReport({ version: 1, status: 'waiting' });
      assert.equal(voiceRuntime.snapshot().connected, true);
    }
  }
  if (interruptedTools) {
    for (const result of await interruptedTools) {
      assert.equal(result.isError, true);
      assert.ok(!result.content?.some(block => block.type === 'image'));
    }
  }
  async function rejoinDevice(withCaptions=true, withHeadTouch=headTouchV40){
    socket=relay?await relayDevice(relay.device,bundle.record):await lanDevice(wssUrl,bundle.record);
    device=await simulatedCapabilities(send,boot,withHeadTouch);
    socket.on('message',receive);
    ++epoch; // The fixture has released device resources before advertising idle.
    hello(withCaptions);
  }
  async function connectReplacementUsb() {
    const replacement = await startUsbPty(bundle.record);
    socket = replacement.peer;
    device = await simulatedCapabilities(send, boot);
    socket.on('message', receive);
    const connecting = voiceRuntime.execute('connect');
    connecting.catch(() => {});
    await Promise.race([replacement.secure, connecting.then(() => replacement.secure)]);
    ++epoch;
    hello();
    return connecting;
  }
  if (reconnect) {
    input=Buffer.alloc(0);offset=0;
    let rejoining=relay&&!automatic?voiceRuntime.execute('connect'):null;
    rejoining?.catch(()=>{});
    await rejoinDevice(true, false);
    if (installedLan&&!lanStandby) {
      await until(()=>voiceRuntime.snapshot().connected,'replacement LAN peer sent authenticated hello');
      rejoining=voiceRuntime.execute('connect');
    }
    if(automatic)await until(()=>voiceRuntime.snapshot().phase==='active','paired device alone joined again after link loss');
    const rejoined=automatic?await readVoiceView():await rejoining;
    assert.equal(rejoined.phase,'active');
    assert.equal(rejoined.sessionId,sessionId);
    assert.equal(rejoined.deviceIdleConfirmed,false);
    if (headTouchV40) {
      const legacy = await assertHeadTouchReport(undefined);
      assert.ok(legacy.notExposed.includes('touchAndButtons'));
      console.log('The new Host accepted a peer whose hello uses the pre-v40 capability set.');
    }
    if (latencyView) assert.deepEqual((await readVoiceView()).latency,{enabled:true,latest:null});
    input=queue[0];offset=0;
    await until(()=>captions.length===6,'voice input waits while previous reply is pending');
    const busy=await ctx.sessionController.state({sessionId},AbortSignal.timeout(3000));
    assert.equal(busy.running,true);
    assert.deepEqual(busy.queue,[]);
    assert.equal(requests.length,finalTurnRequest);
    input=stop;offset=0;
    await until(()=>stops===1&&voiceRuntime.snapshot().phase==='listening','spoken Stop while waiting for DSH');
    assert.equal(voiceRuntime.snapshot().deviceIdleConfirmed,true);
    assert.equal(requests.length,finalTurnRequest);
    assert.equal(captions.length,6);
    input=Buffer.alloc(0);offset=0;
    if(automatic){
      await until(()=>!voiceRuntime.snapshot().connected,'spoken Stop closed the previous link');
      assert.equal(voiceRuntime.snapshot().applied,false);
      await rejoinDevice();
      await until(()=>voiceRuntime.snapshot().phase==='active','new device request after spoken Stop');
    }else assert.equal((await voiceRuntime.execute('connect')).phase,'active');
    input=queue[1];offset=0;
    await until(()=>captions.length===7,'a new voice input is held before submitting to DSH');
    if (latencyView || latencyLogs) await delay(180); // Measure this deliberate admission wait.
    assert.equal(requests.length,finalTurnRequest);
    assert.equal(outputFrames,beforeStop);
  }
  releaseLastReply();
  if (!reconnect) {
    await until(()=>ctx.agents.get(sessionId).status==='idle','underlying DSH finishes');
    assert.equal(outputFrames,beforeStop);
    assert.equal(captions.length,5,'late reply and the Stop utterance must stay off the device screen');
    assert.equal(requests.length,finalTurnRequest);
  } else {
    await until(()=>drains===3&&ctx.agents.get(sessionId).status==='idle','spoken round waiting across reconnect');
  }
  assert.equal(captions[4][0],'user');
  if (!device) assert.equal(timings.length,2,'cancelled turn must not emit a completed latency sample');
  let history=await readHistory(ctx);
  let switchedSession;
  assert.ok(JSON.stringify(history.records).includes(responseText(4)),'late reply must remain in DSH history');
  const after = await lookup();
  assert.equal(after.values.agentPreset, baseline.values.agentPreset);
  assert.equal(after.values.workingDirectory, baseline.values.workingDirectory);
  if (reconnect) {
    assert.equal(requests.length,finalTurnRequest+1);
    assert.ok(JSON.stringify(requests.at(-1)).includes(responseText(4)));
    assert.deepEqual(captions.slice(5).map(([speaker])=>speaker),['user','user','assistant']);
    assert.notEqual(captions[5][1],captions[6][1]);
    assert.ok(JSON.stringify(requests.at(-1).at(-1).content).includes(captions[6][1]));
    assert.equal(captions.at(-1)[1],responseText(5));
    assert.ok(outputFrames>beforeStop);
    assert.equal((await toolValue('stackchan_set_expression',{expression:'sad'})).expression,'sad');
    input=stop;offset=0;
    await until(()=>stops===2&&voiceRuntime.snapshot().phase==='listening','spoken Stop after reconnect');
    assert.equal(voiceRuntime.snapshot().deviceIdleConfirmed,true);
    assert.equal(requests.length,finalTurnRequest+1);
    assert.equal(captions.length,8);
    console.log(`After ${relay?'Relay':'LAN'} reconnect, spoken Stop cleared a waiting transcript; a fresh transcript waited for the old DSH reply and produced one new spoken response in the same session.`);
  } else if (liveDisable) {
    console.log('Live Loader disable stopped the active device, withdrew Remote/tools, joined the workers, and let the original DSH reply finish silently.');
  } else {
    console.log(`Spoken Stop released ${usb?'USB fixture':relay?'relay fixture':'WSS fixture'} before the pending DSH turn finished; late reply stayed silent.`);
  }
  if (voiceTrace) {
    const filename = join(profileDir, '.stackchan-diagnostics', 'voice.jsonl');
    let rows = [];
    await until(async () => {
      const raw = await readFile(filename, 'utf8').catch(error => {
        if (error.code !== 'ENOENT') throw error;
        return '';
      });
      rows = raw.slice(0, raw.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map(line => JSON.parse(line));
      return rows.some(row => row.event === 'lease-released' && row.outcome === 'idle-confirmed');
    }, 'durable installed voice trace');
    const events = rows.map(row => row.event);
    for (const event of ['usb-opened', 'usb-device-ready', 'usb-authenticated', 'local-input-ready',
        'capture-started', 'voice-active', 'capture-window', 'capture-ended', 'recognition-requested',
        'recognition-returned', 'dsh-turn-requested', 'dsh-turn-returned', 'playback-requested',
        'playback-drained', 'spoken-stop', 'camera-requested', 'camera-device-returned',
        'camera-saved']) assert.ok(events.includes(event), event);
    assert.ok(rows.some(row => row.event === 'capture-window' && row.usbReads > 0 &&
      row.inputFrames > 0 && row.frontendCalls > 0 && row.clockTicks > 0));
    assert.ok(rows.some(row => row.event === 'capture-ended' && row.outcome === 'stop-ack'));
    assert.ok(!JSON.stringify(rows).includes(sessionId), 'durable logs must not contain the bound session ID');
    console.log('Persisted USB trace contains opening, authentication, timing, capture and confirmed Stop without session content.');
  }
  if (latencyLogs) {
    const total = reconnect ? 3 : 2;
    await until(()=>latencyEntries().length===total,'installed Host latency receipts');
    const samples = latencyEntries();
    const required = ['asrQueueMs','asrMs','bridgeQueueMs','dshMs','ttsFirstPcmMs',
      'outputBufferMs','outputAckMs','segmentToFirstOutputAckMs','dshAdmissionMs',
      'dshPromptToPublicTextMs','dshPromptToTurnEndMs','dshPublicTextToTurnEndMs','dshTurnEndToOutputAckMs'];
    for (const { version, transport, ...sample } of samples) {
      assert.equal(version,1);
      assert.equal(transport,preferences.transport);
      assert.ok(required.every(name=>Object.hasOwn(sample,name)));
      assert.ok(Object.keys(sample).every(name=>required.includes(name)||name==='ttsPreparedBeforeTurnEndMs'));
      assert.ok(Object.values(sample).every(value=>Number.isInteger(value)&&value>=0));
    }
    if (reconnect) assert.ok(samples.at(-1).dshAdmissionMs>=100,'measure time waiting for the older turn separately');
    console.log('VOICE_TIMINGS '+JSON.stringify(samples));
    console.log('Installed Host logged '+samples.length+' numeric samples; stopped and disconnected turns emitted no sample.');
  } else {
    assert.deepEqual(latencyEntries(),[],'the installed Host must not emit latency logs by default');
  }
  if (latencyView) {
    await until(()=>voiceRuntime.snapshot().latency.latest!==null,'one completed latency sample');
    const view=await readVoiceView();
    const sample=view.latency.latest;
    assert.equal(view.latency.enabled,true);
    assert.ok(sample.asrMs>0&&sample.segmentToFirstOutputAckMs>0);
    assert.ok(Object.values(sample).every(value=>Number.isInteger(value)&&value>=0));
    assert.ok(Object.keys(sample).every(name=>name.endsWith('Ms')));
    if (reconnect) assert.ok(sample.dshAdmissionMs>=100);
    console.log('Owner Remote returned the real latency preview; Host log export '+(latencyLogs?'enabled.':'disabled.'));
  }
  if (device && !reconnect) {
    if (liveDisable) {
      await pluginEntry.update({disabled:false});
      await until(() => ctx.get('stackchanSettings') && ctx.tools.get('stackchan_set_expression'), 'Loader re-enabled the plugin');
      assert.deepEqual(ctx.stackchanSettings.snapshot().preferences, preferences);
      assert.deepEqual(await readHistory(ctx), history);
      voiceRuntime=ctx.stackchanVoice;
      assert.equal((await readVoiceView()).phase, 'stopped');
      await voiceAction('start');
      const restored=await connectReplacementUsb();
      assert.equal(restored.phase, 'active');
      assert.equal(restored.sessionId, sessionId);
    } else if(usbStandby){
      await Promise.race([usb.ended,delay(1500).then(()=>{throw Error('spoken Stop did not send USB TLS close');})]);
      await socket.terminate();
      await Promise.race([standbyReplacement.probed,standbyReplacement.secure.then(()=>{throw Error('TLS before second device touch');})]);
      assert.equal((await readVoiceView()).usbStandby,true);
      assert.equal((await readVoiceView()).applied,false);
      if(standbyTtsCheck){
        assert.equal(synthesisBeforeStop.length,1);
        assert.deepEqual(synthesisProcesses(),standbyTtsCheck==='retained'?synthesisBeforeStop:[]);
        assert.deepEqual(whisperProcesses(),[]);
      }
      socket=standbyReplacement.peer;
      device=await simulatedCapabilities(send,boot);
      socket.on('message',receive);
      ++epoch;
      standbyReplacement.tap();
      await standbyReplacement.secure;
      hello();
      await until(()=>voiceRuntime.snapshot().phase==='active','device only re-entered after spoken Stop');
      assert.equal((await readVoiceView()).sessionId,sessionId);
    } else {
      assert.equal(voiceRuntime.snapshot().connected, true, 'late capability results must not retire the authenticated connection');
      assert.equal((await voiceRuntime.execute('connect')).phase, 'active');
    }
    if (latencyView) assert.deepEqual((await readVoiceView()).latency,{enabled:true,latest:null});
    if(standbyTtsCheck){
      const samples=latencyEntries().length;
      const baseDrains=drains,baseRequests=requests.length;
      input=queue[0];offset=0;
      await until(()=>drains===baseDrains+1&&latencyEntries().length===samples+1,'first spoken reply after resuming USB standby');
      assert.equal(requests.length,baseRequests+1);
      const workers=synthesisProcesses();
      assert.equal(workers.length,1);
      assert.equal(workers[0]===synthesisBeforeStop[0],standbyTtsCheck==='retained');
      const {ttsFirstPcmMs,segmentToFirstOutputAckMs}=latencyEntries().at(-1);
      console.log('STANDBY_TTS '+JSON.stringify({mode:standbyTtsCheck,ttsFirstPcmMs,segmentToFirstOutputAckMs}));
      history=await readHistory(ctx);
    }
    assert.equal((await toolValue('stackchan_set_expression', { expression: 'sad' })).expression, 'sad');
    const stopped=await voiceAction('stop');
    assert.equal(stopped.deviceIdleConfirmed, true);
    if(usbStandby){
      assert.equal(stopped.usbStandby,false);
      assert.equal(stopped.connected,false);
      if(serialProcesses)assert.deepEqual(serialProcesses(),[]);
      if(standbyTtsCheck)assert.deepEqual(synthesisProcesses(),[]);
      console.log('Armed USB waited for each device touch, closed TLS after spoken Stop, rejoined the same session and released the serial port when the owner revoked standby.');

      await socket.terminate();
      const interrupted=await startUsbPty(bundle.record,{standby:true});
      socket=interrupted.peer;
      device=await simulatedCapabilities(send,boot);
      socket.on('message',receive);
      ++epoch;
      assert.equal((await voiceAction('arm-usb')).usbStandby,true);
      await Promise.race([interrupted.probed,interrupted.secure.then(()=>{throw Error('TLS before third device touch');})]);
      interrupted.tap();
      await interrupted.secure;
      hello();
      await until(()=>voiceRuntime.snapshot().phase==='active','USB fixture active before unplug');
      const faultEntries=()=>ctx.logger.buffer.filter(record=>record.name==='stackchan-voice'
        &&record.args[0]==='STACKCHAN_VOICE_FAULT %s');
      assert.equal(faultEntries().length,0,'normal Stop must not log an active fault');
      if(hostUsbCut){
        const traceRecords=()=>ctx.logger.buffer.filter(record=>record.name==='stackchan-voice' &&
          record.args[0]==='STACKCHAN_VOICE_TRACE %s').map(record=>JSON.parse(record.args[1]));
        const capture=traceRecords().findLast(row=>row.event==='capture-started').capture;
        await until(()=>traceRecords().some(row=>row.capture===capture && row.event==='capture-window' &&
          row.inputFrames>0 && row.usbReads>0), 'active input before the controlled Host cut');
        const cutMarkers=[];
        const cut=createUsbTrialCut({helper:join(bundlePath,'scripts/agent_usb_audio.py'),port:fixturePort,
          report:name=>cutMarkers.push(name)});
        assert.throws(()=>cut({transport:'usb',phase:'listening',connected:true}),{code:'trial_usb_not_active'});
        assert.equal(serialProcesses().length,1);
        active=false;
        cut(voiceRuntime.snapshot());
        assert.deepEqual(cutMarkers,['controlled-usb-cut-requested','controlled-usb-cut-issued']);
        assert.throws(()=>cut(voiceRuntime.snapshot()),{code:'trial_cut_already_issued'});
        await until(()=>traceRecords().some(row=>row.capture===capture && row.event==='lease-released' &&
          row.outcome==='device-unconfirmed'), 'controlled Host cut and unconfirmed device release are distinct');
        assert.ok(traceRecords().some(row=>row.capture===capture && row.event==='capture-ended' &&
          row.outcome==='link-ended'));
        console.log('Controlled Mac cut stopped only its installed USB helper and left the fixture peer in place; trace retained active input and unconfirmed Stop.');
      }else{
        active=false;
        await socket.terminate();
      }
      await until(()=>{
        const status=voiceRuntime.snapshot();
        return !status.usbStandby&&status.lastError==='voice_usb_standby_interrupted';
      },'unplug ends USB standby and stops probing');
      assert.equal((await readVoiceView()).deviceIdleConfirmed,false);
      if(serialProcesses)assert.deepEqual(serialProcesses(),[]);
      const faults=faultEntries();
      assert.equal(faults.length,1,'simulated USB loss should produce one first-fault record');
      assert.equal(faults[0].type,'warn');
      const fault=JSON.parse(faults[0].args[1]);
      assert.deepEqual(Object.keys(fault).sort(),['activeMs','code','firstInputReceived','source','transport','version']);
      assert.equal(fault.version,1);
      assert.equal(fault.transport,'usb');
      assert.equal(fault.source,'transport');
      assert.equal(fault.code,'disconnected');
      assert.equal(typeof fault.firstInputReceived,'boolean');
      assert.ok(Number.isInteger(fault.activeMs)&&fault.activeMs>=0);
      console.log(hostUsbCut
        ? 'Controlled Mac cut disarmed standby without reopening the port or claiming a device Stop receipt.'
        : 'USB unplug disarmed standby without reopening the port or claiming a device Stop receipt.');
      console.log('Native Host logged one redacted first fault after active USB loss, before cleanup obscured the cause.');
    }
    console.log(liveDisable
      ? 'Re-enabling retained preferences and history and authenticated a fresh USB connection for the same selected session.'
      : 'Stop cancelled the pending native photo and motion and the same connection accepted a new expression after re-entry.');
  }
  if(usbPty&&!usbStandby){
    assert.equal((await voiceRuntime.execute('connect')).phase,'active');
    active=false;input=Buffer.alloc(0);offset=0;
    await socket.terminate();
    await until(()=>voiceRuntime.snapshot().canReconnect,'USB unplug released the local voice and serial owners');
    if (whisperProcesses) assert.deepEqual(whisperProcesses(), []);
    assert.equal(voiceRuntime.snapshot().deviceIdleConfirmed,false);
    const replugged = await connectReplacementUsb();
    assert.equal(replugged.phase,'active');assert.equal(replugged.sessionId,sessionId);
    const before={requests:requests.length,drains,stops};
    input=queue[0];offset=0;
    await until(()=>drains===before.drains+1,'spoken reply after USB replug');
    assert.equal(requests.length,before.requests+1);
    assert.ok(JSON.stringify(requests.at(-1)).includes(responseText(finalTurnRequest)));
    input=stop;offset=0;
    await until(()=>stops===before.stops+1&&voiceRuntime.snapshot().phase==='listening','spoken Stop after USB replug');
    assert.equal(voiceRuntime.snapshot().deviceIdleConfirmed,true);
    history=await readHistory(ctx);
    console.log('Packaged serial helper recovered from virtual unplug and replug and kept the original DSH history and spoken Stop.');
  }
  if (longConversation) {
    const entered = await voiceRuntime.execute('connect');
    assert.equal(entered.phase, 'active');
    assert.equal(entered.sessionId, sessionId);
    const continuousWhisper = whisperProcesses?.();
    if (continuousWhisper) assert.equal(continuousWhisper.length, 1);
    const conversationEpoch = epoch;
    for (let round = 0; round < 10; round++) {
      const expected = { request: requests.length + 1, drain: drains + 1, captions: captions.length + 2 };
      input = round === 0 ? queue[3] : queue[round % 2];
      offset = 0;
      await until(() => drains >= expected.drain, `continuous voice round ${round + 1}`);
      assert.equal(epoch, conversationEpoch);
      assert.equal(voiceRuntime.snapshot().phase, 'active');
      assert.equal(voiceRuntime.snapshot().sessionId, sessionId);
      assert.deepEqual([requests.length, drains, captions.length], [expected.request, expected.drain, expected.captions]);
      assert.equal(captions.at(-2)[0], 'user');
      assert.deepEqual(captions.at(-1), ['assistant', responseText(expected.request)]);
      const messages = JSON.stringify(requests.at(-1));
      assert.ok(JSON.stringify(requests.at(-1).at(-1)).includes(captions.at(-2)[1]), 'the turn contains the current spoken input');
      assert.ok(messages.includes(desktopSeed), 'the original desktop turn remains available');
      assert.ok(messages.includes(responseText(expected.request - 1)), 'each voice turn inherits the prior reply');
      if (round === 0) assert.match(captions.at(-2)[1], /不要停止/u);
    }
    if (continuousWhisper) assert.deepEqual(whisperProcesses(), continuousWhisper);
    console.log('Ten consecutive spoken rounds stayed on one authenticated session and preserved the existing context. The negated Stop was handled as a normal utterance.');

    playbackTurn = requests.length + 1;
    const before = { drains, stops, captions: captions.length };
    pacedPlayback = { frames: [], reference: [], played: 0, discarded: 0 };
    input = queue[2];offset = 0;
    await until(() => pacedPlayback.played >= 100, 'one second of paced playback before spoken Stop');
    assert.equal(requests.length, playbackTurn);
    assert.equal(drains, before.drains, 'playback must still be in progress');
    assert.ok(pacedPlayback.frames.length > 0, 'fixture has pending output when Stop is spoken');
    input = stop;offset = 0;
    await until(() => stops > before.stops && voiceRuntime.snapshot().phase === 'listening', 'spoken Stop with playback and synthetic echo');
    if (whisperProcesses) assert.deepEqual(whisperProcesses(), []);
    assert.equal(stops, before.stops + 1);
    const { played, discarded } = pacedPlayback;
    assert.ok(played > 100 && discarded > 0, `Stop interrupts still-buffered audio (played ${played}, discarded ${discarded})`);
    assert.equal(voiceRuntime.snapshot().deviceIdleConfirmed, true);
    assert.equal(voiceRuntime.snapshot().connected, true);
    assert.equal(voiceRuntime.snapshot().lastError, '', 'the stop should complete without a turn or transport error');
    assert.equal(drains, before.drains, 'no full playback drain acknowledgement for the stopped reply');
    const framesWhenStopped = outputFrames;
    await delay(400);
    assert.equal(outputFrames, framesWhenStopped, 'no late PCM');
    assert.equal(requests.length, playbackTurn, 'Stop does not become a DSH request');
    assert.equal(captions.length, before.captions + 2, 'Stop adds no caption');
    pacedPlayback = undefined;

    assert.equal((await voiceRuntime.execute('connect')).sessionId, sessionId);
    input = queue[0];offset = 0;
    await until(() => drains === before.drains + 1, 'one fresh reply after stopping playback');
    assert.equal(requests.length, playbackTurn + 1);
    assert.ok(JSON.stringify(requests.at(-1)).includes(responseText(playbackTurn)), 'interrupted playback keeps the original DSH reply');
    assert.deepEqual(captions.at(-1), ['assistant', responseText(playbackTurn + 1)]);
    assert.equal((await voiceRuntime.execute('stop')).deviceIdleConfirmed, true);
    history = await readHistory(ctx);
    console.log(`Spoken Stop interrupted paced playback through synthetic echo, cleared ${discarded} buffered PCM frames, and accepted a fresh turn on the same session.`);
    if (oversizedReply) console.log(`The full ${playbackReply.length}-unit reply remained in DSH history after stopping segmented playback.`);
  }
  if (sessionSwitch) {
    const otherWorkspace = join(directory, 'alternate-workspace');
    await mkdir(otherWorkspace);
    const otherSeed = 'This other desktop conversation has an independent violet notebook.';
    const {sessionId: otherId, agentPreset: otherPreset} = await ctx.sessionController.create({
      cwd: otherWorkspace, agentPreset: 'minimal',
    });
    assert.notEqual(otherId, sessionId);
    assert.equal(baseline.values.agentPreset, 'standard');
    assert.equal(otherPreset, 'minimal');
    const readOther = () => ctx.sessionController.projections({sessionId: otherId}, AbortSignal.timeout(3000));
    const otherBaseline = await readOther();
    const otherSeedRequest = requests.length + 1;
    await ctx.sessionController.prompt({sessionId: otherId, requestId: 'other-desktop-seed', mode: 'queue',
      content: [{type: 'text', text: otherSeed}]}, AbortSignal.timeout(5000));
    await until(() => requests.length === otherSeedRequest && ctx.agents.get(otherId).status === 'idle', 'alternate preset and prior desktop history');

    assert.equal((await voiceRuntime.execute('connect')).sessionId, sessionId);
    heldSessionSwitchTurn = requests.length + 1;
    input = queue[1];offset = 0;
    await until(() => requests.length === heldSessionSwitchTurn, 'old session still waiting for its reply');
    const firstRequest = JSON.stringify(requests.at(-1));
    assert.ok(firstRequest.includes(desktopSeed) && !firstRequest.includes(otherSeed));
    assert.match(JSON.stringify(requests.at(-1).filter(message => message.role === 'system')), /You are a coding agent powered by/u);

    await savePreferences(ctx, {...preferences, sessionId: otherId});
    const pending = await readVoiceView();
    assert.equal(pending.phase, 'active');
    assert.equal(pending.sessionId, sessionId);
    assert.equal(pending.pendingChanges, true);
    await assert.rejects(voiceRuntime.execute('connect'), {code: 'voice_restart_required'});
    assert.equal((await voiceRuntime.execute('stop')).deviceIdleConfirmed, true);
    assert.equal((await voiceRuntime.execute('shutdown')).phase, 'stopped');
    await socket.terminate();
    input = Buffer.alloc(0);offset = 0;

    const restarted = await voiceRuntime.execute('start');
    assert.equal(restarted.sessionId, otherId);
    assert.equal(restarted.pendingChanges, false);
    let switched;
    if (usbPty) switched = await connectReplacementUsb();
    else if (relay) {
      const connecting = voiceRuntime.execute('connect');
      connecting.catch(() => {});
      await rejoinDevice();
      switched = await connecting;
    } else {
      await rejoinDevice();
      await until(() => voiceRuntime.snapshot().connected, 'new voice service receives a fresh LAN Hello');
      switched = await voiceRuntime.execute('connect');
    }
    assert.equal(switched.phase, 'active');
    assert.equal(switched.sessionId, otherId);
    const {request, drain, captionCount} = {request: requests.length + 1, drain: drains + 1, captionCount: captions.length + 2};
    input = queue[0];offset = 0;
    await until(() => drains === drain && ctx.agents.get(otherId).status === 'idle', 'alternate session answers before the old one finishes');
    assert.equal(ctx.agents.get(sessionId).status, 'running');
    assert.equal(requests.length, request);
    assert.equal(captions.length, captionCount);
    assert.deepEqual(captions.at(-1), ['assistant', responseText(request)]);
    const secondRequest = JSON.stringify(requests.at(-1));
    assert.ok(secondRequest.includes(otherSeed) && secondRequest.includes(responseText(otherSeedRequest)));
    assert.ok(!secondRequest.includes(desktopSeed) && !secondRequest.includes(responseText(heldSessionSwitchTurn)));
    assert.match(JSON.stringify(requests.at(-1).filter(message => message.role === 'system')), /You are a helpful software engineer assistant\./u);
    assert.doesNotMatch(secondRequest, /You are a coding agent powered by/u);

    const denied = await runTool('stackchan_set_expression', {expression: 'sad'});
    assert.equal(denied.isError, true);
    assert.match(denied.error.message, /not the session connected to Sion/);
    const allowed = await runTool('stackchan_set_expression', {expression: 'happy'}, ctx.agents.get(otherId));
    assert.equal(allowed.isError, false);
    assert.equal(allowed.value.expression, 'happy');

    const framesBeforeOldReply = outputFrames;
    const otherHistory = await readHistory(ctx, otherId);
    releaseSessionSwitchReply();
    await until(() => ctx.agents.get(sessionId).status === 'idle', 'late reply finishes only in the original DSH session');
    await delay(400);
    assert.equal(outputFrames, framesBeforeOldReply);
    assert.equal(captions.length, captionCount);
    history = await readHistory(ctx);
    assert.ok(JSON.stringify(history.records).includes(responseText(heldSessionSwitchTurn)));
    assert.ok(!JSON.stringify(history.records).includes(otherSeed));
    assert.deepEqual(await readHistory(ctx, otherId), otherHistory);
    const otherAfter = await readOther();
    assert.equal(otherAfter.values.agentPreset, otherBaseline.values.agentPreset);
    assert.equal(otherAfter.values.workingDirectory, otherBaseline.values.workingDirectory);
    switchedSession = {id: otherId, history: otherHistory, values: otherAfter.values};
    assert.equal((await voiceRuntime.execute('stop')).deviceIdleConfirmed, true);
    await savePreferences(ctx, preferences);
    console.log('Switching sessions applied the second DSH preset and history only after restart. A late reply stayed in the first session and only the new session controlled the device.');
  }
  if(automatic){
    await until(()=>!voiceRuntime.snapshot().connected,'spoken Stop closes the old armed connection');
    assert.equal((await readVoiceView())[standbyField],true);
    assert.equal((await voiceAction('stop'))[standbyField],false);
    assert.equal((await readVoiceView()).applied,false);
    if(lanStandby){
      await rejoinDevice();
      await until(()=>voiceRuntime.snapshot().connected,'post-revocation LAN hello');
      const muted=await readVoiceView();
      assert.equal(muted.lanStandby,false);
      assert.equal(muted.applied,false);
      assert.equal(active,false);
      assert.deepEqual(whisperProcesses?.()??[],[]);
      console.log('Armed LAN accepted device-only joins after link loss and spoken Stop. After owner Stop, the next authenticated hello stayed idle.');
    }else console.log('Armed Relay survived rendezvous expiry, accepted device-only joins after link loss and spoken Stop, and closed standby at the owner’s request.');
  }
  if(usbStandby){
    await assert.rejects(voiceRuntime.execute('shutdown'),{code:'voice_release_unconfirmed'});
    assert.equal((await readVoiceView()).phase,'stopped');
    assert.equal((await readVoiceView()).deviceIdleConfirmed,false);
  }else assert.equal((await voiceRuntime.execute('shutdown')).phase,'stopped');
  if (whisperProcesses) {
    assert.deepEqual(whisperProcesses(), []);
    console.log('Managed Whisper worker stayed unique across turns and exited before the voice lease was released.');
  }
  if (installedLan) await confirmLanListenerReleased(wssUrl);
  if (latencyView) assert.deepEqual((await readVoiceView()).latency,{enabled:false,latest:null});
  if(captionOnlyTest){
    const spoken=ctx.stackchanSettings.snapshot().preferences;
    await savePreferences(ctx,{...spoken,captionOnly:true,ttsBackend:'unconfigured'});
    assert.equal(ctx.stackchanSettings.snapshot().preferences.captionOnly,true);
    await voiceAction('start');
    assert.equal((await voiceAction('arm-relay')).relayStandby,true);
    await rejoinDevice(false);
    await until(()=>voiceRuntime.snapshot().lastError==='voice_caption_required'&&!voiceRuntime.snapshot().connected,
      'caption-only rejected the peer before Start');
    assert.equal((await readVoiceView()).applied,false);
    assert.equal((await readVoiceView()).relayStandby,true);
    assert.equal(active,false,'missing caption declaration does not start the device');
    if(checkConversationReport) await assertConversationReport({replyMode:'inactive',captionChannel:'unknown'});
    await rejoinDevice();
    await until(()=>voiceRuntime.snapshot().phase==='active','correct Text peer rejoined while standby remained armed');
    assert.equal((await readVoiceView()).sessionId,sessionId);
    if(checkConversationReport) {
      const text=await assertConversationReport({replyMode:'caption-only',captionChannel:'requested'});
      assert.equal(text.features.audio.condition,'ready');
      assert.equal(text.features.playbackFence.availability,'supported');
      assert.equal(text.features.playbackFence.condition,'not-available');
    }
    const counters={outputFrames,drains,requests:requests.length,stops,captions:captions.length};
    for(let round=0;round<2;round++){
      input=queue[round];offset=0;
      await until(()=>captions.length===counters.captions+(round+1)*2,'caption-only public reply was delivered');
      assert.deepEqual(captions.at(-1),['assistant',responseText(counters.requests+round+1)]);
    }
    input=stop;offset=0;
    await until(()=>stops===counters.stops+1&&voiceRuntime.snapshot().phase==='listening','spoken Stop in caption-only mode');
    assert.equal(outputFrames,counters.outputFrames);assert.equal(drains,counters.drains);
    assert.equal(requests.length,counters.requests+2);
    assert.equal(voiceRuntime.snapshot().latency.latest,null);
    assert.equal((await voiceAction('shutdown')).phase,'stopped');
    if(checkConversationReport) {
      await assertConversationReport({replyMode:'inactive',captionChannel:'unknown'});
      console.log('Owner Gateway and session tool agreed on spoken, caption-only and inactive modes, including loss of the authenticated caption request.');
    }
    await savePreferences(ctx,{...ctx.stackchanSettings.snapshot().preferences,ttsBackend:spoken.ttsBackend});
    history=await readHistory(ctx);
    console.log('Caption-only standby rejected a peer without Text, delivered two rounds after a device-only Text rejoin with no PCM or drain, and honored spoken Stop in the same session.');
  }
  if (liveDisable) {
    await voiceAction('start');
    await until(() => synthesisProcesses().length === 1, 'explicit Start launched one idle synthesis process');
    assert.equal(voiceRuntime.snapshot().connected, false);
    assert.deepEqual(whisperProcesses(), []);
    await disablePlugin();
    assert.equal(voiceRuntime.snapshot().deviceIdleConfirmed, false);
    assert.deepEqual(await readHistory(ctx), history);
    console.log('Live Loader disable while waiting for a device joined idle Kokoro without starting capture or changing the selected session.');
  }
  async function runProfileRecovery() {
    const stages=[];
    const noRunning=async stage=>{
      const deadline=performance.now()+5000;
      let observation;
      do {
        observation=await stage.call('observe');
        if(!observation.running)return observation;
        await delay(20);
      } while(performance.now()<deadline);
      assert.fail('DSH did not finish the fixture turn');
    };
    async function launch() {
      const worker=fork(new URL('./dsh_native_voice_profile_stage.mjs',import.meta.url),[],{
        cwd:workspace,serialization:'advanced',stdio:['ignore','ignore','inherit','ipc'],timeout:90000,
      });
      const exit=once(worker,'exit');
      const waitForReply=()=>Promise.race([
        once(worker,'message',{signal:AbortSignal.timeout(33000)}).then(([value])=>value),
        exit.then(([code,signal])=>{throw new Error(`Recovery Host exited before replying: ${signal??code}`);}),
      ]);
      stages.push({worker,exit});
      const ready=waitForReply();
      worker.send({dshDirectory:resolve(repository,dshDirectory),profile,patch,sessionId,recovery:true});
      assert.deepEqual(await ready,{ready:true});
      return {worker,exit,async call(action){
        const reply=waitForReply();
        worker.send(action);
        return reply;
      }};
    }
    async function joinAndSpeak(stage,sample) {
      assert.equal((await stage.call('start')).phase,'listening');
      await rejoinDevice();
      assert.ok(socket.readyState===WebSocket.OPEN);
      const deadline=performance.now()+5000;
      while(!(await stage.call('observe')).connected) {
        assert.ok(performance.now()<deadline,'fresh device hello is authenticated');
        await delay(20);
      }
      const connected=await stage.call('connect');
      assert.equal(connected.phase,'active');
      assert.equal(connected.sessionId,sessionId);
      const drained=drains+1, expected=requests.length+1;
      input=sample;offset=0;
      await until(()=>drains===drained,'completed reply on the new DSH Host process');
      assert.equal(requests.length,expected);
      assert.deepEqual(captions.at(-1),['assistant',responseText(expected)]);
      return {request:expected,confirmed:await noRunning(stage)};
    }
    function liveWorkerIds(pid) {
      const workers=[audioProcesses(pid),whisperProcesses(pid),synthesisProcesses(pid),identityProcesses(pid)];
      assert.deepEqual(workers.map(group=>group.length),[1,1,1,1]);
      return new Set(workers.flat());
    }
    try {
      const old=await launch();
      const before=await old.call('observe');
      assert.equal(before.phase,'stopped');
      assert.deepEqual(before.preferences,preferences);
      assert.deepEqual(before.history,history);
      assert.deepEqual(before.projection,{agentPreset:baseline.values.agentPreset,workingDirectory:baseline.values.workingDirectory});
      const {request,confirmed}=await joinAndSpeak(old,queue[0]);
      assert.equal(confirmed.phase,'active');
      assert.ok(JSON.stringify(confirmed.history.records).includes(responseText(request)));
      const workerIds=liveWorkerIds(old.worker.pid);
      const journal=await readFile(statePath);
      const lost=once(socket,'close',{signal:AbortSignal.timeout(5000)});
      const beforeCrash={requests:requests.length,outputFrames,stops};
      assert.equal(old.worker.kill('SIGKILL'),true);
      assert.deepEqual(await old.exit,[null,'SIGKILL']);
      await lost;
      active=false;input=Buffer.alloc(0);offset=0;
      await until(()=>{
        const pids=execFileSync('/bin/ps',['-ax','-o','pid='],{encoding:'utf8'}).trim().split(/\s+/u);
        return !pids.some(pid=>workerIds.has(Number(pid)));
      },'audio, recognition, synthesis and pairing helpers exit after abrupt parent death');
      assert.equal((await pairing.call({action:'snapshot'})).ok,true);
      assert.deepEqual(await readFile(statePath),journal);
      assert.deepEqual({requests:requests.length,outputFrames,stops},beforeCrash);
      const next=await launch();
      const restored=await next.call('observe');
      assert.equal(restored.phase,'stopped');
      assert.equal(restored.connected,false);
      assert.equal(restored.applied,false);
      assert.equal(restored.running,false);
      assert.deepEqual(restored.preferences,confirmed.preferences);
      assert.deepEqual(restored.projection,confirmed.projection);
      assert.deepEqual(restored.history,confirmed.history);
      assert.equal(requests.length,beforeCrash.requests);
      const continued=await joinAndSpeak(next,queue[1]);
      assert.equal(continued.request,request+1);
      const recoveredInput=JSON.stringify(requests.at(-1));
      assert.ok(recoveredInput.includes(desktopSeed)&&recoveredInput.includes(responseText(request)));
      assert.deepEqual(continued.confirmed.projection,confirmed.projection);
      assert.equal((await next.call('stop')).deviceIdleConfirmed,true);
      next.worker.send('finish');
      assert.deepEqual(await next.exit,[0,null]);
      assert.deepEqual(await readFile(statePath),journal);
      console.log('SIGKILL of the installed DSH Host closed the socket and all four owned helpers. A fresh official Host recovered the exact selected session, history and preferences, reauthenticated LAN and continued the conversation once.');
      return continued.confirmed.history;
    } finally {
      for(const {worker,exit} of stages) {
        if(worker.exitCode===null&&worker.signalCode===null)worker.kill('SIGKILL');
        await exit;
      }
    }
  }

  assert.equal((await pairing.call({action:'snapshot'})).ok,true);
  if (tarball) {
    const confirmedPairing = pairingProbe ? await readFile(statePath) : null;
    await closeProfile();
    if (profileRecovery) history=await runProfileRecovery();
    if (upgradeFrom) {
      manageBundle('add',upgradeFrom,'--ignore-scripts');
      await verifyPluginEntry(upgradeFrom);
      const {preferences:restored,projection,history:restoredHistory}=await readPreviousRelease(false);
      for (const name of Object.keys(legacyPreferences)) {
        assert.deepEqual(restored[name], selectedPreferences[name]??legacyPreferences[name]);
      }
      assert.equal(projection.agentPreset,baseline.values.agentPreset);
      assert.equal(projection.workingDirectory,baseline.values.workingDirectory);
      assert.deepEqual(restoredHistory,history);
      console.log('Reinstalling the previous package restored the old plugin and kept the same session, history and original preference fields.');
    }
    manageBundle('remove', 'dsh-stackchan');
    assert.ok(!(await readBundles()).includes('dsh-stackchan'));
    await assert.rejects(realpath(bundlePath), { code: 'ENOENT' });
    app = await openProfile();
    assert.equal(app.ctx.get('stackchanSettings'), undefined);
    const reopened = await app.ctx.sessionController.projections({sessionId}, AbortSignal.timeout(3000));
    assert.equal(reopened.values.agentPreset, baseline.values.agentPreset);
    assert.equal(reopened.values.workingDirectory, baseline.values.workingDirectory);
    assert.deepEqual(await readHistory(app.ctx), history);
    if (confirmedPairing) {
      assert.deepEqual(await readFile(statePath), confirmedPairing);
      console.log('The exact identity installed through the device probe authenticated USB voice. The confirmed independent pairing journal stayed intact through plugin removal.');
    }
    if (switchedSession) {
      const other = await app.ctx.sessionController.projections({sessionId: switchedSession.id}, AbortSignal.timeout(3000));
      assert.equal(other.values.agentPreset, switchedSession.values.agentPreset);
      assert.equal(other.values.workingDirectory, switchedSession.values.workingDirectory);
      assert.deepEqual(await readHistory(app.ctx, switchedSession.id), switchedSession.history);
    }
    console.log('Official CLI removal withdrew the bundle and preserved the exact session history and settings scope.');
  }
} finally {
  clearInterval(timer);
  releaseLastReply();
  releaseSessionSwitchReply();
  await voiceRuntime?.dispose().catch(()=>{});
  await socket?.terminate();
  if(standbyReplacement?.peer!==socket)await standbyReplacement?.peer.terminate();
  await relay?.service.close();
  if (lanReservation) await new Promise(resolve => lanReservation.close(resolve));
  await pairing?.dispose();
  await app?.shutdown.shutdown(process.exitCode??0);
  server.closeAllConnections();
  await new Promise(ok=>server.close(ok));
  process.chdir(repository);
  await rm(directory,{recursive:true,force:true});
}
