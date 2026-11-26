import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import * as plugin from '../src/plugin.mjs';
import { SettingsController } from '../src/settings-controller.mjs';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const defaults = () => structuredClone(plugin.Config({}).preferences.get());
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture({ list, projections, mutate, writable = true } = {}) {
  let value = { status: 'ready', value: { preferences: defaults() }, revision: 1, writable };
  const listeners = new Set(); const calls = [];
  const form = {
    getSnapshot: () => value,
    subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    async mutate(ops, revision) {
      calls.push({ ops: structuredClone(ops), revision });
      if (mutate) return mutate(ops, revision);
      if (revision !== value.revision) return false;
      update({ value: { preferences: structuredClone(ops[0].value) }, revision: revision + 1 }); return true;
    },
  };
  const update = patch => { value = { ...value, ...patch }; for (const fn of listeners) fn(); };
  const session = { list: list ?? (async () => ({ ok: true, value: { items: [] } })),
    projections: projections ?? (async () => ({ ok: true, value: { kind: 'sequenced' } })) };
  return { controller: new SettingsController(form, session), calls, update, listeners, form };
}

test('native Host plugin loads, stays passive, checks selected identity and unregisters', async () => {
  const ctx = new Context(); let reads = 0;
  ctx.provide('sessionController', { projections: async ({ sessionId }) => {
    assert.equal(sessionId, 'test-session'); ++reads; return { kind: 'sequenced' };
  } });
  const fiber = await ctx.plugin(plugin, { preferences: { sessionId: 'test-session' } });
  const service = ctx.get('stackchanSettings');
  assert.deepEqual(await ctx.get('stackchanPairing').call({ action: 'snapshot' }),
    { ok: false, error: 'host_unconfigured' });
  assert.equal(reads, 0); assert.equal(service.snapshot().applied, false);
  assert.equal((await service.checkSession()).status, 'valid'); assert.equal(reads, 1);
  const detached = service.snapshot(); detached.preferences.sessionId = 'changed';
  assert.equal(service.snapshot().preferences.sessionId, 'test-session');
  await fiber.dispose(); assert.equal(ctx.get('stackchanSettings'), undefined);
  assert.throws(() => service.snapshot()); await ctx.fiber.dispose();
});

test('plugin disposal cancels an outstanding Session check, never a desktop task', async () => {
  const ctx = new Context(); const started = deferred(); const reply = deferred(); let signal;
  ctx.provide('sessionController', { projections: async (_arg, received) => {
    signal = received; started.resolve(); return reply.promise;
  } });
  const fiber = await ctx.plugin(plugin, { preferences: { sessionId: 'test-session' } });
  const pending = ctx.get('stackchanSettings').checkSession(); await started.promise;
  await fiber.dispose(); assert.equal(signal.aborted, true);
  reply.resolve({ kind: 'sequenced' }); await assert.rejects(pending); await ctx.fiber.dispose();
});

test('native schema rejects out-of-range and unrecognized backend preferences', () => {
  for (const preferences of [{ speechRate: 0 }, { speechRate: Infinity }, { language: 'unknown' },
    { ttsBackend: 'paid-cloud' }, { sessionId: 'x'.repeat(257) }, { voice: 'x'.repeat(129) }, { measureLatency: 'yes' }, { captionOnly: 'yes' }])
    assert.throws(() => plugin.Config({ preferences }));
});

test('settings save verifies only the selected session and uses original revision', async () => {
  const checked = []; const f = fixture({ projections: async (request, signal) => {
    checked.push(request); assert.equal(signal.aborted, false); return { ok: true, value: { kind: 'sequenced' } };
  } });
  assert.equal(defaults().measureLatency,false);
  assert.equal(defaults().captionOnly,false);
  assert.equal(defaults().autoStandby,false);
  f.controller.edit('sessionId', 'existing-session'); f.controller.edit('language', 'zh');f.controller.edit('measureLatency',true);
  f.controller.edit('captionOnly',true);
  assert.equal(await f.controller.save(), true);
  assert.deepEqual(checked, [{ sessionId: 'existing-session' }]);
  assert.equal(f.calls[0].revision, 1); assert.equal(f.calls[0].ops[0].path[0], 'preferences');
  assert.equal(f.calls[0].ops[0].value.measureLatency,true);
  assert.equal(f.calls[0].ops[0].value.captionOnly,true);
  assert.equal(f.controller.getSnapshot().revision, 2); assert.equal(f.controller.getSnapshot().dirty, false);
  assert.match(f.controller.getSnapshot().notice, /保存不会启动录音/ ); f.controller.dispose();
});

test('USB selection is saved through native preferences and requires a scoped port', async () => {
  assert.equal(defaults().transport, 'lan');
  assert.throws(() => plugin.Config({ preferences: { usbPort: '/dev/tty.not-usb' } }));
  const f=fixture();
  f.controller.edit('transport','usb');
  assert.equal(await f.controller.save(),false);
  assert.equal(f.calls.length,0);
  f.controller.edit('usbPort','/dev/cu.usbmodemsion');
  assert.equal(await f.controller.save(),true);
  assert.equal(f.calls[0].ops[0].value.transport,'usb');
  assert.equal(f.calls[0].ops[0].value.usbPort,'/dev/cu.usbmodemsion');
  f.controller.dispose();
});

test('remote revision change preserves draft and requires explicit discard', async () => {
  const f = fixture(); f.controller.edit('voice', 'chosen');
  f.update({ revision: 2, value: { preferences: { ...defaults(), voice: 'another-window' } } });
  assert.equal(f.controller.getSnapshot().draft.voice, 'chosen');
  assert.equal(await f.controller.save(), false); assert.equal(f.calls.length, 0);
  f.controller.discard(); assert.equal(f.controller.getSnapshot().draft.voice, 'another-window');
  assert.equal(f.controller.getSnapshot().conflict, false); f.controller.dispose();
});

test('concurrent update during Session validation reaches native stale-write fence', async () => {
  const reply = deferred(); const f = fixture({ projections: () => reply.promise });
  f.controller.edit('sessionId', 'selected'); const saving = f.controller.save();
  f.update({ revision: 2 }); reply.resolve({ ok: true, value: { kind: 'sequenced' } });
  assert.equal(await saving, false); assert.equal(f.calls[0].revision, 1);
  assert.equal(f.controller.getSnapshot().draft.sessionId, 'selected'); f.controller.dispose();
});

test('missing or legacy sessions never save and network failure keeps draft', async () => {
  for (const result of [{ ok: false }, { ok: true, value: null }, { ok: true, value: { kind: 'cached' } }]) {
    const f = fixture({ projections: async () => result }); f.controller.edit('sessionId', 'missing');
    assert.equal(await f.controller.save(), false); assert.equal(f.calls.length, 0);
    assert.equal(f.controller.getSnapshot().dirty, true); f.controller.dispose();
  }
  const f = fixture({ mutate: async () => { throw new Error('secret path / token'); } });
  f.controller.edit('voice', 'chosen'); assert.equal(await f.controller.save(), false);
  assert.equal(f.controller.getSnapshot().draft.voice, 'chosen');
  assert.doesNotMatch(f.controller.getSnapshot().error, /secret/); f.controller.dispose();
});

test('disposal during validation prevents save even if remote ignores cancellation', async () => {
  const reply = deferred(); const f = fixture({ projections: () => reply.promise });
  f.controller.edit('sessionId', 'selected'); const saving = f.controller.save();
  f.controller.dispose(); reply.resolve({ ok: true, value: { kind: 'sequenced' } });
  assert.equal(await saving, false); assert.equal(f.calls.length, 0); assert.equal(f.listeners.size, 0);
});

test('readonly and unavailable forms cannot save; edits cannot race pending save', async () => {
  const read = fixture({ writable: false }); read.controller.edit('voice', 'bad');
  assert.equal(await read.controller.save(), false); assert.equal(read.calls.length, 0); read.controller.dispose();
  const reply = deferred(); const f = fixture({ mutate: () => reply.promise });
  f.controller.edit('voice', 'first'); const save = f.controller.save();
  f.controller.edit('voice', 'second'); assert.equal(await f.controller.save(), false);
  assert.equal(f.controller.getSnapshot().draft.voice, 'first');
  reply.resolve(false); await save; f.update({ status: 'unavailable' });
  assert.equal(await f.controller.save(), false); f.controller.dispose();
});

test('session listing projects only visible normal session labels; late results are ignored', async () => {
  const f = fixture({ list: async () => ({ ok: true, value: { items: [
    { sessionId: 'normal', running: true, cwd: '/private', projections: { values: { title: 'Title', inbox: 'private' } } },
    { sessionId: 'child', parentSessionId: 'normal' },
  ] } }) });
  await f.controller.loadSessions(); assert.deepEqual(f.controller.getSnapshot().sessions,
    [{ sessionId: 'normal', title: 'Title', running: true, migrationRequired: false }]); f.controller.dispose();
  const reply = deferred(); const late = fixture({ list: () => reply.promise });
  const loading = late.controller.loadSessions(); late.controller.dispose();
  reply.resolve({ ok: true, value: { items: [{ sessionId: 'late' }] } }); await loading;
  assert.equal(late.controller.getSnapshot().sessions.length, 0);
});

test('a saved session can be checked by exact ID even when the list is unavailable', async () => {
  const selected = 'saved-session-outside-the-list';
  const requests = [];
  let outcome;
  const f = fixture({ writable: false, list: async () => ({ ok: false }),
    projections: async (request, signal) => {
      requests.push(request);
      assert.equal(signal.aborted, false);
      if (outcome instanceof Error) throw outcome;
      return outcome;
    } });
  f.update({ value: { preferences: { ...defaults(), sessionId: selected } } });
  await f.controller.loadSessions();
  assert.match(f.controller.getSnapshot().error, /无法读取会话列表/);
  for (const [response, expected] of [
    [{ ok: true, value: { kind: 'sequenced' } }, 'verified'],
    [{ ok: true, value: null }, 'missing'],
    [{ ok: true, value: { kind: 'migration-required' } }, 'migration-required'],
    [new Error('private transport data'), 'unavailable'],
  ]) {
    outcome = response;
    await f.controller.checkSession();
    assert.equal(f.controller.getSnapshot().sessionCheck, expected);
  }
  assert.deepEqual(requests, Array.from({ length: 4 }, () => ({ sessionId: selected })));
  assert.equal(f.controller.getSnapshot().draft.sessionId, selected);
  assert.equal(f.controller.getSnapshot().dirty, false);
  assert.equal(f.calls.length, 0);
  f.controller.dispose();
});

test('a late exact session check cannot label a different selection or outlive disposal', async () => {
  const reply = deferred();
  let signal;
  const f = fixture({ projections: (_request, incoming) => { signal = incoming; return reply.promise; } });
  const select = sessionId => f.update({ value: { preferences: { ...defaults(), sessionId } } });
  select('first-saved');
  const first = f.controller.checkSession();
  assert.equal(f.controller.getSnapshot().sessionChecking, true);
  select('different-saved');
  reply.resolve({ ok: true, value: { kind: 'sequenced' } });
  await first;
  assert.equal(f.controller.getSnapshot().sessionCheck, null);
  assert.equal(f.controller.getSnapshot().sessionChecking, false);
  const second = f.controller.checkSession();
  f.controller.dispose();
  assert.equal(signal.aborted, true);
  await second;
  assert.equal(f.controller.getSnapshot().sessionCheck, null);
  assert.equal(f.calls.length, 0);
});

test('built Client registers native settings slot and renders accepted preferences', async () => {
  let exported;
  const bundle = await readFile(new URL('../client/client.js', import.meta.url), 'utf8');
  vm.runInNewContext(bundle, { window: { __ModuleLoader__: { load({ id, factory }) {
    assert.equal(id, 'dsh-stackchan'); exported = factory(name => {
      assert.equal(name, 'react'); return React;
    });
  } } }, structuredClone, AbortController, setTimeout, clearTimeout });
  const disposers = []; let registration; const f = fixture();
  const client = { configForms: { get: id => { assert.equal(id, 'stackchan'); return f.form; } },
    remote: { session: {}, stackchanPairing: {}, async $mount(info) { assert.equal(info.package, 'dsh-stackchan'); } },
    inject(names, fn) {
      assert.deepEqual([...names], ['remote.session', 'remote.stackchanPairing', 'remote.stackchanVoice']);
      return fn(this);
    },
    effect(fn) { const result = fn(); if (typeof result === 'function') disposers.push(result); },
    slots: { inject(name, fn) { assert.equal(name, 'settings.section'); return fn(); },
      register(meta, view) { registration = { meta, view }; return () => {}; } } };
  await exported.apply(client);
  assert.equal(registration.meta.id, 'stackchan');
  const html = renderToStaticMarkup(React.createElement(registration.view));
  assert.match(html, /role="tablist" aria-label="设置分类"/);
  assert.match(html, /role="tab" aria-selected="true"[^>]*>连接与会话<\/button>/);
  assert.equal([...html.matchAll(/role="tabpanel"[^>]*\bhidden=""/g)].length, 3);
  assert.match(html, /保存偏好/); assert.match(html, /原厂语音/); assert.match(html, /启动语音服务/);
  assert.match(html, /刷新本地配对状态/); assert.match(html, /撤销本插件配对/);
  assert.match(html, /<button type="button" disabled="">核对当前会话/);
  assert.doesNotMatch(html, /session-457/);
  f.update({ value: { preferences: { ...defaults(), sessionId: 'saved-fixture12345678' } } });
  const saved = renderToStaticMarkup(React.createElement(registration.view));
  assert.match(saved, /<button type="button">核对当前会话/);
  assert.match(saved, /当前所选会话 · 12345678/);
  f.update({value:{preferences:{...defaults(),transport:'usb',usbPort:'/dev/cu.usbmodemsion'}}});
  const wired = renderToStaticMarkup(React.createElement(registration.view));
  assert.match(wired, /查找 USB 端口/);
  assert.match(wired, /已保存 · \/dev\/cu\.usbmodemsion/);
  f.update({value:{preferences:{...defaults(),transport:'relay'}}});
  const relay = renderToStaticMarkup(React.createElement(registration.view));
  assert.match(relay,/外出中继配置/);assert.match(relay,/检查本机中继配置/);
  assert.doesNotMatch(relay,/查找 USB 端口/);
  for (const dispose of disposers.reverse()) dispose(); f.controller.dispose();
});

test('real DSH profile saves preferences, rejects stale/invalid writes and reloads after restart', async () => {
  // Isolated profile following the official settings configuration-fixture pattern.
  // No user profile, network service, session persistence or model is mounted.
  const { mkdtemp, mkdir, writeFile, realpath, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { boot, initProfile, readProfilePatches } = await import('@deepseek-ai/dsh-app-boot');
  const { default: Settings } = await import('@deepseek-ai/dsh-settings');
  const { default: ConfigEditor } = await import('@deepseek-ai/dsh-config-editor');
  const home = await realpath(await mkdtemp(join(tmpdir(), 'sion-plugin-test-')));
  let ctx;
  try {
    const dir = join(home, 'profiles', 'test'); initProfile(dir, ['test-bundle']);
    const bundle = join(dir, 'node_modules', 'test-bundle'); await mkdir(bundle, { recursive: true });
    await writeFile(join(home, 'package.json'), '{"name":"sion-test"}');
    await writeFile(join(bundle, 'package.json'), JSON.stringify({ name: 'test-bundle', version: '1.0.0',
      dsh: { bundle: { patch: 'cordis.patch.yml' } } }));
    await writeFile(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [
      { id: 'config-editor', name: 'cordis:editor' }, { id: 'settings', name: 'cordis:settings' },
      { id: 'stackchan', name: 'cordis:sion' },
    ] }]));
    await writeFile(join(dir, 'cordis.yml'), '[]\n');
    const profile = { name: 'test', startedBundles: ['test-bundle'], dir,
      patchPath: join(dir, 'cordis.patch.yml'), installAnchor: join(home, 'package.json'), cwd: home, home,
      overlays: [], telemetryDisabledEnv: undefined };
    async function start() {
      return boot('test', join(dir, 'cordis.yml'), readProfilePatches('test', profile), root => {
        root.provide('profileContext', profile);
        root.provide('appReady', { onReady: listener => { listener(); return () => {}; } });
        Object.assign(root.loader.builtins, { editor: ConfigEditor, settings: Settings, sion: plugin });
      });
    }
    ctx = await start();
    const row = ctx.settings.describe().find(row => row.ns === 'stackchan');
    assert.ok(row); assert.equal(row.autoGenerate, false);
    const next = { ...defaults(), sessionId: 'fixture-existing-session', language: 'zh', speechRate: 0.75,
      transport: 'usb', usbPort: '/dev/cu.usbmodemfixture' };
    await ctx.settings.mutate('stackchan', [{ op: 'set', path: ['preferences'], value: next }], row.revision);
    assert.deepEqual(ctx.get('stackchanSettings').snapshot().preferences, next);
    assert.equal(ctx.get('stackchanSettings').snapshot().applied, false);
    const persisted = await readFile(profile.patchPath, 'utf8');
    assert.match(persisted, /fixture-existing-session/);
    await assert.rejects(ctx.settings.mutate('stackchan', [{ op: 'set', path: ['preferences'], value: defaults() }], row.revision));
    const fresh = ctx.settings.describe().find(row => row.ns === 'stackchan');
    await assert.rejects(ctx.settings.mutate('stackchan', [{ op: 'set', path: ['pairing', 'deviceAccess'], value: true }], fresh.revision));
    await assert.rejects(ctx.settings.mutate('stackchan', [{ op: 'set', path: ['pairing'], value: { directory: home, python: 'python3', deviceAccess: true } }], fresh.revision));
    await assert.rejects(ctx.settings.mutate('stackchan', [{ op: 'set', path: ['voice', 'python'], value: '/private/untrusted-python' }], fresh.revision));
    assert.deepEqual(await ctx.get('stackchanPairing').call({ action: 'snapshot' }), { ok: false, error: 'host_unconfigured' });
    await assert.rejects(ctx.settings.mutate('stackchan', [{ op: 'set', path: ['preferences'], value: { ...next, speechRate: 99 } }], fresh.revision));
    assert.equal(await readFile(profile.patchPath, 'utf8'), persisted);
    await ctx.fiber.dispose(); ctx = await start();
    assert.deepEqual(ctx.get('stackchanSettings').snapshot().preferences, next);
    const loaded = ctx.settings.describe().find(row => row.ns === 'stackchan');
    const relayed={...next,transport:'relay'};
    await ctx.settings.mutate('stackchan',[{op:'set',path:['preferences'],value:relayed}],loaded.revision);
    await ctx.fiber.dispose();ctx=await start();
    assert.deepEqual(ctx.get('stackchanSettings').snapshot().preferences,relayed);
  } finally {
    if (ctx) await ctx.fiber.dispose(); await rm(home, { recursive: true, force: true });
  }
});
