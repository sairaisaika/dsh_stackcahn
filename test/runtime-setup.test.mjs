import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir, writeFile, mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Context } from '@deepseek-ai/cordis';
import Registry from '@deepseek-ai/dsh-typert-registry';
import Gateway from '@deepseek-ai/dsh-api-gateway';
import { TYPERT } from '../lib/typert.host.js';
import * as plugin from '../src/plugin.mjs';
import { createRuntimeSetup } from '../src/runtime-setup.mjs';
import { createManagedPairing } from '../src/managed-pairing.mjs';

const exec = promisify(execFile);
const python = process.env.STACKCHAN_TEST_PYTHON || 'python3';
async function fixture(t) {
  const profile = await mkdtemp(join(tmpdir(), 'sion-runtime-'));
  t.after(() => rm(profile, { recursive: true, force: true }));
  return profile;
}

test('offline runtime installer covers hash, publication, retained failures and live file locks', async () => {
  const { stderr } = await exec(python, ['scripts/test_prepare_runtime.py'], { timeout: 10000 });
  assert.match(stderr, /Ran 6 tests/); assert.match(stderr, /OK/);
});

test('real Cordis profile prepares offline isolated pySerial, reuses it after restart and retains device denial', async t => {
  const profile = await fixture(t);
  let ctx;
  async function start() {
    ctx = new Context(); ctx.provide('profileContext', { dir: profile });
    await ctx.plugin(Registry);
    ctx.provide('remoteAccess', { decide: () => ({ kind: 'allow' }) });
    await ctx.plugin(Gateway); ctx.typert.register(TYPERT);
    await ctx.plugin(plugin, { pairing: { python } });
    return ctx.get('stackchanPairing');
  }
  t.after(async () => { await ctx?.fiber.dispose(); });
  let host = await start();
  assert.deepEqual(await readdir(profile), []);
  const invoke = (principal, args = {}) => ctx.typertGateway.invoke({ namespace: 'stackchanPairing', method: 'prepareRuntime', args,
    peer: { id: 'test-owner', ctx, principal, signal: new AbortController().signal, interactions: 'none' } });
  await assert.rejects(invoke({ kind: 'viewer' }), e => e.code === 'stackchan/owner-required');
  await assert.rejects(invoke({ kind: 'owner' }, { root: '/injected' }), e => e.code === 'gateway/arguments-invalid');
  assert.deepEqual(await readdir(profile), []);
  const result = await invoke({ kind: 'owner' });
  assert.equal(result.pythonReady, true);
  assert.equal(result.serial, process.platform === 'darwin' ? 'available' : 'not_checked');
  assert.equal(result.storage, 'absent'); assert.equal(result.deviceAccess, false);
  const active = await readFile(join(profile, '.stackchan/active.json'), 'utf8');
  const generation = JSON.parse(active).generation;
  const executable = join(profile, '.stackchan', generation, 'bin/python3');
  const { stdout } = await exec(executable, ['-I', '-c', 'import sys,serial;print(serial.VERSION);print(sys.prefix != sys.base_prefix)']);
  assert.equal(stdout.trim(), '3.5\nTrue');
  assert.equal((await host.prepareRuntime()).ok, true);
  assert.equal(await readFile(join(profile, '.stackchan/active.json'), 'utf8'), active);
  await ctx.fiber.dispose(); host = await start();
  assert.equal((await host.diagnose()).value.pythonReady, true);
  const snapshot = await host.call({ action: 'snapshot' }); assert.equal(snapshot.ok, true);
  const denied = await host.call({ action: 'inspect', revision: snapshot.value.revision, deviceId: '123456abcdef', port: '/dev/cu.fixture' });
  assert.deepEqual(denied, { ok: false, error: 'device_access_disabled' });
});

test('setup cannot guess a profile or override a custom pairing installation', async t => {
  const profile = await fixture(t);
  const noProfile = createManagedPairing({ python });
  assert.deepEqual(await noProfile.prepareRuntime(), { ok: false, error: 'runtime_profile_required' });
  await noProfile.dispose();
  const custom = createManagedPairing({ profileDirectory: profile, directory: join(profile, 'custom'), python });
  assert.deepEqual(await custom.prepareRuntime(), { ok: false, error: 'runtime_custom_installation' });
  assert.deepEqual(await readdir(profile), []);
  await custom.dispose();
});

test('active runtime reader refuses injected paths, symlinks and missing published generations', async t => {
  const profile = await fixture(t), root = join(profile, 'runtime');
  const setup = createRuntimeSetup({ root, candidates: [] });
  assert.deepEqual(await setup.active(), { ok: true, value: null });
  await mkdir(root, { mode: 0o700 });
  for (const manifest of [{ version: 1, generation: '../../outside' }, { version: 1, generation: 'a'.repeat(32) }]) {
    await writeFile(join(root, 'active.json'), JSON.stringify(manifest), { mode: 0o600 });
    assert.deepEqual(await setup.active(), { ok: false, error: 'runtime_storage_invalid' });
  }
  await rm(join(root, 'active.json'));
  await symlink(join(profile, 'outside'), join(root, 'active.json'));
  assert.deepEqual(await setup.active(), { ok: false, error: 'runtime_storage_invalid' });
  await setup.dispose();
});

test('setup cancellation terminates helper before returning and prevents duplicate queued installs', async t => {
  const profile = await fixture(t);
  const fake = join(profile, 'python');
  const marker = join(profile, 'live');
  await writeFile(fake, `#!${process.execPath}\nif(!process.argv.includes('-c')){require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000);}\n`, { mode: 0o700 });
  const setup = createRuntimeSetup({ root: join(profile, 'runtime'), candidates: [fake] });
  const cancel = new AbortController();
  const pending = setup.prepare(cancel.signal);
  assert.deepEqual(await setup.prepare(), { ok: false, error: 'host_busy' });
  let pid;
  for (let i = 0; i < 100; i++) {
    try { pid = Number(await readFile(marker, 'utf8')); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; await new Promise(resolve => setTimeout(resolve, 20)); }
  }
  assert.ok(pid > 0, 'helper reached running installation stage');
  cancel.abort();
  assert.deepEqual(await pending, { ok: false, error: 'runtime_setup_failed' });
  assert.throws(() => process.kill(pid, 0), e => e.code === 'ESRCH');
  await setup.dispose();
  assert.deepEqual(await setup.prepare(), { ok: false, error: 'host_disposed' });
  assert.deepEqual((await readdir(profile)).sort(), ['live', 'python']);
});
