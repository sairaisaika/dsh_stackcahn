import test from 'node:test';
import assert from 'node:assert/strict';
import { nextIdleTarget, createIdleMotion } from '../src/idle-motion.mjs';
import { MOTION } from '../src/agent-protocol.mjs';

test('idle looks stay inside the factory standby range and the device limits', () => {
  let seed = 1;
  const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  let previous = { yaw: 0, pitch: 300 };
  const kinds = new Set();
  for (let i = 0; i < 4000; i++) {
    const target = nextIdleTarget(previous, random);
    assert.ok(Number.isInteger(target.yaw) && Number.isInteger(target.pitch) && Number.isInteger(target.durationMs));
    assert.ok(target.yaw >= -800 && target.yaw <= 800 && target.pitch >= 50 && target.pitch <= 600);
    assert.ok(target.yaw >= MOTION.yawMin && target.pitch >= MOTION.pitchMin && target.pitch <= MOTION.pitchMax);
    assert.ok(target.durationMs >= 700 && target.durationMs <= 2200 && target.durationMs <= MOTION.durationMax);
    if (target.yaw === 0) kinds.add('centre');
    if (Math.abs(target.yaw - previous.yaw) <= 150 && Math.abs(target.pitch - previous.pitch) <= 80) kinds.add('drift');
    if (Math.abs(target.yaw - previous.yaw) > 400) kinds.add('look');
    previous = target;
  }
  assert.deepEqual([...kinds].sort(), ['centre', 'drift', 'look']);
});

test('the head moves only while waiting, a few seconds apart, and backs off when the device refuses', async () => {
  const waits = []; const moves = []; const states = [];
  let waiting = false, refusal = null, steps = 0, release;
  const done = new Promise(resolve => { release = resolve; });
  const motion = createIdleMotion({
    waiting: () => waiting,
    async move(target) { moves.push(target); if (refusal) throw Object.assign(new Error(refusal), { code: refusal }); },
    async delay(ms, _value, { signal }) {
      waits.push(Math.round(ms));
      signal.throwIfAborted();
      steps++;
      if (steps === 2) waiting = true;                // In a conversation until now: no movement.
      if (steps === 4) refusal = 'motion-busy';       // Something else is moving the head.
      if (steps === 5) refusal = 'motion-disabled';   // Motion is switched off on the device.
      if (steps === 6) refusal = null;
      if (steps === 7) { release(); await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); }
    },
    random: () => 0.5, onState: sample => states.push(sample),
  });
  motion.start(); motion.start();
  await done;
  await motion.dispose();
  assert.equal(waits[0], 2000);
  assert.ok(waits.slice(1, 5).every(ms => ms >= 4000 && ms <= 8000));
  assert.equal(waits[5], 120000); // After the refusal, wait before asking the device again.
  assert.equal(moves.length, 5);  // Steps 2 to 6; none before waiting began.
  assert.deepEqual(states, [{ event: 'idle-motion-paused', code: 'motion-disabled' }]);
});

test('a drive fault backs off 30 s, 60 s, 120 s … and a success resets it (v67: retries every 31 s filled the device record)', async () => {
  const waits = []; let steps = 0, release;
  const done = new Promise(resolve => { release = resolve; });
  const motion = createIdleMotion({
    waiting: () => true,
    async move() { if (steps < 5 || steps > 5) throw Object.assign(new Error('motion-open'), { code: 'motion-open' }); },
    async delay(ms, _value, { signal }) {
      waits.push(Math.round(ms));
      signal.throwIfAborted();
      steps++;
      if (steps === 8) { release(); await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); }
    },
    random: () => 0.5,
  });
  motion.start();
  await done;
  await motion.dispose();
  // Moves fail after delays 1–4, succeed after delay 5, fail again after 6 and 7.
  assert.deepEqual(waits.slice(1, 5), [30000, 60000, 120000, 240000]);
  assert.ok(waits[5] >= 4000 && waits[5] <= 8000);
  assert.deepEqual(waits.slice(6, 8), [30000, 60000]);
});
