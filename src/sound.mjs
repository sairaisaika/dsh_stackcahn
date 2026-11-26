// Sounds for the body's speaker and raw recordings from its microphones.
// Device audio is 16-bit little-endian PCM at 24 kHz: one channel out, two in.
import { AUDIO } from './agent-protocol.mjs';

const fault = code => Object.assign(new Error(code), { code });
export const SOUND = Object.freeze({ maxMs: 10000, maxTones: 32, minHz: 20, maxHz: 12000, maxWavBytes: 4 * 1024 * 1024,
  maxRecordMs: 30000 });

/** tones: [{frequencyHz (0 = silence), durationMs, volume 0..1}] → mono PCM. Each tone fades in and
 * out over 5 ms so joins do not click. */
export function tonesToPcm(tones) {
  if (!Array.isArray(tones) || tones.length < 1 || tones.length > SOUND.maxTones) throw fault('sound-invalid');
  let total = 0;
  for (const t of tones) {
    const hz = t?.frequencyHz, ms = t?.durationMs, volume = t?.volume ?? 0.5;
    if (!Number.isFinite(hz) || (hz !== 0 && (hz < SOUND.minHz || hz > SOUND.maxHz)) || !Number.isInteger(ms) ||
        ms < 10 || !Number.isFinite(volume) || volume < 0 || volume > 1) throw fault('sound-invalid');
    total += ms;
  }
  if (total > SOUND.maxMs) throw fault('sound-invalid');
  const rate = AUDIO.rate, fade = Math.round(rate * 0.005);
  const samples = Math.round(total * rate / 1000);
  const out = Buffer.alloc(samples * 2);
  let at = 0, phase = 0;
  for (const t of tones) {
    const n = Math.round(t.durationMs * rate / 1000), volume = t.volume ?? 0.5;
    for (let i = 0; i < n && at < samples; i++, at++) {
      const edge = Math.min(1, i / fade, (n - 1 - i) / fade);
      const value = t.frequencyHz ? Math.sin(phase) * volume * edge * 32767 : 0;
      phase += 2 * Math.PI * t.frequencyHz / rate;
      out.writeInt16LE(Math.round(value), at * 2);
    }
  }
  return out;
}

/** v71 on Sion: after a sound the speaker kept repeating its last buffer for
 * about 2.4 s until the drain fence. Ending every sound with this much silence
 * makes that repeat silent. */
export const SILENT_TAIL_MS = 250;
export function withSilentTail(pcm) { return Buffer.concat([pcm, Buffer.alloc(Math.round(SILENT_TAIL_MS * AUDIO.rate / 1000) * 2)]); }

/** A 16-bit PCM WAV of any rate and channel count → mono 24 kHz PCM (linear resampling), scaled by volume. */
export function wavToPcm(bytes, volume = 1) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 44 || bytes.length > SOUND.maxWavBytes ||
      bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE' ||
      !Number.isFinite(volume) || volume < 0 || volume > 1) throw fault('sound-invalid');
  let offset = 12, format, data;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('ascii', offset, offset + 4), size = bytes.readUInt32LE(offset + 4);
    const body = bytes.subarray(offset + 8, Math.min(bytes.length, offset + 8 + size));
    if (id === 'fmt ') format = { tag: body.readUInt16LE(0), channels: body.readUInt16LE(2), rate: body.readUInt32LE(4), bits: body.readUInt16LE(14) };
    if (id === 'data') data = body;
    offset += 8 + size + (size % 2);
  }
  if (!format || !data || format.tag !== 1 || format.bits !== 16 || format.channels < 1 || format.channels > 8 ||
      format.rate < 8000 || format.rate > 192000) throw fault('sound-invalid');
  const frames = Math.floor(data.length / (2 * format.channels));
  if (frames / format.rate * 1000 > SOUND.maxMs) throw fault('sound-invalid');
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < format.channels; c++) sum += data.readInt16LE((i * format.channels + c) * 2);
    mono[i] = sum / format.channels;
  }
  const outFrames = Math.floor(frames * AUDIO.rate / format.rate);
  const out = Buffer.alloc(Math.max(2, outFrames * 2));
  for (let i = 0; i < outFrames; i++) {
    const x = i * format.rate / AUDIO.rate, j = Math.floor(x), f = x - j;
    const value = (mono[j] * (1 - f) + (mono[Math.min(j + 1, frames - 1)] ?? 0) * f) * volume;
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(value))), i * 2);
  }
  return out;
}

/** Interleaved PCM → WAV bytes. */
export function pcmToWav(pcm, { rate = AUDIO.rate, channels = AUDIO.inputChannels } = {}) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii'); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22); header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii'); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Peak and RMS per channel of interleaved 16-bit PCM, as fractions of full scale. */
export function levels(pcm, channels = AUDIO.inputChannels) {
  const peak = new Array(channels).fill(0), sum = new Array(channels).fill(0);
  const frames = Math.floor(pcm.length / (2 * channels));
  for (let i = 0; i < frames; i++) for (let c = 0; c < channels; c++) {
    const v = pcm.readInt16LE((i * channels + c) * 2) / 32768;
    peak[c] = Math.max(peak[c], Math.abs(v)); sum[c] += v * v;
  }
  return { peak: peak.map(v => Math.round(v * 1000) / 1000),
    rms: sum.map(v => frames ? Math.round(Math.sqrt(v / frames) * 1000) / 1000 : 0) };
}
