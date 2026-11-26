import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PairingController } from '../src/settings-pairing-controller.mjs';
import { PairingPanel } from '../src/settings-pairing-view.mjs';

const fresh = () => ({ revision: 1, deviceId: '', activePairId: '', candidatePairId: '', pending: '', observed: null, connected: false });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { resolve, promise }; };
test('pairing page remains passive and requires local state, device identity and physical confirmation', async () => {
  const calls = [];
  const controller = new PairingController({ execute: async request => { calls.push(request); return { ok: true, value: fresh() }; } });
  const html = renderToStaticMarkup(React.createElement(PairingPanel, { controller }));
  assert.match(html, /查找和选择不会打开串口/); assert.match(html, /原厂手机 App/);
  assert.equal(calls.length, 0);
  await controller.run('install'); assert.equal(calls.length, 0);
  await controller.run('snapshot');
  controller.edit('deviceId', '123456abcdef'); controller.edit('port', '/dev/cu.fixture');
  await controller.run('install'); assert.equal(calls.length, 1);
  controller.edit('confirmed', true);
  await controller.run('install');
  assert.deepEqual(calls[1], { action: 'install', revision: 1, deviceId: '123456abcdef', port: '/dev/cu.fixture', authorizeUsb: true });
  assert.equal(controller.getSnapshot().confirmed, false);
  controller.dispose();
});

test('explicit diagnostics project missing setup, allow only candidate selection and never infer device identity', async () => {
  let calls = 0;
  const report = { platform: 'macos', pythonReady: true, storage: 'unconfigured', deviceAccess: false,
    serial: 'available', openssl: 'missing', truncated: true, managedUsb: true,
    ports: [{ path: '/dev/cu.fixture', description: '<USB>', vid: 123, pid: 456 }] };
  const c = new PairingController({ diagnose: async () => { calls++; return { ok: true, value: report }; } });
  renderToStaticMarkup(React.createElement(PairingPanel, { controller: c }));
  assert.equal(calls, 0);
  c.edit('confirmed', true);
  await c.diagnose();
  assert.equal(calls, 1); assert.equal(c.getSnapshot().confirmed, false);
  assert.equal(c.getSnapshot().port, '');
  c.choosePort('/dev/cu.unlisted'); assert.equal(c.getSnapshot().port, '');
  c.choosePort('/dev/cu.fixture'); assert.equal(c.getSnapshot().port, '/dev/cu.fixture');
  assert.equal(c.getSnapshot().deviceId, ''); assert.equal(c.getSnapshot().snapshot, null);
  const html = renderToStaticMarkup(React.createElement(PairingPanel, { controller: c }));
  assert.match(html, /尚未配置/); assert.match(html, /缺少 OpenSSL/); assert.match(html, /允许显式操作当前连接的 Espressif/); assert.match(html, /前 16 个/);
  assert.match(html, /&lt;USB&gt;/); assert.match(html, /不能证明它是 StackChan/);
  c.dispose();
});

test('runtime preparation is explicit, serialized and never fills identity or confirms device access', async () => {
  let calls = 0;
  const response = deferred();
  const report = { platform: 'macos', pythonReady: true, storage: 'absent', deviceAccess: false,
    serial: 'available', openssl: 'available', ports: [], truncated: false };
  const c = new PairingController({ prepareRuntime: async () => { calls++; return response.promise; } });
  const initial = renderToStaticMarkup(React.createElement(PairingPanel, { controller: c }));
  assert.match(initial, /准备插件专用环境/); assert.match(initial, /pySerial 3.5/); assert.equal(calls, 0);
  c.edit('confirmed', true);
  const pending = c.diagnose(true);
  await c.diagnose(true); await c.run('snapshot'); assert.equal(calls, 1);
  response.resolve({ ok: true, value: report }); await pending;
  assert.equal(c.getSnapshot().confirmed, false); assert.equal(c.getSnapshot().deviceId, '');
  assert.equal(c.getSnapshot().snapshot, null); assert.match(c.getSnapshot().notice, /设备访问配置未改变/);
  c.dispose();
});

test('explicit USB identification fills just the device draft and never substitutes an already stored device', async () => {
  const calls = [];
  const port = '/dev/cu.fixture';
  const c = new PairingController({
    async identify(selected) { calls.push(selected); return { ok: true, value: { deviceId: '123456abcdef' } }; },
    async execute(request) { calls.push(request.action); return { ok: true, value: { ...fresh(), deviceId: 'abcdef123456' } }; },
  });
  await c.run('identify');
  c.edit('port', port);
  c.edit('confirmed', true);
  assert.match(renderToStaticMarkup(React.createElement(PairingPanel, { controller: c })), /读取设备编号/);
  await c.run('identify');
  assert.deepEqual(calls, [port]);
  assert.equal(c.getSnapshot().deviceId, '123456abcdef');
  assert.equal(c.getSnapshot().snapshot, null);
  assert.equal(c.getSnapshot().confirmed, false);
  c.edit('port', '/dev/cu.other');
  assert.equal(c.getSnapshot().deviceId, '');
  await c.run('snapshot');
  await c.run('identify');
  assert.deepEqual(calls, [port, 'snapshot']);
  assert.equal(c.getSnapshot().deviceId, 'abcdef123456');
  c.dispose();
});

test('diagnostic refresh clears stale inventory, never changes pairing state, and handles failure/disposal', async () => {
  const response = deferred(); let signal;
  const c = new PairingController({ execute: async () => ({ ok: true, value: fresh() }),
    diagnose: abort => { signal = abort; return response.promise; } });
  await c.run('snapshot'); const previous = c.getSnapshot().snapshot;
  const pending = c.diagnose();
  await c.run('snapshot');
  response.resolve({ ok: false, error: { code: 'stackchan/pairing-failed', message: 'SECRET', details: { reason: 'environment_unavailable' } } });
  await pending;
  assert.equal(c.getSnapshot().environment, null); assert.equal(c.getSnapshot().snapshot, previous);
  assert.doesNotMatch(c.getSnapshot().error, /SECRET/); assert.match(c.getSnapshot().error, /Python/);
  const next = c.diagnose(); c.dispose(); assert.equal(signal.aborted, true); await next;
});

test('unknown write outcome invalidates revision and requires explicit refresh, with no replay', async () => {
  const calls = [];
  const controller = new PairingController({ execute: async request => {
    calls.push(request);
    return request.action === 'snapshot' ? { ok: true, value: fresh() }
      : { ok: false, error: { code: 'gateway/cancelled', message: 'SECRET', details: {} } };
  } });
  await controller.run('snapshot'); controller.edit('deviceId', '123456abcdef'); controller.edit('confirmed', true);
  await controller.run('install');
  assert.equal(controller.getSnapshot().snapshot, null);
  assert.doesNotMatch(controller.getSnapshot().error, /SECRET/);
  await controller.run('install'); assert.equal(calls.length, 2);
  controller.dispose();
});

test('pending transaction permits inspection but refuses preparation and another write', async () => {
  const calls = [];
  const controller = new PairingController({ execute: async request => {
    calls.push(request); return { ok: true, value: { ...fresh(), deviceId: '123456abcdef', pending: 'install' } };
  } });
  await controller.run('snapshot');
  await controller.run('prepare'); await controller.run('install'); assert.equal(calls.length, 1);
  await controller.run('inspect'); assert.equal(calls.length, 2);
  controller.dispose();
});

test('LAN omission is explicit and preserves a drafted address when re-enabled', async () => {
  const calls = [];
  const c = new PairingController({ async execute(request) { calls.push(request); return { ok: true, value: fresh() }; } });
  await c.run('snapshot');
  c.edit('deviceId', '123456abcdef');
  await c.run('prepare');
  assert.equal(calls.length, 1);
  c.edit('localUrl', 'wss://192.168.1.4:9080/audio');
  c.edit('withoutLan', true);
  await c.run('prepare');
  assert.equal(calls.at(-1).localUrl, '');
  c.edit('withoutLan', false);
  await c.run('prepare');
  assert.equal(calls.at(-1).localUrl, 'wss://192.168.1.4:9080/audio');
  c.dispose();
});

test('busy/disposed page cancels only its request and ignores late completion', async () => {
  const response = deferred(); let signal; let calls = 0;
  const controller = new PairingController({ execute: (_request, abort) => { ++calls; signal = abort; return response.promise; } });
  const pending = controller.run('snapshot');
  await controller.run('snapshot'); controller.edit('port', 'changed');
  assert.equal(calls, 1); assert.equal(controller.getSnapshot().port, '');
  const before = controller.getSnapshot(); controller.dispose(); assert.equal(signal.aborted, true);
  response.resolve({ ok: true, value: fresh() }); await pending;
  assert.equal(controller.getSnapshot(), before);
});

test('non-owner and unconfigured errors become fixed user copy without provider messages', async () => {
  for (const error of [{ code: 'stackchan/owner-required', details: {} },
    { code: 'stackchan/pairing-failed', details: { reason: 'host_unconfigured' } }]) {
    const c = new PairingController({ execute: async () => ({ ok: false, error: { ...error, message: 'SECRET' } }) });
    await c.run('snapshot'); assert.doesNotMatch(c.getSnapshot().error, /SECRET/); assert.ok(c.getSnapshot().error);
    c.dispose();
  }
});


test('LAN candidates require a current explicit choice and only update the editable draft', async () => {
  const endpoint = { interfaceName: 'en0', url: 'wss://192.168.1.4:9080/audio' };
  let endpoints = [endpoint], checks = 0;
  const report = { platform: 'macos', pythonReady: true, storage: 'absent', deviceAccess: false,
    serial: 'available', openssl: 'available', ports: [], truncated: false };
  const c = new PairingController({ async diagnose() {
    checks++;
    return { ok: true, value: { ...report, localNetwork: { status: 'available', endpoints, truncated: false } } };
  } });
  c.chooseLocalUrl(endpoint.url);
  assert.equal(c.getSnapshot().localUrl, '');
  await c.diagnose();
  assert.equal(c.getSnapshot().localUrl, '');
  const html = renderToStaticMarkup(React.createElement(PairingPanel, { controller: c }));
  assert.match(html, /候选语音服务地址/);
  assert.match(html, /en0 — wss:\/\/192\.168\.1\.4:9080\/audio/);
  c.chooseLocalUrl('wss://192.168.1.5:9080/audio');
  assert.equal(c.getSnapshot().localUrl, '');
  c.edit('confirmed', true);
  c.chooseLocalUrl(endpoint.url);
  assert.equal(c.getSnapshot().localUrl, endpoint.url);
  assert.equal(c.getSnapshot().confirmed, false);
  assert.equal(c.getSnapshot().deviceId, '');
  assert.equal(c.getSnapshot().snapshot, null);
  endpoints = [];
  await c.diagnose();
  const custom = 'wss://192.168.1.4:9060/audio';
  c.edit('localUrl', custom);
  c.chooseLocalUrl(endpoint.url);
  assert.equal(c.getSnapshot().localUrl, custom);
  assert.equal(checks, 2);
  c.dispose();
});
