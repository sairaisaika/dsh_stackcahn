import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const RATE = 24000;
const LANGUAGES = ['auto', 'zh', 'en'];
const fail = (code) => Object.assign(new Error(code), { code });
const absolute = (value) => {
  if (typeof value !== 'string' || !isAbsolute(value)) throw fail('speech-path-required');
  return value;
};
const languageOf = (language) => {
  if (!LANGUAGES.includes(language)) throw fail('speech-language-invalid');
  return language;
};
const duration = (value) => {
  if (!Number.isSafeInteger(value) || value < 1 || value > 600000) throw fail('speech-timeout-invalid');
  return value;
};

// Do not pass DSH tokens, model credentials, proxy settings or Python injection paths.
function environment() {
  const env = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'SYSTEMROOT']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return { ...env, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1',
    HF_HUB_DISABLE_TELEMETRY: '1', PYTHONNOUSERSITE: '1', PYTHONUNBUFFERED: '1',
    TOKENIZERS_PARALLELISM: 'false' };
}

function launch(binary, args) {
  const child = spawn(binary, args, { env: environment(), stdio: ['pipe', 'pipe', 'pipe'] });
  const owned = { child, ended: false, error: null, stopping: null };
  owned.closed = new Promise((resolve) => {
    child.once('error', () => { owned.error ??= fail('speech-process-failed'); });
    child.once('close', (code) => { owned.ended = true; resolve(code); });
  });
  child.stdin.on('error', () => { owned.error ??= fail('speech-process-failed'); });
  // Drain diagnostics without retaining or surfacing text (which may include speech).
  child.stderr.on('data', () => {});
  owned.stop = () => {
    if (!owned.stopping) owned.stopping = (async () => {
      if (owned.ended) return;
      child.kill('SIGTERM');
      // A paused pull consumer can keep ChildProcess.close waiting on its pipe
      // even after process exit. Discard unread speech on cancellation, then
      // still await close (which includes actual exit) before releasing ownership.
      child.stdin.destroy();
      child.stdout.destroy();
      const timer = setTimeout(() => child.kill('SIGKILL'), 1000);
      try { await owned.closed; } finally { clearTimeout(timer); }
    })();
    return owned.stopping;
  };
  return owned;
}

function guard(signal, timeoutMs, cancel) {
  let error = null;
  const abort = () => { error ??= fail('speech-aborted'); cancel(); };
  const timer = setTimeout(() => { error ??= fail('speech-timeout'); cancel(); }, timeoutMs);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  return { check() { if (error) throw error; },
    close() { clearTimeout(timer); signal?.removeEventListener('abort', abort); } };
}

export function pcmToWav(pcm, sampleRate = RATE) {
  if (![16000, 24000].includes(sampleRate)) throw fail('speech-rate-invalid');
  if (!Buffer.isBuffer(pcm) || !pcm.length || pcm.length % 2 || pcm.length > sampleRate * 2 * 30) {
    throw fail('speech-pcm-invalid');
  }
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export class WhisperBackend {
  #options; #active = null; #disposed = false;
  #owner = null; #lines = null;
  constructor({ binary, model, temporaryDirectory, protocol = 0, timeoutMs = 120000 }) {
    if (![0, 1].includes(protocol)) throw fail('speech-protocol-invalid');
    this.#options = { binary: absolute(binary), model: absolute(model),
      temporaryDirectory: protocol === 0 ? absolute(temporaryDirectory) : undefined,
      protocol, timeoutMs: duration(timeoutMs) };
  }
  #start(run, signal) {
    if (this.#disposed) return Promise.reject(fail('speech-disposed'));
    if (this.#active) return Promise.reject(fail('speech-busy'));
    const controller = new AbortController();
    const active = { controller };
    this.#active = active;
    active.promise = run(signal ? AbortSignal.any([controller.signal, signal]) : controller.signal)
      .finally(() => { this.#active = null; });
    return active.promise;
  }
  warmup({ signal } = {}) {
    return this.#options.protocol === 1
      ? this.#start(combined => this.#resident(null, null, combined), signal)
      : Promise.resolve();
  }
  transcribe(pcm, { language = 'auto', sampleRate = RATE, signal } = {}) {
    return this.#start(async combined => {
      const wav = pcmToWav(pcm, sampleRate);
      languageOf(language);
      return this.#options.protocol === 1 ? this.#resident(wav, language, combined) : this.#run(wav, language, combined);
    }, signal);
  }
  async #resident(wav, language, signal) {
    const { binary, model, timeoutMs } = this.#options;
    const operation = guard(signal, timeoutMs, () => { void this.#owner?.stop(); });
    try {
      operation.check();
      if (!this.#owner || this.#owner.ended) {
        this.#owner = launch(binary, [model]);
        this.#lines = new Lines(this.#owner.child.stdout);
        const ready = await this.#lines.next();
        operation.check();
        if (ready?.type !== 'ready' || ready.protocol !== 1) throw fail('speech-protocol-invalid');
      }
      if (!wav) return;
      const header = Buffer.alloc(5);
      header.writeUInt32LE(wav.length);
      header[4] = LANGUAGES.indexOf(language);
      await new Promise((resolve, reject) => {
        this.#owner.child.stdin.write(Buffer.concat([header, wav]), error =>
          error ? reject(fail('speech-process-failed')) : resolve());
      });
      const result = await this.#lines.next();
      operation.check();
      if (result?.type !== 'result' || typeof result.language !== 'string' || !/^[a-z]{2,3}$/.test(result.language) ||
          typeof result.textHex !== 'string' || result.textHex.length > 48000 || result.textHex.length % 2 ||
          /[^0-9a-f]/.test(result.textHex)) throw fail('speech-result-invalid');
      const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(result.textHex, 'hex'));
      if (text.length > 8000) throw fail('speech-result-invalid');
      return { text: text.trim(), language: result.language };
    } catch (error) {
      await this.#owner?.stop();
      this.#owner = null;
      this.#lines = null;
      operation.check();
      throw error?.code?.startsWith('speech-') ? error : fail('speech-transcription-failed');
    } finally {
      operation.close();
    }
  }
  async #run(wav, language, signal) {
    const { binary, model, temporaryDirectory, timeoutMs } = this.#options;
    let processOwner; let directory;
    const operation = guard(signal, timeoutMs, () => { void processOwner?.stop(); });
    try {
      operation.check();
      await mkdir(temporaryDirectory, { recursive: true, mode: 0o700 });
      const directoryInfo = await lstat(temporaryDirectory);
      if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() || (directoryInfo.mode & 0o077)) throw fail('speech-temp-not-private');
      directory = await mkdtemp(join(temporaryDirectory, 'utterance-'));
      const output = join(directory, 'result');
      operation.check();
      processOwner = launch(binary, ['-m', model, '-f', '-', '-l', language, '-oj', '-of', output,
        '-np', '-nt', '-t', '4', '-mc', '0']);
      processOwner.child.stdin.end(wav);
      processOwner.child.stdout.on('data', () => {});
      const code = await processOwner.closed;
      operation.check();
      if (processOwner.error || code !== 0) throw fail('speech-process-failed');
      const path = `${output}.json`; const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 131072) throw fail('speech-result-invalid');
      const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readFile(path)));
      if (!Array.isArray(data.transcription) || data.transcription.length > 512 ||
          typeof data.result?.language !== 'string' || !/^[a-z]{2,3}$/.test(data.result.language)) {
        throw fail('speech-result-invalid');
      }
      let text = '';
      for (const segment of data.transcription) {
        if (typeof segment?.text !== 'string' || text.length + segment.text.length > 8000) throw fail('speech-result-invalid');
        text += segment.text;
      }
      operation.check();
      return { text: text.trim(), language: data.result.language };
    } catch (error) {
      operation.check();
      throw error?.code?.startsWith('speech-') ? error : fail('speech-transcription-failed');
    } finally {
      operation.close();
      await processOwner?.stop();
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }
  async dispose() {
    this.#disposed = true;
    this.#active?.controller.abort();
    await this.#active?.promise.catch(() => {});
    await this.#owner?.stop();
    this.#owner = null;
    this.#lines = null;
  }
}

// One pull reader: at most one pipe buffer + one bounded line; no eager PCM queue.
class Lines {
  #iterator; #buffer = Buffer.alloc(0);
  constructor(stream) { this.#iterator = stream[Symbol.asyncIterator](); }
  async next() {
    for (;;) {
      const end = this.#buffer.indexOf(10);
      if (end >= 0) {
        if (end > 65536) throw fail('speech-protocol-invalid');
        const line = this.#buffer.subarray(0, end); this.#buffer = this.#buffer.subarray(end + 1);
        try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)); }
        catch { throw fail('speech-protocol-invalid'); }
      }
      if (this.#buffer.length > 65536) throw fail('speech-protocol-invalid');
      const { value, done } = await this.#iterator.next();
      if (done) throw fail('speech-process-ended');
      this.#buffer = Buffer.concat([this.#buffer, value]);
    }
  }
}

export class KokoroBackend {
  #options; #owner = null; #starting = null; #lines = null; #busy = false; #disposed = false;
  constructor({ python, assets, worker = fileURLToPath(new URL('../scripts/local_speech.py', import.meta.url)),
    timeoutMs = 180000 }) {
    this.#options = { python: absolute(python), assets: absolute(assets), worker: absolute(worker),
      timeoutMs: duration(timeoutMs) };
  }
  async #ready(operation) {
    operation.check();
    if (this.#owner && !this.#owner.ended) return;
    const { python, worker, assets } = this.#options;
    this.#starting = (async () => {
      // eSpeak's data path has a 160-byte POSIX limit. Keep the owned scratch short.
      const parent = Buffer.byteLength(tmpdir()) < 100 ? tmpdir() : '/tmp';
      const scratch = await mkdtemp(join(parent, 'sion-tts-'));
      try {
        operation.check();
        if (this.#disposed) throw fail('speech-disposed');
        const owner = launch(python, [worker, '--assets', assets, '--runtime-directory', scratch]);
        const stop = owner.stop;
        owner.closed = owner.closed.finally(() => rm(scratch, { recursive: true, force: true }));
        owner.closed.catch(() => {});
        owner.stop = async () => { await stop(); await owner.closed; };
        return owner;
      } catch (error) { await rm(scratch, { recursive: true, force: true }); throw error; }
    })();
    try { this.#owner = await this.#starting; } finally { this.#starting = null; }
    this.#lines = new Lines(this.#owner.child.stdout);
    const ready = await this.#lines.next();
    operation.check();
    if (this.#disposed) throw fail('speech-disposed');
    if (ready.type === 'error') throw fail('speech-startup-failed');
    if (ready.type !== 'ready' || ready.protocol !== 1 || ready.rate !== RATE || ready.channels !== 1)
      throw fail('speech-protocol-invalid');
  }
  async #stopWorker() {
    await this.#owner?.stop();
    this.#owner = null;
    this.#lines = null;
  }
  async warmup({ signal } = {}) {
    if (this.#disposed) throw fail('speech-disposed');
    if (this.#busy) throw fail('speech-busy');
    if (signal?.aborted) throw fail('speech-aborted');
    this.#busy = true;
    const operation = guard(signal, this.#options.timeoutMs, () => { void this.#owner?.stop(); });
    try {
      await this.#ready(operation);
    } catch (error) {
      await this.#stopWorker();
      operation.check();
      if (this.#disposed) throw fail('speech-disposed');
      throw error?.code?.startsWith('speech-') ? error : fail('speech-startup-failed');
    } finally {
      operation.close();
      this.#busy = false;
    }
  }
  async *synthesize(text, { language = 'auto', voice = '', speechRate = 1, signal } = {}) {
    if (this.#disposed) throw fail('speech-disposed');
    if (this.#busy) throw fail('speech-busy');
    languageOf(language);
    if (typeof text !== 'string' || !text.trim() || text.length > 8000 ||
        !['', 'zf_001', 'zf_038', 'af_maple'].includes(voice) || !Number.isFinite(speechRate) || speechRate < 0.5 || speechRate > 2) {
      throw fail('speech-request-invalid');
    }
    if (signal?.aborted) throw fail('speech-aborted');
    this.#busy = true;
    let complete = false;
    const operation = guard(signal, this.#options.timeoutMs, () => { void this.#owner?.stop(); });
    try {
      await this.#ready(operation);
      operation.check();
      const requestId = randomUUID();
      const request = JSON.stringify({ request_id: requestId, text, language, voice, speed: speechRate });
      if (Buffer.byteLength(request) > 65536) throw fail('speech-request-invalid');
      await new Promise((resolve, reject) => this.#owner.child.stdin.write(`${request}\n`, (error) =>
        error ? reject(fail('speech-process-failed')) : resolve()));
      let sequence = 0; let frames = 0;
      for (;;) {
        const message = await this.#lines.next();
        operation.check();
        if (message.request_id !== requestId) throw fail('speech-protocol-invalid');
        if (message.type === 'error') throw fail('speech-synthesis-failed');
        if (message.type === 'done') {
          if (message.frames !== frames || frames === 0) throw fail('speech-protocol-invalid');
          complete = true; return;
        }
        if (message.type !== 'pcm' || message.sequence !== sequence++ || typeof message.data !== 'string' ||
            !message.data.length || message.data.length > 32000) throw fail('speech-protocol-invalid');
        const pcm = Buffer.from(message.data, 'base64');
        if (pcm.toString('base64') !== message.data || pcm.length % 2 || !pcm.length || pcm.length > 24000) {
          throw fail('speech-protocol-invalid');
        }
        frames += pcm.length / 2;
        if (frames > RATE * 120) throw fail('speech-output-limit');
        yield pcm;
        operation.check();
        if (this.#disposed) throw fail('speech-disposed');
      }
    } catch (error) {
      operation.check();
      throw error?.code?.startsWith('speech-') ? error : fail('speech-synthesis-failed');
    } finally {
      operation.close();
      try { if (!complete) await this.#stopWorker(); }
      finally { this.#busy = false; }
    }
  }
  async dispose() { this.#disposed = true; await this.#starting?.catch(()=>{}); await this.#owner?.stop(); }
}
