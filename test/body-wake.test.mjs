// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBodyWake, ENTER_SCRIPT } from '../src/body-wake.mjs';

const sha = 'c'.repeat(64);
async function profile(manifest) {
  const dir = await mkdtemp(join(tmpdir(), 'wake-'));
  if (manifest) {
    await mkdir(join(dir, '.stackchan-resident'));
    await writeFile(join(dir, '.stackchan-resident/resident.json'), JSON.stringify(manifest));
  }
  return dir;
}
const good = { version: 1, python: '/py/python', identity: '/r/identity.json', image: '/r/dsh.bin', sha256: sha };
const lines = (...events) => events.map(e => JSON.stringify(e)).join('\n') + '\n';

test('wake runs only the packaged enter program with the manifest arguments, then attends over USB', async () => {
  const dir = await profile(good);
  const calls = [], actions = [];
  const runtime = { snapshot: () => ({ connected: false }), execute: async a => { actions.push(a); } };
  const wake = createBodyWake({ profileDirectory: dir, runtime, sleep: async () => {},
    run: async (python, args) => { calls.push([python, args]); return { code: 0, stdout: lines({ event: 'selected' }, { event: 'reset' }) }; } });
  const result = await wake.wake();
  assert.equal(result.status, 'woken'); assert.equal(result.attending, true);
  assert.deepEqual(actions, ['arm-usb']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '/py/python');
  assert.deepEqual(calls[0][1], [ENTER_SCRIPT, '--identity', '/r/identity.json', '--image', '/r/dsh.bin', '--sha256', sha,
    '--auto-rom', '--log', join(dir, '.stackchan-resident/enter.jsonl')]);
  await rm(dir, { recursive: true });
});

test('a connected body is already awake; nothing runs', async () => {
  const dir = await profile(good);
  let ran = false;
  const wake = createBodyWake({ profileDirectory: dir, runtime: { snapshot: () => ({ connected: true }) },
    run: async () => { ran = true; return { code: 0, stdout: '' }; } });
  assert.deepEqual(await wake.wake(), { version: 1, status: 'already-awake' });
  assert.equal(ran, false);
  await rm(dir, { recursive: true });
});

test('missing or malformed manifest: not installed, nothing runs', async () => {
  for (const manifest of [null, { ...good, python: 'python3' }, { ...good, sha256: 'xyz' }, { ...good, version: 2 }]) {
    const dir = await profile(manifest);
    let ran = false;
    const wake = createBodyWake({ profileDirectory: dir, runtime: { snapshot: () => ({}) }, run: async () => { ran = true; return { code: 0, stdout: '' }; } });
    await assert.rejects(wake.wake(), { code: 'wake-not-installed' });
    assert.equal(ran, false);
    await rm(dir, { recursive: true });
  }
});

test('refusals map to what the owner should do; failures are not retried', async () => {
  const cases = [['flash-voltage', 'wake-press-rst'], ['no-rom', 'wake-press-rst'], ['port-in-use', 'wake-port-busy'],
    ['ota0-not-resident-dsh', 'wake-body-missing'], ['factory-not-confirmed-running', 'wake-not-from-factory'], ['something-new', 'wake-refused']];
  for (const [reason, code] of cases) {
    const dir = await profile(good);
    let runs = 0;
    const wake = createBodyWake({ profileDirectory: dir, runtime: { snapshot: () => ({}) }, sleep: async () => {},
      run: async () => { runs++; return { code: reason === 'flash-voltage' ? 3 : 2, stdout: lines({ event: 'refused', reason }) }; } });
    await assert.rejects(wake.wake(), { code });
    assert.equal(runs, 1);
    await rm(dir, { recursive: true });
  }
  const dir = await profile(good);
  const wake = createBodyWake({ profileDirectory: dir, runtime: { snapshot: () => ({}) },
    run: async () => ({ code: 4, stdout: lines({ event: 'failed', reason: 'readback-mismatch' }) }) });
  await assert.rejects(wake.wake(), { code: 'wake-failed', reason: 'readback-mismatch' });
  await rm(dir, { recursive: true });
});

test('a second wake while one runs is busy; without a voice service it still wakes', async () => {
  const dir = await profile(good);
  let release;
  const wake = createBodyWake({ profileDirectory: dir, runtime: { snapshot: () => ({}), execute: async () => { throw new Error('voice_not_started'); } },
    sleep: async () => {}, run: () => new Promise(r => { release = () => r({ code: 0, stdout: lines({ event: 'reset' }) }); }) });
  const first = wake.wake();
  await new Promise(r => setTimeout(r, 20));
  await assert.rejects(wake.wake(), { code: 'wake-busy' });
  release();
  const result = await first;
  assert.equal(result.status, 'woken'); assert.equal(result.attending, false);
  await rm(dir, { recursive: true });
});
