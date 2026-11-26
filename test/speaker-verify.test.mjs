import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOwnerVoice, createSpeakerEmbedder, locateSpeechAddon, cosine, OWNER_VOICE, SPEAKER_MODEL } from '../src/speaker-verify.mjs';

// A voice is a direction; an utterance is that direction plus a little variation.
const voiceOf = (who, wobble = 0) => {
  const v = new Float32Array(8); v[who] = 1; v[7] = wobble;
  const n = Math.hypot(...v); return v.map(x => x / n);
};
const utterance = (who, wobble = 0, seconds = 1) => Object.assign(Buffer.alloc(Math.round(seconds * 32000)), { who, wobble });
const fakeEmbedder = state => () => ({
  present: () => !state.failure,
  unavailable: () => state.failure ?? null,
  embed: pcm => (pcm.length < OWNER_VOICE.minSeconds * 32000 ? null : voiceOf(pcm.who, pcm.wobble)),
});

test('enrolment takes five utterances, then only that voice is the owner', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'owner-voice-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const state = {};
  const voice = createOwnerVoice({ directory: join(directory, 'private'), embedder: fakeEmbedder(state) });
  assert.deepEqual(voice.status(), { available: false, enrolled: false, enrolling: false, collected: 0, needed: 5, lastResult: '' });
  assert.throws(() => voice.begin(), { code: 'owner_voice_unavailable' });
  voice.configure('/models/speaker.onnx');
  assert.equal(voice.check(utterance(1)), undefined); // Not asked to judge: no voice is examined.
  assert.deepEqual(voice.check(utterance(1), { verify: true }), { owner: undefined }); // Nobody enrolled: cannot say yes.
  voice.begin();
  assert.deepEqual(voice.check(utterance(1, 0, 0.3)), { enrolling: true }); // Too short to use; still not a turn.
  assert.equal(voice.status().collected, 0);
  for (const wobble of [0, 0.1, -0.1, 0.2]) assert.deepEqual(voice.check(utterance(1, wobble)), { enrolling: true });
  assert.equal(voice.status().collected, 4);
  voice.check(utterance(1, 0.05));
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(voice.status(), { available: true, enrolled: true, enrolling: false, collected: 0, needed: 5, lastResult: 'enrolled' });
  assert.deepEqual(voice.check(utterance(1, 0.15), { verify: true }), { owner: true });
  assert.deepEqual(voice.check(utterance(2), { verify: true }), { owner: false });
  assert.deepEqual(voice.check(utterance(1, 0, 0.3), { verify: true }), { owner: undefined }); // Too short to judge.
  const file = join(directory, 'private', 'owner-voice.json');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const stored = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(Object.keys(stored).sort(), ['createdAt', 'embedding', 'model', 'samples', 'version']); // No audio is kept.
  assert.equal(stored.model, SPEAKER_MODEL.id);
  const reopened = createOwnerVoice({ directory: join(directory, 'private'), embedder: fakeEmbedder(state) });
  reopened.configure('/models/speaker.onnx'); await reopened.load();
  assert.deepEqual(reopened.check(utterance(1), { verify: true }), { owner: true });
  await writeFile(file, JSON.stringify({ ...stored, model: 'another-model' }));
  await reopened.load();
  assert.equal(reopened.status().enrolled, false); // A profile from a different model is not comparable.
  await voice.forget();
  assert.equal(existsSync(file), false);
  assert.deepEqual(voice.check(utterance(1), { verify: true }), { owner: undefined });
});

test('mixed voices or a cancelled enrolment leave the previous profile untouched', async () => {
  const voice = createOwnerVoice({ embedder: fakeEmbedder({}) });
  voice.configure('/models/speaker.onnx');
  voice.begin();
  for (let i = 0; i < 5; i++) voice.check(utterance(1));
  await new Promise(resolve => setTimeout(resolve, 10));
  voice.begin();
  for (const who of [1, 1, 2, 3, 4]) voice.check(utterance(who)); // Other people talking over it.
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(voice.status().lastResult, 'inconsistent');
  assert.deepEqual(voice.check(utterance(1), { verify: true }), { owner: true });
  voice.begin(); voice.check(utterance(2)); voice.cancel();
  assert.equal(voice.status().lastResult, 'cancelled');
  assert.deepEqual(voice.check(utterance(2), { verify: true }), { owner: false });
});

test('an unknown model file is refused before any runtime is loaded', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'speaker-model-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const fake = join(directory, 'model.onnx'); await writeFile(fake, Buffer.alloc(1024, 7));
  let loads = 0;
  const embedder = createSpeakerEmbedder({ modelPath: fake, load() { loads++; return {}; } });
  assert.equal(embedder.present(), false);
  assert.equal(embedder.unavailable(), 'speaker_model_rejected');
  assert.equal(embedder.embed(Buffer.alloc(64000)), null);
  assert.equal(loads, 0);
  assert.equal(createSpeakerEmbedder({ modelPath: join(directory, 'missing.onnx') }).unavailable(), 'speaker_model_missing');
});

const model = join(import.meta.dirname, '../.local/voice-dev/assets/speaker', SPEAKER_MODEL.file);
const real = existsSync(model) && existsSync(locateSpeechAddon()) && process.platform === 'darwin';
test('the reviewed model tells two synthetic voices apart (needs the local model and DSH runtime)', { skip: !real }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'speaker-real-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const speak = (name, voice, text) => {
    execFileSync('say', ['-v', voice, '-o', join(directory, `${name}.aiff`), text]);
    execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', join(directory, `${name}.aiff`), join(directory, `${name}.wav`)]);
    const wav = readFileSync(join(directory, `${name}.wav`));
    return wav.subarray(wav.indexOf('data') + 8);
  };
  const embedder = createSpeakerEmbedder({ modelPath: model });
  assert.equal(embedder.unavailable(), null);
  const a1 = embedder.embed(speak('a1', 'Samantha', 'Hello there, are you around? I would like to ask about the weather.'));
  const a2 = embedder.embed(speak('a2', 'Samantha', 'Little D, are you there? Please tell me the time.'));
  const b1 = embedder.embed(speak('b1', 'Daniel', 'Little D, are you there? Please tell me the time.'));
  assert.equal(a1.length, 192);
  assert.ok(Math.abs(cosine(a1, a1) - 1) < 1e-3);
  // Synthetic voices only: this shows the pipeline works, not how well it knows a real person.
  assert.ok(cosine(a1, a2) > OWNER_VOICE.threshold, `same voice ${cosine(a1, a2)}`);
  assert.ok(cosine(a1, b1) < OWNER_VOICE.threshold && cosine(a2, b1) < OWNER_VOICE.threshold, `different voice ${cosine(a1, b1)} ${cosine(a2, b1)}`);
});
