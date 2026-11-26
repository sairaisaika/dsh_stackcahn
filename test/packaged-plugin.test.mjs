import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot, initProfile, readProfilePatches } from '@deepseek-ai/dsh-app-boot';

const run = promisify(execFile);
const repository = fileURLToPath(new URL('../', import.meta.url));

async function eventually(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'native loader did not settle within 3 seconds');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('packed bundle loads by package name, registers native Remote metadata and withdraws on disable', async t => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'sion-packed-')));
  let ctx;
  t.after(async () => { await ctx?.fiber.dispose(); await rm(home, { recursive: true, force: true }); });
  const { stdout } = await run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', home],
    { cwd: repository, timeout: 30000, maxBuffer: 1024 * 1024 });
  const [packed] = JSON.parse(stdout);
  const files = packed.files.map(file => file.path);
  for (const required of ['cordis.patch.yml', 'client/client.js', 'lib/typert.host.js',
    'lib/remote-api.js', 'lib/typert.remote-client.js', 'scripts/prepare_runtime.py',
    'scripts/voice_environment.py', 'src/voice-environment.mjs', 'scripts/agent_pairing_host.py', 'scripts/agent_pairing_identity.py', 'src/voice-runtime.mjs', 'src/local-voice.mjs', 'scripts/agent_environment.py',
    'scripts/prepare_voice_installation.py', 'src/voice-installation.mjs', 'vendor/voice/installer-assets.json', 'vendor/voice/build-tools.lock',
    'scripts/agent_pairing_usb.py', 'scripts/pairing.mjs',
    'src/local-speech.mjs', 'scripts/local_speech.py', 'scripts/prepare_voice.py',
    'src/local-audio.mjs', 'scripts/local_audio.py', 'scripts/prepare_audio.py',
    'vendor/audio/assets.json', 'vendor/audio/NOTICE.md', 'vendor/audio/speexdsp-COPYING', 'vendor/audio/silero-LICENSE',
    'vendor/audio/localvqe-LICENSE', 'vendor/audio/ggml-LICENSE',
    'vendor/voice/assets.json', 'vendor/voice/requirements-macos-arm64.lock', 'vendor/voice/NOTICE.md',
    'vendor/pyserial/pyserial-3.5-py2.py3-none-any.whl', 'vendor/pyserial/LICENSE.txt'])
    assert.ok(files.includes(required), `missing packaged runtime file: ${required}`);
  assert.equal(files.some(path => /^(?:\.local|work|node_modules)\//.test(path)), false);

  const modules = join(home, 'node_modules');
  const installed = join(modules, 'dsh-stackchan');
  await mkdir(installed, { recursive: true });
  await run('tar', ['-xzf', join(home, packed.filename), '--strip-components=1', '-C', installed], { timeout: 10000 });
  // Reuse the pinned SDK dependency installation, but resolve our package only
  // from the extracted tarball. No source-plugin injection or manual TYPERT registration.
  for (const name of await readdir(join(repository, 'node_modules'))) {
    if (!name.startsWith('.') && name !== 'dsh-stackchan')
      await symlink(join(repository, 'node_modules', name), join(modules, name));
  }
  assert.equal(await realpath(installed), installed);
  const manifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
  assert.equal(manifest.dsh.client.platform, 'web');
  assert.deepEqual(manifest.dsh.client.inject,
    ['@deepseek-ai/dsh-client-ui-settings', '@deepseek-ai/dsh-api-remotes']);
  await access(join(installed, manifest.exports['./client']));

  const dir = join(home, 'profiles', 'test');
  initProfile(dir, ['dsh-stackchan']);
  await writeFile(join(home, 'package.json'), JSON.stringify({ name: 'sion-packed-fixture', private: true }));
  await writeFile(join(dir, 'cordis.yml'), JSON.stringify([
    { id: 'registry', name: '@deepseek-ai/dsh-typert-registry' },
    { id: 'typert-loader', name: '@deepseek-ai/dsh-typert-loader' },
    { id: 'gateway', name: '@deepseek-ai/dsh-api-gateway' },
    { id: 'config-editor', name: '@deepseek-ai/dsh-config-editor' },
    { id: 'settings', name: '@deepseek-ai/dsh-settings' },
  ]));
  const profile = { name: 'test', startedBundles: ['dsh-stackchan'], dir,
    patchPath: join(dir, 'cordis.patch.yml'), installAnchor: join(home, 'package.json'),
    cwd: home, home, overlays: [], telemetryDisabledEnv: undefined };
  ctx = await boot('test', join(dir, 'cordis.yml'), readProfilePatches('test', profile), root => {
    root.provide('profileContext', profile);
    root.provide('appReady', { onReady: listener => { listener(); return () => {}; } });
    root.provide('remoteAccess', { decide: () => ({ kind: 'allow' }) });
  });
  const endpoints = [...['execute', 'diagnose', 'prepareRuntime', 'relay'].map(method => `stackchanPairing/${method}`), 'stackchanVoice/execute', 'stackchanVoice/environment'];
  await eventually(() => endpoints.every(endpoint => ctx.typert.local.get(endpoint)));
  assert.ok(ctx.typert.getPackage('dsh-stackchan', 'host'));
  const entries = [...ctx.loader.entries()].filter(entry => entry.options.name === 'dsh-stackchan');
  assert.equal(entries.length, 1);
  const entry = entries[0];
  assert.equal(entry.options.id, 'stackchan');
  assert.equal(ctx.settings.describe().find(row => row.ns === 'stackchan').autoGenerate, false);
  assert.equal(ctx.get('stackchanSettings').snapshot().applied, false);
  await assert.rejects(access(join(dir, '.stackchan')), { code: 'ENOENT' });

  const owner = { id: 'fixture-owner', ctx, principal: { kind: 'owner' },
    signal: new AbortController().signal, interactions: 'none' };
  const invoke = (args, peer = owner) => ctx.typertGateway.invoke({
    namespace: 'stackchanPairing', method: 'execute', args, peer,
  });
  const relay = (request, peer = owner) => ctx.typertGateway.invoke({ namespace: 'stackchanPairing', method: 'relay', args: { request }, peer });
  await assert.rejects(relay({ action: 'relay_check' }, { ...owner, principal: { kind: 'viewer' } }),
    error => error.code === 'stackchan/owner-required');
  await assert.rejects(relay({ action: 'relay_inspect', port: 'fake', revision: 'invalid', authorizeUsb: false }),
    error => error.code === 'gateway/input-invalid');
  const voiceState = await ctx.typertGateway.invoke({ namespace: 'stackchanVoice', method: 'execute', args: { action: 'snapshot' }, peer: owner });
  assert.equal(voiceState.phase, 'stopped');
  assert.equal(voiceState.applied, false);
  assert.equal(voiceState.capabilities.version, 1);
  assert.equal(voiceState.capabilities.voicePhase, 'stopped');
  assert.deepEqual(voiceState.capabilities.conversation, {replyMode:'inactive',captionChannel:'unknown'});
  assert.equal(voiceState.capabilities.features.audio.availability, 'unknown');
  assert.ok(voiceState.capabilities.notExposed.includes('nfc'));
  assert.equal(voiceState.installation.mode, 'managed');
  assert.equal(voiceState.installation.stage, 'idle');
  assert.equal(voiceState.installation.prerequisites, null);
  const prerequisites = await ctx.typertGateway.invoke({ namespace: 'stackchanVoice', method: 'execute', args: { action: 'check-installation' }, peer: owner });
  assert.equal(prerequisites.phase, 'stopped');
  assert.ok(prerequisites.installation.prerequisites.checkedAt > 0);
  assert.equal(prerequisites.installation.available, false);
  assert.doesNotMatch(JSON.stringify(prerequisites), /\/Users\/|\/opt\/|executable/);
  await assert.rejects(ctx.typertGateway.invoke({ namespace: 'stackchanVoice', method: 'execute', args: { action: 'prepare-environment' }, peer: { ...owner, principal: { kind: 'viewer' } } }),
    error => error.code === 'stackchan/owner-required');
  await assert.rejects(access(join(dir, '.stackchan-voice')), { code: 'ENOENT' });
  const voiceEnvironment = await ctx.typertGateway.invoke({ namespace: 'stackchanVoice', method: 'environment', args: { action: 'inspect' }, peer: owner });
  assert.equal(voiceEnvironment.filesVerified, false);
  assert.equal(voiceEnvironment.checks.find(row => row.id === 'python').status, 'unconfigured');
  await assert.rejects(access(join(dir, '.stackchan')), { code: 'ENOENT' });
  await assert.rejects(ctx.typertGateway.invoke({ namespace: 'stackchanVoice', method: 'execute', args: { action: 'start' }, peer: owner }),
    error => error.code === 'stackchan/voice-failed' && error.details.reason === 'voice_session_required');
  await assert.rejects(invoke({ request: { action: 'snapshot' } }),
    error => error.code === 'stackchan/pairing-failed' && error.details.reason === 'host_unconfigured');
  await assert.rejects(invoke({ request: { action: 'snapshot' } }, { ...owner, principal: { kind: 'viewer' } }),
    error => error.code === 'stackchan/owner-required');
  await assert.rejects(invoke({ request: { action: 'erase' } }), error => error.code === 'gateway/input-invalid');

  await entry.update({ disabled: true });
  await eventually(() => !ctx.typert.getPackage('dsh-stackchan', 'host'));
  assert.equal(ctx.get('stackchanSettings'), undefined);
  assert.equal(ctx.get('stackchanPairing'), undefined);
  for (const endpoint of endpoints) {
    assert.equal(ctx.typert.local.get(endpoint), undefined);
    assert.equal(ctx.typert.local.hasSeen(endpoint), true);
  }
  await assert.rejects(invoke({ request: { action: 'snapshot' } }),
    error => error.code === 'gateway/definition-unavailable');
  await entry.update({ disabled: false });
  await eventually(() => endpoints.every(endpoint => ctx.typert.local.get(endpoint)));
  assert.equal(ctx.get('stackchanSettings').snapshot().applied, false);
  await assert.rejects(invoke({ request: { action: 'snapshot' } }),
    error => error.code === 'stackchan/pairing-failed' && error.details.reason === 'host_unconfigured');
  await assert.rejects(access(join(dir, '.stackchan')), { code: 'ENOENT' });

  // Execute helpers from the installed package, including its bundled wheel.
  // This remains a temporary profile; the managed path never opens an unverified port.
  const environment = await ctx.typertGateway.invoke({ namespace: 'stackchanPairing',
    method: 'prepareRuntime', args: {}, peer: owner });
  assert.equal(environment.pythonReady, true);
  assert.equal(environment.deviceAccess, false);
  if (process.platform === 'darwin') assert.equal(environment.serial, 'available');
  const initial = await invoke({ request: { action: 'snapshot' } });
  assert.equal(initial.revision, 0);
  assert.equal(initial.connected, false);
  assert.equal(initial.activePairId, '');
  assert.deepEqual(await relay({ action: 'relay_check' }), { revision: 0, paired: false, pairingPending: false,
    host: 'missing', staged: 'missing', stagedRevision: '', device: null });
  if (process.platform === 'darwin') {
    assert.equal(environment.managedUsb, true);
    assert.equal(environment.localNetwork.status, 'available');
    assert.ok(environment.localNetwork.endpoints.length <= 16);
    for (const option of environment.localNetwork.endpoints) {
      assert.deepEqual(Object.keys(option).sort(), ['interfaceName', 'url']);
      assert.match(option.url, /^wss:\/\/[0-9.]+:9080\/audio$/);
    }
  }
  const inspect = { action: 'inspect', revision: 0, deviceId: '123456abcdef', port: '/dev/cu.unverified-fixture' };
  await assert.rejects(invoke({ request: inspect }), error => error.details.reason === 'device_access_disabled');
  await assert.rejects(invoke({ request: { ...inspect, authorizeUsb: true } }, { ...owner, principal: { kind: 'viewer' } }),
    error => error.code === 'stackchan/owner-required');
  await assert.rejects(invoke({ request: { ...inspect, authorizeUsb: true } }),
    error => error.details.reason === 'managed_usb_port_unavailable');
  assert.deepEqual(await invoke({ request: { action: 'snapshot' } }), initial);

  const pairId = 'a'.repeat(32), deviceToken = 'b'.repeat(64), hostToken = 'c'.repeat(64), endpoint = 'wss://relay.fixture.invalid/';
  const journal = join(dir, '.stackchan', 'pairing');
  const ident = '1'.repeat(32);
  await mkdir(join(journal, ident), { mode: 0o700 });
  await writeFile(join(journal, ident, 'pairing.json'), JSON.stringify({version:1,
    record:{pair_id:pairId},host:{cert:'fixture',key:'fixture'}}), {mode:0o600});
  await writeFile(join(journal, 'state.json'), JSON.stringify({version:1,revision:1,device:'123456abcdef',
    active:ident,candidate:null,pending:null,observed:{state:'paired',pairId}}), {mode:0o600});
  const roomId = 'd'.repeat(32), stagedRevision = 'e'.repeat(32);
  await writeFile(join(dir, '.stackchan-relay.json'), JSON.stringify({version:1,endpoint,roomId,pairId,token:hostToken}), {mode:0o600});
  await writeFile(join(dir, '.stackchan-relay-device.json'), JSON.stringify({record:{version:1,pair_id:pairId,
    revision:stagedRevision,origin:endpoint,room_id:roomId,token:deviceToken,ca:'fixture',ssid:'fixture',password:'PRIVATE-FIXTURE'}}), {mode:0o600});
  const local = await relay({action:'relay_check'});
  assert.deepEqual(local,{revision:1,paired:true,pairingPending:false,host:'ready',staged:'ready',stagedRevision,device:null});
  assert.deepEqual(await relay({action:'relay_check',endpoint:'ws://private.fixture.invalid',token:'SYNTHETIC-PRIVATE'}),local);
  for (const secret of [pairId,deviceToken,hostToken,endpoint,'PRIVATE-FIXTURE']) assert.ok(!JSON.stringify(local).includes(secret));
  const request = {action:'relay_inspect',revision:1,port:'/dev/cu.unverified-fixture',authorizeUsb:false};
  await assert.rejects(relay(request),error=>error.details?.reason==='device_access_disabled');
  await assert.rejects(relay({...request,authorizeUsb:true}),error=>error.details?.reason==='managed_usb_port_unavailable');
});
