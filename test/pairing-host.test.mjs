import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, chmod, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createPairingHost, localNetworkCandidates } from '../src/pairing-host.mjs';
import { Context } from '@deepseek-ai/cordis';
import * as plugin from '../src/plugin.mjs';

const exec = promisify(execFile);
const python = process.env.STACKCHAN_TEST_PYTHON || 'python3';
const deviceId = '123456abcdef';
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'sion-host-pair-'));
  const directory = join(root, 'private');
  const host = createPairingHost({ directory, python, ...options });
  t.after(async () => { await host.dispose(); await rm(root, { recursive: true, force: true }); });
  return { root, directory, host };
}

test('Host helper journal: restart, unknown commits, conflicts and process lock recovery', async () => {
  const { stderr } = await exec(python, ['scripts/test_agent_pairing_host.py'], { timeout: 10000 });
  assert.match(stderr, /Ran [1-9]\d* tests/);
  assert.match(stderr, /OK/);
});

test('environment helper covers metadata filtering, missing dependencies and zero serial opens', async () => {
  const { stderr } = await exec(python, ['scripts/test_agent_environment.py'], { timeout: 10000 });
  assert.match(stderr, /Ran 6 tests/); assert.match(stderr, /OK/);
});

test('real environment helper works before configuration and never creates private storage', async t => {
  const f = await fixture(t);
  const report = await f.host.diagnose();
  assert.equal(report.ok, true);
  assert.equal(report.value.storage, 'absent');
  assert.equal(report.value.deviceAccess, false);
  assert.equal(report.value.pythonReady, true);
  assert.ok(report.value.ports.every(p => !('deviceId' in p) && !('serialNumber' in p)));
  await assert.rejects(access(f.directory));
  const ctx = new Context();
  await ctx.plugin(plugin, { pairing: { python } });
  t.after(() => ctx.fiber.dispose());
  const service = ctx.get('stackchanPairing');
  assert.deepEqual(await service.call({ action: 'snapshot' }), { ok: false, error: 'host_unconfigured' });
  assert.equal((await service.diagnose()).value.storage, 'unconfigured');
});

test('diagnostic process failure and unexpected output are redacted; cancellation waits for exit', async t => {
  const f = await fixture(t);
  for (const executable of [join(f.root, 'missing'), await interpreter(f.root,
    'console.log(JSON.stringify({ok:true,value:{secret:"PRIVATE-SECRET"}}));')]) {
    const host = createPairingHost({ python: executable });
    assert.deepEqual(await host.diagnose(), { ok: false, error: 'environment_unavailable' });
    await host.dispose();
  }
  const host = createPairingHost({ python: await interpreter(f.root, 'setInterval(()=>{},1000);') });
  const cancel = new AbortController();
  const pending = host.diagnose(cancel.signal);
  assert.deepEqual(await host.diagnose(), { ok: false, error: 'host_busy' });
  cancel.abort();
  assert.deepEqual(await pending, { ok: false, error: 'environment_unavailable' });
  await host.dispose();
  assert.deepEqual(await host.diagnose(), { ok: false, error: 'host_disposed' });
});

test('environment decoder preserves split UTF-8 and rejects extra fields, invalid ports and oversized lists', async t => {
  const f = await fixture(t);
  const value = { platform: 'macos', pythonReady: true, storage: 'unconfigured', deviceAccess: false,
    serial: 'available', openssl: 'available', truncated: false,
    ports: [{ path: '/dev/cu.fixture', description: '中文设备', vid: 0x303a, pid: 0x1001 }] };
  const body = `const wire=Buffer.from(${JSON.stringify(JSON.stringify({ ok: true, value }))});
    const split=wire.indexOf(Buffer.from('中'))+1;
    process.stdout.write(wire.subarray(0,split));setTimeout(()=>process.stdout.write(wire.subarray(split)),30);`;
  const host = createPairingHost({ python: await interpreter(f.root, body) });
  const decoded = await host.diagnose();
  assert.equal(decoded.ok, true);
  const { localNetwork, ...serialReport } = decoded.value;
  assert.deepEqual(serialReport, value);
  assert.ok(localNetwork.endpoints.length <= 16);
  await host.dispose();
  for (const patch of [{ secret: 'PRIVATE' }, { ports: [{ ...value.ports[0], path: '/dev/tty.invalid' }] },
    { ports: Array(17).fill(value.ports[0]) }, { ports: [{ ...value.ports[0], serialNumber: 'PRIVATE' }] },
    { ports: [{ ...value.ports[0], description: '\u202eSECRET' }] }, { serial: 'missing' }]) {
    const malformed = createPairingHost({ python: await interpreter(f.root,
      `console.log(${JSON.stringify(JSON.stringify({ ok: true, value: { ...value, ...patch } }))});`) });
    assert.deepEqual(await malformed.diagnose(), { ok: false, error: 'environment_unavailable' });
    await malformed.dispose();
  }
});

test('real Host helper generates private X.509 candidate, survives restart and refuses device access', async t => {
  const f = await fixture(t);
  let result = await f.host.call({ action: 'snapshot' });
  assert.equal(result.ok, true);
  assert.equal(result.value.revision, 0);
  result = await f.host.call({ action: 'prepare', revision: 0, deviceId, localUrl: 'wss://192.168.1.2:9080/audio' });
  assert.equal(result.ok, true);
  assert.match(result.value.candidatePairId, /^[0-9a-f]{32}$/);
  assert.equal(JSON.stringify(result).includes('PRIVATE KEY'), false);
  const candidate = result.value.candidatePairId;
  await f.host.dispose();
  const restarted = createPairingHost({ directory: f.directory, python });
  t.after(() => restarted.dispose());
  const snap = await restarted.call({ action: 'snapshot' });
  assert.equal(snap.value.candidatePairId, candidate);
  result = await restarted.call({ action: 'install', revision: snap.value.revision, deviceId, port: '/dev/cu.fake' });
  assert.deepEqual(result, { ok: false, error: 'device_access_disabled' });
  const state = JSON.parse(await readFile(join(f.directory, 'state.json'), 'utf8'));
  assert.equal(state.pending, null);
  assert.equal(state.active, null);
});

test('Host rejects stale revision, unknown request fields and corrupt private storage without leaking', async t => {
  const f = await fixture(t);
  await f.host.call({ action: 'snapshot' });
  assert.deepEqual(await f.host.call({ action: 'inspect', revision: 99, deviceId, port: '/dev/cu.fake' }),
    { ok: false, error: 'revision_conflict' });
  assert.deepEqual(await f.host.call({ action: 'snapshot', key: 'SECRET' }),
    { ok: false, error: 'invalid_request' });
  await writeFile(join(f.directory, 'state.json'), 'PRIVATE-SECRET', { mode: 0o600 });
  assert.deepEqual(await f.host.call({ action: 'snapshot' }), { ok: false, error: 'operation_unconfirmed' });
});

async function interpreter(root, body) {
  const path = join(root, 'fixture-interpreter');
  await writeFile(path, `#!${process.execPath}\n${body}\n`, { mode: 0o700 });
  await chmod(path, 0o700);
  return path;
}

test('provider output is schema checked; secrets and extra fields never reach the caller', async t => {
  const f = await fixture(t);
  for (const body of [
    'console.log(JSON.stringify({ok:false,error:"PRIVATE-SECRET"}));process.exitCode=1;',
    'console.log(JSON.stringify({ok:true,value:{key:"PRIVATE-SECRET"}}));',
    'process.stdout.write("PRIVATE-SECRET".repeat(1000));',
  ]) {
    const host = createPairingHost({ directory: f.directory, python: await interpreter(f.root, body) });
    assert.deepEqual(await host.call({ action: 'snapshot' }), { ok: false, error: 'operation_unconfirmed' });
    await host.dispose();
  }
});

test('Host disposal waits for helper exit; concurrent requests do not queue or replay', async t => {
  const f = await fixture(t);
  const host = createPairingHost({ directory: f.directory, python: await interpreter(f.root, 'setInterval(()=>{},1000);') });
  const pending = host.call({ action: 'snapshot' });
  assert.deepEqual(await host.call({ action: 'snapshot' }), { ok: false, error: 'host_busy' });
  await host.dispose();
  assert.deepEqual(await pending, { ok: false, error: 'operation_unconfirmed' });
  assert.deepEqual(await host.call({ action: 'snapshot' }), { ok: false, error: 'host_disposed' });
});

test('caller cancellation and unavailable interpreter produce fixed outcomes', async t => {
  const f = await fixture(t);
  const cancel = new AbortController(); cancel.abort();
  assert.deepEqual(await f.host.call({ action: 'snapshot' }, cancel.signal), { ok: false, error: 'operation_unconfirmed' });
  const missing = createPairingHost({ directory: f.directory, python: join(f.root, 'not-installed') });
  assert.deepEqual(await missing.call({ action: 'snapshot' }), { ok: false, error: 'operation_unconfirmed' });
  await missing.dispose();
});

test('native Cordis plugin owns and disposes the configured Host helper', async t => {
  const f = await fixture(t);
  const ctx = new Context();
  const fiber = await ctx.plugin(plugin, { pairing: { directory: f.directory, python } });
  const service = ctx.get('stackchanPairing');
  const snapshot = await service.call({ action: 'snapshot' });
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.value.connected, false);
  await fiber.dispose();
  assert.equal(ctx.get('stackchanPairing'), undefined);
  assert.deepEqual(await service.call({ action: 'snapshot' }), { ok: false, error: 'host_disposed' });
  await ctx.fiber.dispose();
});

test('one managed USB request cannot enable a subsequent request or an explicit deny', async t => {
  const f = await fixture(t, { managedUsb: true });
  const inspect = { action: 'inspect', revision: 0, deviceId, port: '/dev/cu.unverified-fixture' };
  assert.deepEqual(await f.host.call(inspect), { ok: false, error: 'device_access_disabled' });
  assert.deepEqual(await f.host.call({ ...inspect, authorizeUsb: true }),
    { ok: false, error: 'managed_usb_port_unavailable' });
  assert.deepEqual(await f.host.call(inspect), { ok: false, error: 'device_access_disabled' });
  assert.deepEqual(await f.host.call({ ...inspect, authorizeUsb: false }),
    { ok: false, error: 'device_access_disabled' });
  const fixed = await fixture(t, { allowDevice: false });
  assert.deepEqual(await fixed.host.call({ ...inspect, authorizeUsb: true }),
    { ok: false, error: 'device_access_disabled' });
});

test('default managed USB audio reaches port validation while an explicit deny blocks it', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sion-host-usb-policy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const response = { ok: true, deviceId, pairing: { version: 1,
    record: { pair_id: 'a'.repeat(32), local_token: 'b'.repeat(64) },
    host: { key: 'fixture-key', cert: 'fixture-certificate' } } };
  const python = await interpreter(root, `console.log(${JSON.stringify(JSON.stringify(response))}); process.stdin.resume();`);
  for (const [policy, error] of [[{ managedUsb: true }, 'voice_usb_port_required'],
    [{ managedUsb: true, allowDevice: false }, 'voice_usb_access_disabled'], [{}, 'voice_usb_access_disabled']]) {
    const host = createPairingHost({ directory: root, python, ...policy });
    try {
      const lease = await host.acquireIdentity();
      try { assert.throws(() => lease.openUsb(''), { code: error }); }
      finally { await lease.release(); }
    } finally { await host.dispose(); }
  }
});


test('LAN candidates reuse the private IPv4 contract and omit unrelated interface data', () => {
  const row = (address, extra = {}) => ({ address, family: 'IPv4', internal: false, mac: 'PRIVATE', ...extra });
  const observed = localNetworkCandidates({
    utun0: [row('10.10.1.2')],
    en1: [row('172.20.0.11'), row('192.168.1.4')],
    lo0: [row('10.1.1.1', { internal: true }), row('127.0.0.1')],
    en0: [row('192.168.1.4'), row('8.8.8.8'), row('169.254.1.2'), row('192.168.1.4@8.8.8.8'),
      row('192.168.1.8', { family: 'IPv6' }), row('192.168.001.9')],
    'invalid interface': [row('10.53.0.10')],
  });
  assert.deepEqual(observed, { status: 'available', truncated: false, endpoints: [
    { interfaceName: 'en0', url: 'wss://192.168.1.4:9080/audio' },
    { interfaceName: 'en1', url: 'wss://172.20.0.11:9080/audio' },
    { interfaceName: 'utun0', url: 'wss://10.10.1.2:9080/audio' },
  ] });
  const capped = localNetworkCandidates({ en0: Array.from({length: 17}, (_, index) => row('10.0.0.'+(index+1))) });
  assert.equal(capped.endpoints.length, 16);
  assert.equal(capped.truncated, true);
});
