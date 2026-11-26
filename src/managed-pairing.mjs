import { isAbsolute, join } from 'node:path';
import { createPairingHost } from './pairing-host.mjs';
import { createRuntimeSetup } from './runtime-setup.mjs';

/** Per-profile setup. Explicit custom pairing installations keep their own paths. */
export function createManagedPairing({ profileDirectory, directory = '', python = 'python3', allowDevice }) {
  const root = typeof profileDirectory === 'string' && isAbsolute(profileDirectory) ? join(profileDirectory, '.stackchan') : null;
  const runtime = createRuntimeSetup({ root, candidates: [python, '/opt/homebrew/bin/python3', '/usr/local/bin/python3', 'python3'] });
  let host = createPairingHost({ profileDirectory, directory, python, allowDevice });
  let generation = ''; let pending; let closed = false;
  async function select() {
    if (directory) return { ok: true };
    const state = await runtime.active();
    if (!state.ok) return state;
    if (!state.value) {
      if (generation) return { ok: false, error: 'runtime_storage_invalid' };
      return { ok: true };
    }
    if (generation !== state.value.generation) {
      await host.dispose();
      host = createPairingHost({ ...state.value, profileDirectory, allowDevice, managedUsb: allowDevice === undefined });
      generation = state.value.generation;
    }
    return { ok: true };
  }
  async function run(action, request, signal) {
    if (closed) return { ok: false, error: 'host_disposed' };
    if (pending) return { ok: false, error: 'host_busy' };
    const job = (async () => {
      if (action === 'prepareRuntime') {
        if (directory) return { ok: false, error: 'runtime_custom_installation' };
        const result = await runtime.prepare(signal);
        if (!result.ok) return result;
      }
      const selected = await select();
      if (!selected.ok) return selected;
      if (closed) return { ok: false, error: 'host_disposed' };
      if (action === 'relay') return host.relay(request, signal);
      if (action === 'identify') return host.identify(request, signal);
      return action === 'call' ? host.call(request, signal) : host.diagnose(signal);
    })();
    pending = job;
    try { return await job; } finally { pending = null; }
  }
  return {
    acquireIdentity(signal) {
      const fail = code => Object.assign(new Error(code), { code });
      if (closed) return Promise.reject(fail('host_disposed'));
      if (pending) return Promise.reject(fail('host_busy'));
      const job = (async () => {
        const selected = await select();
        if (!selected.ok) throw fail(selected.error);
        if (closed) throw fail('host_disposed');
        return host.acquireIdentity(signal);
      })();
      const held = job.then(lease => lease.closed).catch(() => {});
      pending = held;
      void held.finally(() => { if (pending === held) pending = null; });
      return job;
    },
    call: (request, signal) => run('call', request, signal),
    identify: (port, signal) => run('identify', port, signal),
    relay: (request, signal) => run('relay', request, signal),
    diagnose: signal => run('diagnose', null, signal),
    prepareRuntime: signal => run('prepareRuntime', null, signal),
    async dispose() { closed = true; await Promise.all([runtime.dispose(), host.dispose()]); if (pending) await pending; await host.dispose(); },
  };
}
