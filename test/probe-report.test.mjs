import test from 'node:test';
import assert from 'node:assert/strict';
import { analyseChannel, buildReport, cer } from '../scripts/probe_report.mjs';

// 15 quiet windows, the tone from window 18 for 30 windows, then a repeated 2-window chunk 5 windows later.
const env = (level, floor, repeat) => Array.from({ length: 80 }, (_, i) =>
  i >= 18 && i < 48 ? level : repeat && i >= 53 && i < 55 ? level : floor);

test('a channel analysis finds onset, latency, plateau and a repeated tail', () => {
  const a = analyseChannel(env(0.2, 0.0001, true), 15, 30);
  assert.equal(a.heard, true);
  assert.equal(a.latencyMs, 60);
  assert.equal(a.activeMs, 600);
  assert.equal(a.plateau, 0.2);
  assert.deepEqual(a.extraBursts, [{ afterEndMs: 120, lengthMs: 40 }]);
  assert.equal(analyseChannel(env(0, 0.001, false), 15, 30).heard, false);
});

test('character error rate ignores punctuation', () => {
  assert.equal(cer('Sion，你好', 'sion你好'), 0);
  assert.equal(cer('七二九四零', '七二九四'), 0.2);
});

test('the report reads a session log: reference channel, LED taps, failures', () => {
  const lines = [
    { event: 'probe-started', at: '2026-11-27T00:00:00Z' },
    { event: 'authenticated', capabilities: { camera: 1 } },
    { event: 'label', text: 'section:audio-volume' },
    { event: 'volume', target: { volume: 30 } },
    { event: 'duplex', target: { hz: 1000, durationMs: 600, volume: 0.5, afterMs: 800 }, toneStartWindow: 15, toneWindows: 30,
      rms: [0.1, 0.05], peak: [0.3, 0.2], envelope: [env(0.2, 0.0001, true), env(0.05, 0.004, false)] },
    { event: 'label', text: 'section:leds' },
    { event: 'leds', target: { leds: [3], color: '#ffffff' } },
    { event: 'ask', text: '朝亮着的那颗灯', answered: true, afterMs: 900, x: 10, y: 120, zone: 'left', angleDeg: 180 },
    { event: 'label', text: 'section:camera' },
    { event: 'photo-failed', code: 'camera-permission', camera: { permission: 'denied' } },
  ].map(e => JSON.stringify(e));
  const report = buildReport(lines);
  assert.match(report, /通道 0 是回声参考/);
  assert.match(report, /参考 \+120 ms 长 40 ms/);
  assert.match(report, /\| 3 \| \(10, 120\) \| 180 \| left \|/);
  assert.match(report, /photo-failed.*camera-permission/);
});
