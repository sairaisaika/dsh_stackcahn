import test from 'node:test';
import assert from 'node:assert/strict';
import { tonesToPcm, wavToPcm, pcmToWav, levels } from '../src/sound.mjs';

test('tones become 24 kHz mono PCM with soft edges, and invalid tones are refused', () => {
  const pcm = tonesToPcm([{ frequencyHz: 440, durationMs: 100, volume: 0.5 }, { frequencyHz: 0, durationMs: 50 }]);
  assert.equal(pcm.length, 150 * 24 * 2);
  assert.equal(pcm.readInt16LE(0), 0);                          // Fades in from silence.
  let peak = 0; for (let i = 0; i < 2400; i++) peak = Math.max(peak, Math.abs(pcm.readInt16LE(i * 2)));
  assert.ok(peak > 15000 && peak <= 16384);
  for (let i = 2400; i < 3600; i++) assert.equal(pcm.readInt16LE(i * 2), 0);
  for (const bad of [[], [{ frequencyHz: 5, durationMs: 100 }], [{ frequencyHz: 440, durationMs: 5 }],
    [{ frequencyHz: 440, durationMs: 100, volume: 2 }], [{ frequencyHz: 440, durationMs: 10001 }]])
    assert.throws(() => tonesToPcm(bad), { code: 'sound-invalid' });
});

test('a stereo 48 kHz WAV is mixed to mono and resampled to 24 kHz; recordings round-trip as WAV', () => {
  const frames = 4800, stereo = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i++) { stereo.writeInt16LE(1000, i * 4); stereo.writeInt16LE(3000, i * 4 + 2); }
  const pcm = wavToPcm(pcmToWav(stereo, { rate: 48000, channels: 2 }), 0.5);
  assert.equal(pcm.length, 2400 * 2);
  assert.equal(pcm.readInt16LE(200), 1000);                      // (1000+3000)/2 × 0.5
  assert.throws(() => wavToPcm(Buffer.from('not a wav at all, definitely not a wav file....')), { code: 'sound-invalid' });
  const recorded = Buffer.alloc(8); recorded.writeInt16LE(16384, 0); recorded.writeInt16LE(-32768, 2);
  assert.deepEqual(levels(recorded), { peak: [0.5, 1], rms: [0.354, 0.707] });
});
