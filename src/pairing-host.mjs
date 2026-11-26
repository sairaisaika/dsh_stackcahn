import { acquirePairingIdentity } from './pairing-identity.mjs';
import { spawn } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localAddress } from './pairing.mjs';
import { openUsbSerial } from './usb-serial.mjs';
import { readRelayConfiguration } from './agent-relay-config.mjs';

const fault = code => Object.assign(new Error(code), { code });

const helper = fileURLToPath(new URL('../scripts/agent_pairing_host.py', import.meta.url));
const environmentHelper = fileURLToPath(new URL('../scripts/agent_environment.py', import.meta.url));
const codes = new Set(['private_storage_required', 'private_storage_invalid', 'host_busy',
  'invalid_local_url', 'optional_lan_not_supported', 'identity_generation_failed', 'invalid_request', 'revision_conflict',
  'wrong_device', 'reconcile_required', 'invalid_port', 'device_access_disabled',
  'managed_usb_port_unavailable', 'device_state_unavailable', 'identity_conflict', 'candidate_required', 'active_identity_required',
  'device_result_unconfirmed', 'operation_unconfirmed', 'relay_profile_required', 'relay_bundle_changed',
  'relay_not_supported', 'relay_state_changed', 'physical_window_required']);
const relayActions = new Set(['relay_check', 'relay_inspect', 'relay_install', 'relay_remove']);
const usbActions = new Set(['identify', 'inspect', 'install', 'remove', 'relay_inspect', 'relay_install', 'relay_remove']);
const hex = (s, n) => typeof s === 'string' && new RegExp(`^[0-9a-f]{${n}}$`).test(s);
const keys = (object, names) => object && typeof object === 'object' && !Array.isArray(object)
  && Object.keys(object).sort().join(',') === [...names].sort().join(',');

function decode(text, identify = false) {
  const reply = JSON.parse(text);
  if (reply?.ok === false && keys(reply, ['ok', 'error']) && codes.has(reply.error)) return reply;
  const v = reply?.value;
  if (identify) {
    if (reply.ok !== true || !keys(reply, ['ok', 'value']) || !keys(v, ['deviceId']) || !hex(v.deviceId, 12))
      throw new Error('invalid');
    return reply;
  }
  if (!keys(reply, ['ok', 'value']) || reply.ok !== true
      || !keys(v, ['revision', 'deviceId', 'activePairId', 'candidatePairId', 'pending', 'observed', 'connected'])
      || !Number.isSafeInteger(v.revision) || v.revision < 0 || v.connected !== false
      || !(v.deviceId === '' || hex(v.deviceId, 12))
      || ![v.activePairId, v.candidatePairId].every(id => id === '' || hex(id, 32))
      || !['', 'install', 'remove'].includes(v.pending)) throw new Error('invalid');
  if (v.observed !== null && (!keys(v.observed, ['state', 'pairId'])
      || !['empty', 'paired', 'revoked', 'unavailable', 'corrupt', 'storage_error'].includes(v.observed.state)
      || (v.observed.state === 'paired' ? !hex(v.observed.pairId, 32) : v.observed.pairId !== '')))
    throw new Error('invalid');
  return reply;
}

function decodeRelay(text) {
  const reply = JSON.parse(text);
  if (reply?.ok === false && keys(reply, ['ok', 'error']) && codes.has(reply.error)) return reply;
  const v = reply?.value;
  if (!keys(reply, ['ok', 'value']) || reply.ok !== true ||
      !keys(v, ['revision', 'pairId', 'pairingPending', 'staged', 'stagedRevision', 'device']) ||
      !Number.isSafeInteger(v.revision) || v.revision < 0 || !(v.pairId === '' || hex(v.pairId, 32)) ||
      typeof v.pairingPending !== 'boolean' || !['ready', 'missing', 'invalid', 'pair_mismatch', 'unavailable'].includes(v.staged) ||
      (v.staged === 'ready' ? !hex(v.stagedRevision, 32) : v.stagedRevision !== '') ||
      (v.device !== null && (!keys(v.device, ['state', 'revision']) || !v.pairId ||
        !['empty', 'ready', 'invalid', 'unavailable', 'storage_error'].includes(v.device.state) ||
        (v.device.revision !== '' && (v.device.state !== 'ready' || !hex(v.device.revision, 32)))))) throw new Error('invalid');
  return reply;
}

/** Host network metadata only. An address can be present even if Sion cannot reach it. */
export function localNetworkCandidates(interfaces) {
  const endpoints = new Map();
  for (const [interfaceName, entries] of Object.entries(interfaces).sort(([a], [b]) => a.localeCompare(b))) {
    if (!/^[A-Za-z0-9_.-]{1,32}$/.test(interfaceName)) continue;
    for (const { address, family, internal } of entries ?? []) {
      if (family !== 'IPv4' || internal) continue;
      try {
        const endpoint = localAddress(`wss://${address}:9080/audio`, 'wss:');
        if (endpoint.hostname === address && !endpoints.has(address))
          endpoints.set(address, { interfaceName, url: endpoint.href });
      } catch {
        // Address outside the pairing contract.
      }
    }
  }
  return { status: 'available', endpoints: [...endpoints.values()].slice(0, 16), truncated: endpoints.size > 16 };
}

function inspectLocalNetwork() {
  try { return localNetworkCandidates(networkInterfaces()); }
  catch { return { status: 'unavailable', endpoints: [], truncated: false }; }
}

function decodeEnvironment(text) {
  const reply = JSON.parse(text), v = reply?.value;
  if (!keys(reply, ['ok', 'value']) || reply.ok !== true
      || !keys(v, ['platform', 'pythonReady', 'storage', 'deviceAccess', 'serial', 'openssl', 'ports', 'truncated'])
      || !['macos', 'unsupported'].includes(v.platform) || typeof v.pythonReady !== 'boolean'
      || !['unconfigured', 'absent', 'private', 'invalid', 'unavailable'].includes(v.storage)
      || typeof v.deviceAccess !== 'boolean' || typeof v.truncated !== 'boolean'
      || !['available', 'missing', 'unavailable', 'not_checked'].includes(v.serial)
      || !['available', 'missing', 'unavailable'].includes(v.openssl)
      || !Array.isArray(v.ports) || v.ports.length > 16) throw new Error('invalid');
  const paths = new Set();
  for (const p of v.ports) {
    if (!keys(p, ['path', 'description', 'vid', 'pid'])
        || typeof p.path !== 'string' || !/^\/dev\/cu\.[A-Za-z0-9._-]{1,180}$/.test(p.path)
        || typeof p.description !== 'string' || [...p.description].length > 96 || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(p.description)
        || ![p.vid, p.pid].every(n => Number.isInteger(n) && n >= 0 && n <= 65535)
        || paths.has(p.path)) throw new Error('invalid');
    paths.add(p.path);
  }
  if ((v.platform !== 'macos' || !v.pythonReady || v.serial !== 'available') && (v.ports.length || v.truncated))
    throw new Error('invalid');
  return reply;
}

/** Host-only coordinator. Root/interpreter/device permission are trusted composition
 * options, never Client request fields. Constructing it performs no I/O. */
export function createPairingHost({ profileDirectory, directory = '', python = 'python3', allowDevice, managedUsb = false }) {
  if (typeof directory !== 'string' || (directory && !isAbsolute(directory))) throw new TypeError('Private absolute directory required');
  let running = null;
  const lifetime = new AbortController();
  async function run(request, signal, diagnostics = false) {
    if (lifetime.signal.aborted) return { ok: false, error: 'host_disposed' };
    if (running) return { ok: false, error: 'host_busy' };
    if (!diagnostics && !directory) return { ok: false, error: 'host_unconfigured' };
    const combined = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
    if (combined.aborted) return { ok: false, error: 'operation_unconfirmed' };
    let payload;
    try {
      const data = request && Object.hasOwn(request, 'authorizeUsb') ? { ...request } : request;
      if (data !== request) delete data.authorizeUsb;
      payload = JSON.stringify(data);
      if (typeof payload !== 'string' || Buffer.byteLength(payload) > 4096) throw new Error('invalid');
    } catch { return { ok: false, error: 'invalid_request' }; }
    const args = diagnostics ? [environmentHelper, '--root', directory]
      : [helper, '--root', directory, '--node', process.execPath];
    const relay = relayActions.has(request?.action);
    if (relay && typeof profileDirectory === 'string' && isAbsolute(profileDirectory)) args.push('--profile', profileDirectory);
    if (allowDevice === true) args.push('--allow-device');
    else if (!diagnostics && managedUsb && request?.authorizeUsb === true
        && usbActions.has(request.action)) args.push('--allow-managed-usb');
    // detached POSIX process group lets disposal stop credential generation children
    // too. Never use shell interpolation; stderr is deliberately not collected.
    const child = spawn(python, args, { detached: true, stdio: ['pipe', 'pipe', 'ignore'] });
    const work = new Promise(resolve => {
      const output = []; let bytes = 0; let failed = false; let escalation;
      const stop = () => {
        failed = true;
        try { process.kill(-child.pid, 'SIGTERM'); } catch {}
        escalation ??= setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 500);
      };
      const timer = setTimeout(stop, diagnostics ? 15000 : 45000);
      combined.addEventListener('abort', stop, { once: true });
      child.on('error', () => { failed = true; });
      child.stdin.on('error', () => { failed = true; });
      child.stdout.on('data', data => {
        bytes += data.length;
        if (bytes > (diagnostics ? 16384 : 4096)) stop();
        else output.push(data);
      });
      child.on('close', code => {
        clearTimeout(timer); clearTimeout(escalation); combined.removeEventListener('abort', stop);
        let result = { ok: false, error: diagnostics ? 'environment_unavailable' : 'operation_unconfirmed' };
        if (!failed && (code === 0 || code === 1)) {
          try {
            const text = Buffer.concat(output).toString('utf8');
            const parsed = diagnostics ? decodeEnvironment(text) : relay ? decodeRelay(text)
              : decode(text, request?.action === 'identify');
            if ((code === 0) === parsed.ok) result = parsed;
          } catch {}
        }
        resolve(result);
      });
      if (combined.aborted) stop();
      child.stdin.end(diagnostics ? undefined : payload);
    });
    running = work;
    try { return await work; } finally { if (running === work) running = null; }
  }
  return {
    acquireIdentity(signal) {
      if (lifetime.signal.aborted) return Promise.reject(Object.assign(new Error('host_disposed'), { code: 'host_disposed' }));
      if (running) return Promise.reject(Object.assign(new Error('host_busy'), { code: 'host_busy' }));
      const combined = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
      const job = acquirePairingIdentity({ directory, python, signal: combined }).then(lease => {
        let usb;
        let releasing = false;
        const closed = lease.closed.then(async result => {
          releasing = true;
          await usb?.close();
          return result;
        });
        return { ...lease, closed,
          openUsb(port, onRead) {
            if (releasing || combined.aborted) throw fault('voice_identity_lost');
            if (!(allowDevice === true || managedUsb && allowDevice === undefined)) throw fault('voice_usb_access_disabled');
            if (usb) throw fault('voice_busy');
            const opening = openUsbSerial({ python, port, deviceId: lease.deviceId, onRead });
            usb = opening;
            void opening.closed.then(() => { if (usb === opening) usb = undefined; });
            return opening;
          },
          async release() {
            releasing = true;
            await usb?.close();
            return lease.release();
          },
        };
      });
      const held = job.then(lease => lease.closed).catch(() => {});
      running = held;
      void held.finally(() => { if (running === held) running = null; });
      return job;
    },
    call: (request, signal) => request?.action === 'identify'
      ? Promise.resolve({ ok: false, error: 'invalid_request' }) : run(request, signal),
    identify: (port, signal) => run({ action: 'identify', port, authorizeUsb: true }, signal),
    async relay(request, signal) {
      if (!relayActions.has(request?.action)) return { ok: false, error: 'invalid_request' };
      if (request.action !== 'relay_check' && request.authorizeUsb !== true) return { ok: false, error: 'device_access_disabled' };
      const result = await run(request, signal);
      if (!result.ok) return result;
      const { pairId, ...value } = result.value;
      let host = 'unavailable';
      if (typeof profileDirectory === 'string' && isAbsolute(profileDirectory)) {
        try { host = (await readRelayConfiguration(profileDirectory)).pairId === pairId ? 'ready' : 'pair_mismatch'; }
        catch (error) { host = error?.code === 'voice_relay_config_missing' ? 'missing' : 'invalid'; }
      }
      return { ok: true, value: { ...value, paired: !!pairId, host } };
    },
    async diagnose(signal) {
      const result = await run({}, signal, true);
      if (result.ok && result.value.platform === 'macos') {
        result.value.localNetwork = inspectLocalNetwork();
        if (managedUsb) result.value.managedUsb = true;
      }
      return result;
    },
    async dispose() { lifetime.abort(); if (running) await running; },
  };
}
