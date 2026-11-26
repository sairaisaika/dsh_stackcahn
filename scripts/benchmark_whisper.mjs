// Compare Whisper settings using fixed, locally synthesized utterances and the production Stop predicate.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { isStop } from '../src/bridge.mjs';
import { KokoroBackend, WhisperBackend, pcmToWav } from '../src/local-speech.mjs';

const [binaryPath, runtimePath, count = '3', mode] = process.argv.slice(2);
const workerPath = mode?.startsWith('--worker=') ? mode.slice('--worker='.length) : null;
const rounds = Number(count);
assert.ok(binaryPath && runtimePath && Number.isInteger(rounds) && rounds >= 1 && rounds <= 10 &&
  (mode === undefined || mode === '--reuse-model' || workerPath),
  'Usage: node scripts/benchmark_whisper.mjs <whisper-cli> <prepared-local-voice-runtime> [rounds, 1–10] [--reuse-model | --worker=<binary>]');
const binary = resolve(binaryPath);
const runtime = resolve(runtimePath);
const assets = join(runtime, 'assets');
const model = join(assets, 'whisper', 'ggml-small-q5_1.bin');
const sampleRate = 24000;
const run = promisify(execFile);
const environment = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
const fixtures = [
  { id: 'zh-stop', language: 'zh', stop: true, parts: ['停止。'] },
  { id: 'zh-negated', language: 'zh', stop: false, parts: ['不要停止。'] },
  { id: 'zh-negated-pause', language: 'zh', stop: false, parts: ['请不要', '停止。'] },
  { id: 'zh-short', language: 'zh', stop: false, parts: ['明天多伦多会下雪吗？'] },
  { id: 'zh-long', language: 'zh', stop: false, parts: ['现在正在播放一段中文语音。我们继续介绍今天的天气和日常生活。'] },
  { id: 'en-stop', language: 'en', stop: true, parts: ['Stop.'] },
  { id: 'en-negated', language: 'en', stop: false, parts: ['Please do not stop.'] },
  { id: 'en-short', language: 'en', stop: false, parts: ['What is the weather like in Toronto tomorrow?'] },
];
const profiles = [
  { id: 'baseline', args: () => [] },
  { id: 'stdin', pipe: true, args: () => [] },
  { id: 'short-context', args: sample => ['-ac', String(Math.max(256, Math.min(1500, Math.ceil((sample.durationMs / 20 + 100) / 32) * 32)))] },
  { id: 'single-candidate', args: () => ['-bo', '1', '-bs', '1'] },
];

const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2;
};
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const decodingArgs = ['-oj', '-nt', '-t', '4', '-mc', '0'];

async function render(sample, synthesis, directory) {
  const audio = [];
  for (const part of sample.parts) {
    if (audio.length) audio.push(Buffer.alloc(Math.round(sampleRate * 0.35) * 2));
    for await (const pcm of synthesis.synthesize(part, { language: sample.language })) audio.push(pcm);
  }
  const pcm = Buffer.concat([...audio, Buffer.alloc(Math.round(sampleRate * 0.512) * 2)]);
  const wav = pcmToWav(pcm, sampleRate);
  const durationMs = Math.round(pcm.length * 1000 / (sampleRate * 2));
  const input = join(directory, `${sample.id}.wav`);
  await writeFile(input, wav, { mode: 0o600, flag: 'wx' });
  return { ...sample, input, wav, durationMs, sha256: digest(wav) };
}

async function transcribe(sample, profile, output) {
  await rm(`${output}.json`, { force: true });
  const start = performance.now();
  // Enable timings in place of -np. Inference settings otherwise match WhisperBackend.
  let diagnostics;
  try {
    const operation = run(binary,
      ['-m', model, '-f', profile.pipe ? '-' : sample.input, '-l', sample.language, '-of', output, ...decodingArgs, ...profile.args(sample)],
      { encoding: 'utf8', timeout: 20000, maxBuffer: 1048576, env: environment });
    operation.child.stdin.on('error', () => {});
    operation.child.stdin.end(profile.pipe ? sample.wav : undefined);
    ({ stderr: diagnostics } = await operation);
  } catch {
    throw new Error(`Whisper failed for ${sample.id}/${profile.id}`);
  }
  const wallMs = performance.now() - start;
  const data = JSON.parse(await readFile(`${output}.json`, 'utf8'));
  assert.ok(Array.isArray(data.transcription), 'Whisper returned JSON transcription');
  const text = data.transcription.map(part => part.text).join('').trim();
  const timings = Object.fromEntries([...diagnostics.matchAll(/whisper_print_timings:\s*(load|encode) time\s*=\s*([0-9.]+) ms/g)]
    .map(([, name, value]) => [name, Number(value)]));
  assert.ok(Number.isFinite(timings.load) && Number.isFinite(timings.encode), 'Whisper returned model load and encode timings');
  return { wallMs, ...timings, text, stop: isStop(text) };
}

async function transcribeBatch(samples, language, directory) {
  const outputs = samples.map((_, index) => join(directory, `reuse-${index}.json`));
  const args = ['-m', model, '-l', language, ...decodingArgs];
  for (const [index, sample] of samples.entries()) args.push('-f', sample.input, '-of', outputs[index].slice(0, -5));
  const boundaries = [];
  const begin = performance.now();
  const operation = run(binary, args, {encoding: 'utf8', timeout: 30000, maxBuffer: 1048576, env: environment});
  operation.child.stdin.end();
  const diagnostics = createInterface({input: operation.child.stderr});
  diagnostics.on('line', line => {
    // The pinned CLI opens each JSON only after inference. Use this boundary
    // in both modes, without using diagnostic text as transcribed content.
    if (line === `output_json: saving output to '${outputs[boundaries.length]}'`) boundaries.push(performance.now());
  });
  try { await operation; }
  finally { diagnostics.close(); }
  assert.equal(boundaries.length, samples.length, 'each batch result has an ordered CLI boundary');
  const results = [];
  for (const [index, output] of outputs.entries()) {
    const data = JSON.parse(await readFile(output, 'utf8'));
    await rm(output);
    assert.ok(Array.isArray(data.transcription));
    const text = data.transcription.map(part => part.text).join('').trim();
    const detectedLanguage = data.result?.language;
    assert.match(detectedLanguage, /^[a-z]{2,3}$/u);
    results.push({ ms: boundaries[index] - (boundaries[index - 1] ?? begin), text, detectedLanguage, stop: isStop(text) });
  }
  return results;
}

async function compareModelReuse(samples, directory) {
  const result = [];
  for (const language of ['zh', 'en', 'auto']) {
    const group = language === 'auto' ? samples : samples.filter(sample => sample.language === language);
    const captures = new Map(group.map(sample => [sample.id, []]));
    for (let round = 0; round < rounds; round++) {
      const ordered = [...group.slice(round % group.length), ...group.slice(0, round % group.length)];
      const alone = async () => {
        const individual = [];
        for (const sample of ordered) individual.push((await transcribeBatch([sample], language, directory))[0]);
        return individual;
      };
      const together = async () => (await transcribeBatch([ordered.at(-1), ...ordered], language, directory)).slice(1);
      let isolated, reused;
      if (round % 2) { reused = await together(); isolated = await alone(); }
      else { isolated = await alone(); reused = await together(); }
      for (const [index, sample] of ordered.entries()) {
        captures.get(sample.id).push({ isolated: isolated[index], reused: reused[index] });
      }
    }
    for (const sample of group) {
      const observations = captures.get(sample.id);
      result.push({ id: sample.id, requestedLanguage: language,
        isolatedMedianMs: Math.round(median(observations.map(run => run.isolated.ms))),
        reusedMedianMs: Math.round(median(observations.map(run => run.reused.ms))),
        savingMedianMs: Math.round(median(observations.map(run => run.isolated.ms - run.reused.ms))),
        equalText: observations.filter(({isolated, reused}) => isolated.text === reused.text).length,
        equalLanguage: observations.filter(({isolated, reused}) => isolated.detectedLanguage === reused.detectedLanguage).length,
        isolatedCorrectStop: observations.filter(({isolated}) => isolated.stop === sample.stop).length,
        reusedCorrectStop: observations.filter(({reused}) => reused.stop === sample.stop).length });
    }
  }
  console.log(JSON.stringify({ source: 'synthetic', mode: 'reuse-model', rounds, samples: result }, null, 2));
}

async function compareSearchProfiles(samples, output) {
  const results = [];
  for (const sample of samples) {
    const runs = new Map(profiles.map(profile => [profile.id, []]));
    for (let round = 0; round < rounds; round++) {
      for (let index = 0; index < profiles.length; index++) {
        const profile = profiles[(index + round) % profiles.length];
        runs.get(profile.id).push(await transcribe(sample, profile, output));
      }
    }
    const baseline = runs.get('baseline');
    const measured = Object.fromEntries(profiles.map(profile => {
      const observations = runs.get(profile.id);
      return [profile.id, {
        wallMedianMs: Math.round(median(observations.map(run => run.wallMs))),
        loadMedianMs: Math.round(median(observations.map(run => run.load))),
        encodeMedianMs: Math.round(median(observations.map(run => run.encode))),
        matchesBaseline: observations.filter((run, index) => run.text === baseline[index].text).length,
        correctStop: observations.filter(run => run.stop === sample.stop).length,
      }];
    }));
    results.push({ id: sample.id, language: sample.language, durationMs: sample.durationMs, sha256: sample.sha256, measured });
  }
  console.log(JSON.stringify({ source: 'synthetic', rounds, samples: results }, null, 2));
}

async function compareWorker(samples, directory) {
  const cli = new WhisperBackend({binary, model, temporaryDirectory: join(directory, 'legacy-transcripts')});
  const resident = new WhisperBackend({binary: resolve(workerPath), model, protocol: 1});
  const results = {explicit: [], auto: []};
  const measure = async (backend, pcm, language) => {
    const start = performance.now();
    const result = await backend.transcribe(pcm, {language, sampleRate});
    return {result, ms: performance.now() - start};
  };
  try {
    const start = performance.now();
    await resident.warmup();
    const warmupMs = Math.round(performance.now() - start);
    for (let round = 0; round < rounds; round++) {
      const ordered = [...samples.slice(round % samples.length), ...samples.slice(0, round % samples.length)];
      for (const sample of ordered) {
        const pcm = sample.wav.subarray(44);
        for (const language of [sample.language, 'auto']) {
          let legacy, worker;
          if (round % 2) {
            worker = await measure(resident, pcm, language); legacy = await measure(cli, pcm, language);
          } else {
            legacy = await measure(cli, pcm, language); worker = await measure(resident, pcm, language);
          }
          assert.deepEqual(worker.result, legacy.result, `${sample.id}/${language}/round-${round + 1}`);
          assert.equal(isStop(worker.result.text), sample.stop, `${sample.id}/${language} Stop`);
          results[language === 'auto' ? 'auto' : 'explicit'].push({cli: legacy.ms, worker: worker.ms});
        }
      }
    }
    const summary = Object.fromEntries(Object.entries(results).map(([key, values]) => [key, {
      pairs: values.length,
      cliMedianMs: Math.round(median(values.map(value => value.cli))),
      workerMedianMs: Math.round(median(values.map(value => value.worker))),
      pairedSavingsMs: Math.round(median(values.map(value => value.cli - value.worker))),
    }]));
    console.log(JSON.stringify({source: 'synthetic', mode: 'resident-worker', rounds, warmupMs, summary}, null, 2));
  } finally {
    await Promise.all([cli.dispose(), resident.dispose()]);
  }
}

const directory = await mkdtemp(join(tmpdir(), 'sion-whisper-bench-'));
const synthesis = new KokoroBackend({ python: join(runtime, 'venv', 'bin', 'python'), assets });
try {
  const samples = [];
  for (const fixture of fixtures) samples.push(await render(fixture, synthesis, directory));
  await synthesis.dispose();
  const output = join(directory, 'result');
  await transcribe(samples[0], profiles[0], output); // Warm the file cache before comparing starts.
  if (mode === '--reuse-model') await compareModelReuse(samples, directory);
  else if (workerPath) await compareWorker(samples, directory);
  else await compareSearchProfiles(samples, output);
} finally {
  await synthesis.dispose();
  await rm(directory, { recursive: true, force: true });
}
