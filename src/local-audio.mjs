import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const error = (code) => Object.assign(new Error(code), { code });
const keys = (value, names) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === names.sort().join(',');
const integer = (n) => Number.isSafeInteger(n) && n >= 0;
const timeout = (n) => { if (!Number.isSafeInteger(n) || n < 1 || n > 120000) throw error('audio-timeout-invalid'); return n; };
const path = (p) => { if (typeof p !== 'string' || !isAbsolute(p)) throw error('audio-path-required'); return p; };
const env = () => Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'SYSTEMROOT']
  .filter(k => process.env[k]).map(k => [k, process.env[k]]));

// One process per input lease, one in-flight frame, no unbounded PCM queue.
// start() warms the actual model before the owner enables device capture.
export class LocalAudioFrontend {
  #options; #phase = 'new'; #child; #closed; #stopping; #failure;
  #pending; #buffer = Buffer.alloc(0); #sequence = 0; #lastEnd = 0;
  constructor({ python, directory, worker = fileURLToPath(new URL('../scripts/local_audio.py', import.meta.url)),
    aecV12 = false, startupTimeoutMs = 20000, frameTimeoutMs = 2000 }) {
    this.#options = { python: path(python), directory: path(directory), worker: path(worker),
      aecV12, startupTimeoutMs: timeout(startupTimeoutMs), frameTimeoutMs: timeout(frameTimeoutMs) };
  }
  start({ signal } = {}) {
    if (this.#phase !== 'new') return Promise.reject(error('audio-not-new'));
    if (signal?.aborted) return Promise.reject(error('audio-aborted'));
    this.#phase = 'starting';
    const { python, directory, worker, aecV12, startupTimeoutMs } = this.#options;
    const args = [worker, '--directory', directory];
    if (aecV12) args.push('--aec-v12');
    this.#child = spawn(python, args, {
      env: { ...env(), PYTHONNOUSERSITE: '1', PYTHONUNBUFFERED: '1', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.#closed = new Promise(resolve => this.#child.once('close', () => {
      resolve();
      if (!this.#stopping) void this.#fail('audio-process-failed');
    }));
    this.#child.once('error', () => { void this.#fail('audio-process-failed'); });
    this.#child.stdin.on('error', () => { void this.#fail('audio-process-failed'); });
    this.#child.stderr.on('data', () => {});
    this.#child.stdout.on('data', chunk => this.#receive(chunk));
    return this.#request(signal, startupTimeoutMs, message => {
      if (!keys(message, ['type', 'protocol', 'input_rate', 'output_rate', 'frame_samples', 'channels', 'block_samples', 'resampler_latency_samples'])
        || message.type !== 'ready' || message.protocol !== 1 || message.input_rate !== 24000 || message.output_rate !== 16000
        || message.frame_samples !== 240 || message.channels !== 2 || message.block_samples !== 512
        || !integer(message.resampler_latency_samples) || message.resampler_latency_samples > 16000) throw error('audio-protocol-invalid');
      this.#phase = 'ready';
      return { sampleRate: 16000, resamplerLatencySamples: message.resampler_latency_samples };
    });
  }
  process(pcm, { signal } = {}) {
    return this.#processFrames([pcm], signal).then(results => results[0]);
  }
  processBatch(frames, { signal } = {}) {
    return this.#processFrames(frames, signal);
  }
  reset({ signal } = {}) {
    if (this.#phase !== 'ready') return Promise.reject(error('audio-not-ready'));
    if (this.#pending) return Promise.reject(error('audio-busy'));
    return this.#exchange({ reset: true }, signal, message => {
      if (!keys(message, ['type']) || message.type !== 'reset') throw error('audio-protocol-invalid');
      this.#sequence = this.#lastEnd = 0;
    });
  }
  #processFrames(frames, signal) {
    if (this.#phase !== 'ready') return Promise.reject(error('audio-not-ready'));
    if (this.#pending) return Promise.reject(error('audio-busy'));
    if (!Array.isArray(frames) || !frames.length || frames.length > 4 ||
        Array.from(frames).some(pcm => !Buffer.isBuffer(pcm) || pcm.length !== 960))
      return Promise.reject(error('audio-frame-invalid'));
    if (this.#sequence > Number.MAX_SAFE_INTEGER - frames.length)
      return this.#fail('audio-sequence-exhausted').then(() => { throw this.#failure; });
    const data = frames.map(frame => frame.toString('base64'));
    return this.#exchange({ sequence: this.#sequence, data: data.length === 1 ? data[0] : data }, signal, message => {
      if (data.length === 1) return [this.#validateFrame(message)];
      if (!keys(message, ['type', 'frames']) || message.type !== 'processed_batch' ||
          !Array.isArray(message.frames) || message.frames.length !== data.length) throw error('audio-protocol-invalid');
      return message.frames.map(frame => this.#validateFrame(frame));
    });
  }
  #validateFrame(message) {
    if (!keys(message, ['type', 'sequence', 'probability', 'segment']) || message.type !== 'processed'
        || message.sequence !== this.#sequence || (message.probability !== null &&
          (typeof message.probability !== 'number' || !Number.isFinite(message.probability) || message.probability < 0 || message.probability > 1))) throw error('audio-protocol-invalid');
    let segment = null;
    if (message.segment !== null) {
      const s = message.segment;
      if (!keys(s, ['sample_start', 'sample_end', 'sample_rate', 'reason', 'continuation', 'data'])
          || !integer(s.sample_start) || !integer(s.sample_end) || s.sample_start < this.#lastEnd
          || s.sample_end <= s.sample_start || s.sample_start % 512 || s.sample_end % 512
          || s.sample_end > (this.#sequence + 1) * 160 || s.sample_end - s.sample_start > 320000
          || s.sample_rate !== 16000 || !['silence', 'limit'].includes(s.reason) || typeof s.continuation !== 'boolean'
          || typeof s.data !== 'string' || s.data.length > 853336 || message.probability === null) throw error('audio-protocol-invalid');
      const data = Buffer.from(s.data, 'base64');
      if (data.toString('base64') !== s.data || data.length !== (s.sample_end - s.sample_start) * 2) throw error('audio-protocol-invalid');
      segment = { pcm: data, sampleRate: 16000, sampleStart: s.sample_start, sampleEnd: s.sample_end,
        reason: s.reason, continuation: s.continuation };
      this.#lastEnd = s.sample_end;
    }
    this.#sequence++;
    return { probability: message.probability, segment };
  }
  #exchange(request, signal, validate) {
    const operation = this.#request(signal, this.#options.frameTimeoutMs, validate);
    if (this.#phase === 'ready') this.#child.stdin.write(JSON.stringify(request) + '\n');
    return operation;
  }
  #request(signal, duration, validate) {
    return new Promise((resolve, reject) => {
      const abort = () => { void this.#fail('audio-aborted'); };
      const timer = setTimeout(() => { void this.#fail('audio-timeout'); }, duration);
      this.#pending = { resolve, reject, validate, clear: () => {
        clearTimeout(timer); signal?.removeEventListener('abort', abort);
      } };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  }
  #receive(chunk) {
    if (this.#phase === 'closed') return;
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    if (this.#buffer.length > 900000) { void this.#fail('audio-protocol-invalid'); return; }
    const newline = this.#buffer.indexOf(10);
    if (newline < 0) return;
    try {
      // There can be only one response to the sole pending request.
      if (!this.#pending || newline !== this.#buffer.length - 1) throw error('audio-protocol-invalid');
      const message = JSON.parse(this.#buffer.subarray(0, newline).toString('utf8'));
      this.#buffer = Buffer.alloc(0);
      const result = this.#pending.validate(message);
      const pending = this.#pending; this.#pending = null;
      pending.clear(); pending.resolve(result);
    } catch { void this.#fail('audio-protocol-invalid'); }
  }
  async #fail(code) {
    this.#failure ??= error(code);
    this.#phase = 'closed';
    const pending = this.#pending; this.#pending = null;
    pending?.clear();
    if (!this.#stopping) this.#stopping = (async () => {
      if (!this.#child) return;
      this.#child.kill('SIGTERM');
      this.#child.stdin.destroy(); this.#child.stdout.destroy();
      const timer = setTimeout(() => this.#child.kill('SIGKILL'), 1000);
      try { await this.#closed; } finally { clearTimeout(timer); }
      this.#buffer = Buffer.alloc(0);
    })();
    await this.#stopping;
    pending?.reject(this.#failure);
  }
  async dispose() { await this.#fail('audio-disposed'); }
}
