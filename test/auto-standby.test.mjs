import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutoStandby } from '../src/auto-standby.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(preferences = {}) {
  const calls = [];
  const state = { phase: 'stopped', connected: false, usbStandby: false, lanStandby: false, relayStandby: false, pendingChanges: false };
  let failStart = 0;
  const runtime = {
    snapshot: () => ({ ...state }),
    async execute(action) {
      calls.push(action);
      if (action === 'start') {
        if (failStart-- > 0) throw Object.assign(new Error('busy'), { code: 'voice_busy' });
        state.phase = 'listening';
      } else if (action === 'arm-usb') state.usbStandby = true;
      else if (action === 'stop') state.usbStandby = false;
      else if (action === 'shutdown') { state.phase = 'stopped'; state.usbStandby = false; }
      return { ...state };
    },
  };
  const waits = [];
  let release;
  const delay = (ms, _value, { signal }) => new Promise((resolve, reject) => {
    waits.push(ms);
    release = resolve;
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  const current = { sessionId: 'existing', transport: 'usb', autoStandby: true, ...preferences };
  const supervisor = createAutoStandby({ runtime, getPreferences: () => current, delay });
  return { supervisor, runtime, calls, state, waits, current, next: async () => { release(); await tick(); await tick(); },
    failStart(count) { failStart = count; } };
}

test('the opt-in starts the saved service once and re-arms standby after it ends', async t => {
  const f = fixture(); t.after(() => f.supervisor.dispose());
  f.supervisor.start(); await tick(); await tick();
  assert.deepEqual(f.calls, ['start', 'arm-usb']);
  await f.next();
  assert.deepEqual(f.calls, ['start', 'arm-usb']); // steady
  f.state.usbStandby = false; // Standby ended on an error that needed no user.
  await f.next();
  assert.deepEqual(f.calls, ['start', 'arm-usb', 'arm-usb']);
  f.state.usbStandby = false; f.state.connected = true; // In a conversation.
  await f.next();
  assert.equal(f.calls.length, 3);
});

test('nothing starts without the opt-in or a selected session, and failures back off', async t => {
  for (const preferences of [{ autoStandby: false }, { sessionId: '' }]) {
    const f = fixture(preferences); t.after(() => f.supervisor.dispose());
    f.supervisor.start(); await tick(); await tick();
    assert.deepEqual(f.calls, []);
  }
  const f = fixture(); t.after(() => f.supervisor.dispose());
  f.failStart(2);
  f.supervisor.start(); await tick(); await tick();
  await f.next(); await f.next();
  assert.deepEqual(f.calls, ['start', 'start', 'start', 'arm-usb']);
  assert.deepEqual(f.waits.slice(0, 3), [3000, 6000, 5000]);
});

test('an owner Stop or shutdown holds the supervisor until the owner starts again', async t => {
  const f = fixture(); t.after(() => f.supervisor.dispose());
  const owner = f.supervisor.wrap(f.runtime);
  f.supervisor.start(); await tick(); await tick();
  await owner.execute('stop');
  await f.next(); await f.next();
  assert.deepEqual(f.calls, ['start', 'arm-usb', 'stop']);
  await owner.execute('arm-usb');
  f.state.usbStandby = false;
  await f.next();
  assert.deepEqual(f.calls, ['start', 'arm-usb', 'stop', 'arm-usb', 'arm-usb']);
  await owner.execute('shutdown');
  await f.next(); await f.next();
  assert.equal(f.calls.at(-1), 'shutdown');
  assert.equal(owner.snapshot().phase, 'stopped');
});
