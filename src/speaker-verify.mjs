import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync, statSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const require = createRequire(import.meta.url);

/** The one reviewed speaker-embedding model (3D-Speaker CAM++, zh-cn, 16 kHz),
 * published with sherpa-onnx. It runs on the Mac; the device never sees it. */
export const SPEAKER_MODEL = Object.freeze({
  id: 'campplus-zh-cn-16k-common',
  file: '3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx',
  bytes: 28281139,
  sha256: 'e6af4d4c444f3dab01d991bb9b7d5af98eb979e329f6c8880a19d5553561ed25',
  source: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx',
});
export const OWNER_VOICE = Object.freeze({
  samples: 5,            // Utterances taken during enrolment.
  minSeconds: 0.6,       // Shorter than this is not a usable sample or check.
  maxSeconds: 6,         // Enough to tell a voice; bounds the compute per utterance.
  threshold: 0.6,        // Cosine similarity to the enrolled voice that counts as the owner.
  consistency: 0.5,      // Every enrolment sample must be at least this close to the rest.
});
const sampleRate = 16000;

/** DSH ships the sherpa-onnx runtime this model needs; nothing else is installed. */
export function locateSpeechAddon() {
  const inside = 'app.asar.unpacked/dsh/node_modules/sherpa-onnx-darwin-arm64/sherpa-onnx.node';
  return join(process.resourcesPath ?? '/Applications/DeepSeek Harness.app/Contents/Resources', inside);
}
export function cosine(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}
function unit(values) {
  let norm = 0;
  for (const value of values) norm += value * value;
  norm = Math.sqrt(norm);
  if (!(norm > 0) || !Number.isFinite(norm)) return null;
  const result = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) result[i] = values[i] / norm;
  return result;
}

/** Turns one utterance (16 kHz mono int16) into a unit voice embedding. Loads the
 * model on first use and refuses a file that is not the reviewed one. */
export function createSpeakerEmbedder({ modelPath, addonPath = locateSpeechAddon(), load = path => require(path) }) {
  let addon, extractor, failure;
  function open() {
    if (extractor || failure) return;
    try {
      const bytes = readFileSync(modelPath);
      if (bytes.length !== SPEAKER_MODEL.bytes || createHash('sha256').update(bytes).digest('hex') !== SPEAKER_MODEL.sha256)
        throw Object.assign(new Error('unreviewed speaker model'), { code: 'speaker_model_rejected' });
      addon = load(addonPath);
      extractor = addon.createSpeakerEmbeddingExtractor({ model: modelPath, numThreads: 1, debug: false, provider: 'cpu' });
    } catch (error) {
      // A fixed vocabulary: file-system details stay out of status and logs.
      failure = error?.code === 'speaker_model_rejected' ? error.code : error?.code === 'ENOENT' ? 'speaker_model_missing' : 'speaker_runtime_unavailable';
    }
  }
  return {
    /** Cheap: whether a file of the right size is installed. Does not load anything. */
    present() { try { return statSync(modelPath).size === SPEAKER_MODEL.bytes; } catch { return false; } },
    /** null when the model is usable, otherwise why not. Loads it on first use,
     * which takes a moment: call it before audio is flowing, not during. */
    unavailable() { open(); return failure ?? null; },
    embed(pcm) {
      open();
      if (!extractor || !Buffer.isBuffer(pcm)) return null;
      const count = Math.min(pcm.length >> 1, OWNER_VOICE.maxSeconds * sampleRate);
      if (count < OWNER_VOICE.minSeconds * sampleRate) return null;
      const samples = new Float32Array(count);
      for (let i = 0; i < count; i++) samples[i] = pcm.readInt16LE(i * 2) / 32768;
      const stream = addon.speakerEmbeddingExtractorCreateStream(extractor);
      addon.acceptWaveformOnline(stream, { samples, sampleRate });
      addon.inputFinished(stream);
      if (!addon.speakerEmbeddingExtractorIsReady(extractor, stream)) return null;
      return unit(Float32Array.from(addon.speakerEmbeddingExtractorComputeEmbedding(extractor, stream, false)));
    },
  };
}

/** The owner's enrolled voice: taking samples, keeping one private profile, and
 * answering "was that the owner?". A missing profile, a missing model or an
 * utterance too short to judge all answer `undefined`, never `true`. */
export function createOwnerVoice({ directory = null, embedder: makeEmbedder = createSpeakerEmbedder, now = () => new Date() } = {}) {
  const file = directory ? join(directory, 'owner-voice.json') : null;
  let embedder = null, profile = null, enrolment = null, lastResult = '';
  const usable = value => value?.version === 1 && value.model === SPEAKER_MODEL.id && Array.isArray(value.embedding) &&
    value.embedding.length > 0 && value.embedding.every(Number.isFinite);
  return {
    /** Point at the installed model. Safe to call again when the installation changes. */
    configure(modelPath) { embedder = modelPath ? makeEmbedder({ modelPath }) : null; },
    /** Load the model now, so the first judged utterance does not pause the audio path. */
    warm() { return embedder ? embedder.unavailable() : 'speaker_model_missing'; },
    async load() {
      if (!file) return;
      try {
        const stored = JSON.parse(await readFile(file, 'utf8'));
        profile = usable(stored) ? { ...stored, embedding: unit(stored.embedding) } : null;
        if (profile && !profile.embedding) profile = null;
      } catch { profile = null; }
    },
    status() {
      return { available: !!embedder && embedder.present(), enrolled: !!profile,
        enrolling: !!enrolment, collected: enrolment?.samples.length ?? 0, needed: OWNER_VOICE.samples, lastResult };
    },
    begin() {
      if (!embedder || embedder.unavailable() !== null) throw Object.assign(new Error('speaker model unavailable'), { code: 'owner_voice_unavailable' });
      enrolment = { samples: [] }; lastResult = '';
    },
    cancel() { enrolment = null; lastResult = 'cancelled'; },
    async forget() {
      profile = null; enrolment = null; lastResult = 'forgotten';
      if (file) await rm(file, { force: true });
    },
    /** One utterance. While enrolling it is taken as a sample and nothing else
     * should be done with it; otherwise, when `verify` is asked, it is judged. */
    check(pcm, { verify = false } = {}) {
      if (enrolment) {
        const sample = embedder?.embed(pcm);
        if (sample) enrolment.samples.push(sample);
        if (enrolment.samples.length >= OWNER_VOICE.samples) void this.finish();
        return { enrolling: true };
      }
      if (!verify) return undefined;
      const heard = profile && embedder ? embedder.embed(pcm) : null;
      return { owner: heard ? cosine(profile.embedding, heard) >= OWNER_VOICE.threshold : undefined };
    },
    async finish() {
      const taken = enrolment?.samples ?? [];
      enrolment = null;
      if (taken.length < OWNER_VOICE.samples) { lastResult = 'incomplete'; return false; }
      const sum = new Float32Array(taken[0].length);
      for (const sample of taken) for (let i = 0; i < sum.length; i++) sum[i] += sample[i];
      const mean = unit(sum);
      // Someone else talking during enrolment would make a profile that fits nobody.
      if (!mean || taken.some(sample => cosine(mean, sample) < OWNER_VOICE.consistency)) { lastResult = 'inconsistent'; return false; }
      profile = { version: 1, model: SPEAKER_MODEL.id, samples: taken.length, createdAt: now().toISOString(), embedding: mean };
      lastResult = 'enrolled';
      if (file) {
        try {
          await mkdir(directory, { recursive: true, mode: 0o700 });
          const temporary = `${file}.${process.pid}.tmp`;
          await writeFile(temporary, JSON.stringify({ ...profile, embedding: Array.from(mean) }), { mode: 0o600 });
          await rename(temporary, file);
        } catch { lastResult = 'enrolled-unsaved'; }
      }
      return true;
    },
  };
}
