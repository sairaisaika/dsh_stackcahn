import test from 'node:test';
import assert from 'node:assert/strict';
import { envelope, parseSteps, readStepFile, tapZone } from '../scripts/body_probe.mjs';

test('the body probe takes exact steps and rejects anything out of range', () => {
  assert.deepEqual(parseSteps(['status', 'move', '300', '450', '500', 'pause', '1000', 'label', 'upright', 'sample', 'imu', '5', '10', 'ring', '#203040', '1000']), [
    { kind: 'status' },
    { kind: 'move', yaw: 300, pitch: 450, durationMs: 500 },
    { kind: 'pause', ms: 1000 },
    { kind: 'label', text: 'upright' },
    { kind: 'sample', sensor: 'imu', seconds: 5, hz: 10 },
    { kind: 'ring', color: '#203040', durationMs: 1000 },
  ]);
  assert.deepEqual(parseSteps(['frames', '5000', 'limp', '300,450,500;-300,450,500', 'torque', 'release', '0', 'read', 'torque', 'hold', '1000']), [
    { kind: 'frames', frames: [{ yaw: 300, pitch: 450, durationMs: 500 }, { yaw: -300, pitch: 450, durationMs: 500 }], holdMs: 5000, torque: 'limp' },
    { kind: 'torque', torque: 'release', holdMs: 0 },
    { kind: 'read' },
    { kind: 'torque', torque: 'hold', holdMs: 1000 },
  ]);
  assert.deepEqual(parseSteps(['record', 'imu,power', '20', '1000', 'leds', '0,11', '#ff0000', '500', 'volume', '60', 'tone', '1000', '300', '50', 'mic', '2000', 'path', '2', 'ir', '4', '8', 'nfc', 'ndef', 'nfc', '130', '5']), [
    { kind: 'record', sensors: ['imu', 'power'], intervalMs: 20, durationMs: 1000 },
    { kind: 'leds', leds: [0, 11], color: '#ff0000', durationMs: 500 },
    { kind: 'volume', volume: 60 },
    { kind: 'tone', hz: 1000, durationMs: 300, volume: 0.5 },
    { kind: 'mic', durationMs: 2000 },
    { kind: 'path', seconds: 2 },
    { kind: 'ir', address: 4, command: 8 },
    { kind: 'nfc' },
    { kind: 'nfc', page: 130, count: 5 },
  ]);
  assert.deepEqual(parseSteps(['text', '你好_Sion', 'top', '3000', 'image', '/tmp/a.png', '5000', 'clear']), [
    { kind: 'text', text: '你好 Sion', area: 'top', durationMs: 3000 },
    { kind: 'image', path: '/tmp/a.png', durationMs: 5000 },
    { kind: 'clear' },
  ]);
  assert.deepEqual(parseSteps(['storecrops', '/tmp/c', '0'])[0], { kind: 'storecrops', path: '/tmp/c', first: 0 });
  assert.deepEqual(parseSteps(['storedir', '/tmp/f', '0', 'store', '3', '/tmp/a.bmp', 'show', '3', '1000', 'bank', 'cycle', '0', '12', '50', '2',
    'timeline', '/tmp/t.json', 'drop', '3', 'drop', 'all']), [
    { kind: 'storedir', path: '/tmp/f', first: 0 },
    { kind: 'store', slot: 3, path: '/tmp/a.bmp' },
    { kind: 'show', slot: 3, durationMs: 1000 },
    { kind: 'bank' },
    { kind: 'cycle', from: 0, to: 12, intervalMs: 50, rounds: 2 },
    { kind: 'timeline', path: '/tmp/t.json' },
    { kind: 'drop', slot: 3 },
    { kind: 'drop', slot: 'all' },
  ]);
  for (const bad of [['store', '48', '/tmp/a.bmp'], ['store', '0', 'a.bmp'], ['show', '0', '50'], ['cycle', '0', '5', '10', '1'], ['timeline', 'x.json']])
    assert.throws(() => parseSteps(bad));
  for (const bad of [['frames', '0', 'hold', '0,651,500'], ['frames', '0', 'stiff', '0,450,500'], ['torque', 'release', '10'],
    ['torque', 'limp', '0'], ['rotate', '0', '1000'], ['rotate', '500', '20001'], ['frames', '0', 'hold', Array(9).fill('0,450,500').join(';')], ['move', '0', '651', '500']])
    assert.throws(() => parseSteps(bad));
  for (const bad of [[], ['move', '1281', '450', '500'], ['move', '0', '49', '500'], ['move', '0', '450', '99'],
    ['sample', 'camera', '1', '1'], ['sample', 'imu', '0', '1'], ['ring', 'red', '1000'], ['dance']])
    assert.throws(() => parseSteps(bad));
});

test('guided-session steps: prompts, photo, duplex, listen and background recording', () => {
  assert.deepEqual(parseSteps(['ask', '灯在哪_点那边', '20', 'photo', 'duplex', '1000', '500', '60', '800', 'listen', '你好_Sion', '4000',
    'bgrecord', 'power,imu', '100', '8000', 'bgwait']), [
    { kind: 'ask', text: '灯在哪 点那边', seconds: 20 },
    { kind: 'photo' },
    { kind: 'duplex', hz: 1000, durationMs: 500, volume: 0.6, afterMs: 800 },
    { kind: 'listen', text: '你好 Sion', durationMs: 4000 },
    { kind: 'bgrecord', sensors: ['power', 'imu'], intervalMs: 100, durationMs: 8000 },
    { kind: 'bgwait' },
  ]);
  for (const bad of [['ask', '', '5'], ['ask', 'x', '61'], ['duplex', '1000', '5001', '50', '0'], ['duplex', '1000', '500', '101', '0'],
    ['listen', 'x', '400'], ['bgrecord', 'power', '10', '1000']])
    assert.throws(() => parseSteps(bad));
});

test('a session file is steps per line with comments', () => {
  assert.deepEqual(readStepFile('# header\nstatus\n#\nask 点一下 10   # answer\n  leds 0 #ffffff 500\n'), ['status', 'ask', '点一下', '10', 'leds', '0', '#ffffff', '500']);
});

test('a session file can name paths under the repository root', () => {
  assert.deepEqual(readStepFile('storecrops ${ROOT}/work/c 0', { root: '/r' }), ['storecrops', '/r/work/c', '0']);
});

test('a tap gives its third of the screen and its angle from the centre', () => {
  assert.deepEqual(tapZone(10, 120), { zone: 'left', angleDeg: 180 });
  assert.deepEqual(tapZone(160, 230), { zone: 'middle', angleDeg: 90 });
  assert.deepEqual(tapZone(310, 120), { zone: 'right', angleDeg: 0 });
  assert.equal(tapZone(160, 0).angleDeg, 270);
});

test('the envelope is RMS per 20 ms window and per channel', () => {
  const frames = 960, pcm = Buffer.alloc(frames * 4);
  for (let f = 0; f < frames; f++) { pcm.writeInt16LE(f < 480 ? 16384 : 0, f * 4); pcm.writeInt16LE(-8192, f * 4 + 2); }
  assert.deepEqual(envelope(pcm), [[0.5, 0], [0.25, 0.25]]);
});
