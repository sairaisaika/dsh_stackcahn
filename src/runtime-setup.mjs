import { spawn } from 'node:child_process';
import { lstat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('../scripts/prepare_runtime.py', import.meta.url));
const codes = new Set(['runtime_python_required', 'runtime_storage_invalid', 'runtime_package_invalid', 'runtime_setup_failed', 'host_busy']);
const failure = error => ({ ok: false, error });

/** Trusted Host root and interpreters only. No Client-provided paths or commands. */
export function createRuntimeSetup({ root, candidates }) {
  if (root !== null && (typeof root !== 'string' || !isAbsolute(root))) throw new TypeError('Absolute runtime root required');
  const lifetime = new AbortController();
  let pending;
  async function active() {
    if (!root) return { ok: true, value: null };
    let published = false;
    try {
      const info = await lstat(root);
      if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077)) return failure('runtime_storage_invalid');
      let file;
      try {
        file = await open(join(root, 'active.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
        const st = await file.stat();
        if (!st.isFile() || st.uid !== process.getuid() || (st.mode & 0o077) || st.size > 4096) return failure('runtime_storage_invalid');
        const value = JSON.parse(await file.readFile('utf8'));
        if (Object.keys(value).sort().join(',') !== 'generation,version' || value.version !== 1 || typeof value.generation !== 'string' || !/^[0-9a-f]{32}$/.test(value.generation)) return failure('runtime_storage_invalid');
        published = true;
        const directory = join(root, value.generation);
        const ds = await lstat(directory);
        if (!ds.isDirectory() || ds.uid !== process.getuid() || (ds.mode & 0o077)) return failure('runtime_storage_invalid');
        return { ok: true, value: { generation: value.generation, python: join(directory, 'bin/python3'), directory: join(root, 'pairing') } };
      } finally { await file?.close(); }
    } catch (error) {
      if (error.code === 'ENOENT' && !published) return { ok: true, value: null };
      return failure('runtime_storage_invalid');
    }
  }
  function execute(command, args, signal, timeout) {
    return new Promise(resolve => {
      if (signal.aborted) { resolve(null); return; }
      const child = spawn(command, args, { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
      const chunks = []; let bytes = 0; let failed = false; let escalation;
      const stop = () => {
        failed = true;
        try { process.kill(-child.pid, 'SIGTERM'); } catch {}
        escalation ??= setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 500);
      };
      const timer = setTimeout(stop, timeout);
      signal.addEventListener('abort', stop, { once: true });
      child.on('error', () => { failed = true; });
      child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 4096) stop(); else chunks.push(chunk); });
      child.on('close', code => {
        clearTimeout(timer); clearTimeout(escalation); signal.removeEventListener('abort', stop);
        resolve(failed ? null : { code, text: Buffer.concat(chunks).toString('utf8') });
      });
      if (signal.aborted) stop();
    });
  }
  async function work(signal) {
    if (!root) return failure('runtime_profile_required');
    const combined = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
    if (combined.aborted) return failure('runtime_setup_failed');
    let bootstrap;
    for (const candidate of [...new Set(candidates)]) {
      const probe = await execute(candidate, ['-I', '-c', 'import sys,venv;sys.exit(0 if sys.version_info >= (3,10) else 1)'], combined, 5000);
      if (combined.aborted) return failure('runtime_setup_failed');
      if (probe?.code === 0 && probe.text === '') { bootstrap = candidate; break; }
    }
    if (!bootstrap) return failure('runtime_python_required');
    const result = await execute(bootstrap, ['-I', helper, '--root', root], combined, 240000);
    if (result) {
      try {
        const value = JSON.parse(result.text);
        if (result.code === 0 && value.ok === true && Object.keys(value).sort().join(',') === 'generation,ok'
            && /^[0-9a-f]{32}$/.test(value.generation)) return { ok: true };
        if (result.code === 1 && value.ok === false && Object.keys(value).sort().join(',') === 'error,ok' && codes.has(value.error)) return failure(value.error);
      } catch {}
    }
    return failure('runtime_setup_failed');
  }
  return {
    active,
    async prepare(signal) {
      if (lifetime.signal.aborted) return failure('host_disposed');
      if (pending) return failure('host_busy');
      pending = work(signal);
      try { return await pending; } finally { pending = null; }
    },
    async dispose() { lifetime.abort(); if (pending) await pending; },
  };
}
