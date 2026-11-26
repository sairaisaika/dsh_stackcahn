import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import Registry from '@deepseek-ai/dsh-typert-registry';
import Gateway from '@deepseek-ai/dsh-api-gateway';
import { PairingRemote } from '../lib/remote-api.js';
import { TYPERT } from '../lib/typert.host.js';
import remoteInfo from '../lib/typert.remote-client.js';
import * as ClientGateway from '@deepseek-ai/dsh-api-gateway/client';
import { createPairingHost } from '../src/pairing-host.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const snapshot = { revision: 0, deviceId: '', activePairId: '', candidatePairId: '', pending: '', observed: null, connected: false };
async function fixture(t, call = async () => ({ ok: true, value: snapshot }), diagnose, prepareRuntime, identify) {
  const ctx = new Context();
  await ctx.plugin(Registry);
  ctx.provide('remoteAccess', { decide: () => ({ kind: 'allow' }) });
  await ctx.plugin(Gateway);
  ctx.typert.register(TYPERT);
  ctx.provide('stackchanPairing', { call, diagnose, prepareRuntime, identify });
  new PairingRemote(ctx);
  t.after(() => ctx.fiber.dispose());
  const owner = { id: 'test-owner', ctx, principal: { kind: 'owner' }, signal: new AbortController().signal, interactions: 'none' };
  const invoke = (request, options = {}) => ctx.typertGateway.invoke({ namespace: 'stackchanPairing', method: 'execute',
    args: { request }, peer: owner, ...options });
  return { ctx, owner, invoke };
}

test('official generated codecs describe only bounded maintenance actions, not Host options', () => {
  const method = remoteInfo.methods['stackchanPairing/execute'];
  assert.equal(method.parameters[0].codec.mode, 'strict');
  assert.deepEqual(method.input({ strict: true }).create().parse({ request: { action: 'snapshot' } }), { request: { action: 'snapshot' } });
  assert.throws(() => method.input({ strict: true }).create().parse({ request: { action: 'snapshot', deviceAccess: true } }));
  assert.throws(() => method.input().create().parse({ request: { action: 'erase' } }));
});

test('diagnostics use generated Gateway owner policy and cancellation, with no request options', async t => {
  const report = { platform: 'macos', pythonReady: true, storage: 'unconfigured', deviceAccess: false,
    serial: 'missing', openssl: 'available', ports: [], truncated: false };
  let calls = 0;
  const f = await fixture(t, undefined, async signal => {
    assert.ok(signal instanceof AbortSignal); calls++; return { ok: true, value: report };
  });
  const options = { method: 'diagnose', args: {} };
  assert.deepEqual(await f.invoke(undefined, options), report);
  await assert.rejects(f.invoke(undefined, { ...options, peer: { ...f.owner, principal: { kind: 'viewer' } } }),
    e => e.code === 'stackchan/owner-required');
  await assert.rejects(f.invoke(undefined, { ...options, args: { deviceAccess: true } }),
    e => e.code === 'gateway/arguments-invalid');
  const cancel = new AbortController(); cancel.abort();
  await assert.rejects(f.invoke(undefined, { ...options, signal: cancel.signal }), e => e.code === 'gateway/cancelled');
  assert.equal(calls, 1);
});

test('USB identification is owner-only and accepts just the chosen port', async t => {
  const port = '/dev/cu.fixture';
  let calls = 0;
  const f = await fixture(t, undefined, undefined, undefined, async (selected, signal) => {
    assert.equal(selected, port);
    assert.ok(signal instanceof AbortSignal);
    calls++;
    return { ok: true, value: { deviceId: '123456abcdef' } };
  });
  const options = { method: 'identify', args: { port } };
  await assert.rejects(f.invoke(undefined, { ...options, peer: { ...f.owner, principal: { kind: 'viewer' } } }),
    { code: 'stackchan/owner-required' });
  await assert.rejects(f.invoke(undefined, { ...options, args: { port, deviceAccess: true } }),
    { code: 'gateway/arguments-invalid' });
  assert.deepEqual(await f.invoke(undefined, options), { deviceId: '123456abcdef' });
  assert.equal(calls, 1);
});

test('real Gateway dispatches generated descriptor and strips undeclared nested options', async t => {
  const received = [];
  const f = await fixture(t, async (request, signal) => { received.push(request); assert.ok(signal instanceof AbortSignal); return { ok: true, value: snapshot }; });
  assert.deepEqual(await f.invoke({ action: 'snapshot', directory: '/private', deviceAccess: true }), snapshot);
  assert.deepEqual(received, [{ action: 'snapshot' }]);
  await assert.rejects(f.invoke({ action: 'unsupported' }), e => e.code === 'gateway/input-invalid');
  assert.equal(received.length, 1);
});

test('business owner gate refuses non-owner even when access policy allows it', async t => {
  let calls = 0;
  const f = await fixture(t, async () => { ++calls; return { ok: true, value: snapshot }; });
  await assert.rejects(f.invoke({ action: 'snapshot' }, { peer: { ...f.owner, principal: { kind: 'test-viewer' } } }),
    e => e.code === 'stackchan/owner-required');
  assert.equal(calls, 0);
});

test('Host fixed outcomes cross the Gateway as declared Remote errors', async t => {
  const f = await fixture(t, async () => ({ ok: false, error: 'reconcile_required' }));
  await assert.rejects(f.invoke({ action: 'snapshot' }), e => e.code === 'stackchan/pairing-failed'
    && e.details.reason === 'reconcile_required');
});

test('Gateway cancellation propagates to Host and rejects late success', async t => {
  let start; const started = new Promise(r => { start = r; });
  const f = await fixture(t, async (_req, signal) => {
    start(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    return { ok: true, value: snapshot };
  });
  const abort = new AbortController();
  const pending = f.invoke({ action: 'snapshot' }, { signal: abort.signal });
  await started; abort.abort();
  await assert.rejects(pending, e => e.code === 'gateway/cancelled');
});

test('real Client namespace mounts generated contribution and reaches Host Gateway through a loopback carrier', async t => {
  const report = { platform: 'macos', pythonReady: true, storage: 'unconfigured', deviceAccess: false,
    serial: 'missing', openssl: 'available', ports: [], truncated: false };
  const f = await fixture(t, undefined, async () => ({ ok: true, value: report }), async () => ({ ok: true, value: report }));
  const client = new Context();
  await client.plugin(Registry);
  client.provide('connection', { interactions: 'none', isLoopback: true,
    rpc: { open: async function* () {}, async call(path, endpoint, payload, signal) {
      assert.equal(path, '/api'); assert.ok(['stackchanPairing/execute', 'stackchanPairing/diagnose', 'stackchanPairing/prepareRuntime'].includes(endpoint));
      try { return { ok: true, value: await f.invoke(payload.args.request, { signal, method: endpoint.split('/')[1], args: payload.args }) }; }
      catch (error) { return { ok: false, error: { code: error.code, message: error.message, details: error.details } }; }
    } },
  });
  await client.plugin(ClientGateway);
  t.after(() => client.fiber.dispose());
  const unmount = await client.remote.$mount(remoteInfo);
  const retained = client.remote.stackchanPairing.execute.bind(client.remote.stackchanPairing);
  assert.deepEqual(await client.remote.stackchanPairing.diagnose(), { ok: true, value: report });
  assert.deepEqual(await client.remote.stackchanPairing.prepareRuntime(), { ok: true, value: report });
  assert.deepEqual(await retained({ action: 'snapshot' }), { ok: true, value: snapshot });
  await unmount();
  const stale = await retained({ action: 'snapshot' });
  assert.equal(stale.ok, false);
});

test('Gateway reaches actual private Host helper, creates a temporary identity and preserves hardware denial', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sion-remote-host-'));
  const host = createPairingHost({ directory: join(root, 'private'), python: process.env.STACKCHAN_TEST_PYTHON || 'python3' });
  t.after(async () => { await host.dispose(); await rm(root, { recursive: true, force: true }); });
  const f = await fixture(t, host.call, host.diagnose);
  assert.equal((await f.invoke(undefined, { method: 'diagnose', args: {} })).storage, 'absent');
  const initial = await f.invoke({ action: 'snapshot' });
  assert.equal(initial.revision, 0);
  const prepared = await f.invoke({ action: 'prepare', revision: 0, deviceId: '123456abcdef', localUrl: 'wss://192.168.1.2:9080/audio' });
  assert.match(prepared.candidatePairId, /^[0-9a-f]{32}$/);
  await assert.rejects(f.invoke({ action: 'install', revision: prepared.revision, deviceId: prepared.deviceId, port: '/dev/cu.fixture' }),
    e => e.code === 'stackchan/pairing-failed' && e.details.reason === 'device_access_disabled');
  assert.equal((await f.invoke({ action: 'snapshot' })).pending, '');
});
