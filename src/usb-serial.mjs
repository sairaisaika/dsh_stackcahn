import { spawn } from 'node:child_process';
import { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { usbPortPattern } from './usb-port.mjs';

const helper = fileURLToPath(new URL('../scripts/agent_usb_audio.py', import.meta.url));
const fault = code => Object.assign(new Error(code), { code });

/** One process owns one port. A destroy callback completes after child exit. */
export function openUsbSerial({ python, port, deviceId, onRead }) {
  if (typeof port !== 'string' || !usbPortPattern.test(port)) throw fault('voice_usb_port_required');
  if (typeof deviceId !== 'string' || !/^[0-9a-f]{12}$/.test(deviceId)) throw fault('voice_usb_identity_mismatch');
  const env = Object.fromEntries(['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR']
    .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  const child = spawn(python, [helper, port], {
    env: { ...env, PYTHONNOUSERSITE: '1' }, stdio: ['pipe', 'pipe', 'ignore', 'pipe', 'pipe'],
  });
  const status = child.stdio[3];
  const identity = child.stdio[4];
  let ended = false;
  let opened = false;
  let killTimer;
  let statusLine = '';
  let failure = 'voice_usb_open_failed';
  let resolveReady, rejectReady, resolveClosed;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  ready.catch(() => {});
  const closed = new Promise(resolve => { resolveClosed = resolve; });

  const stream = new Duplex({
    read() { child.stdout.resume(); },
    write(bytes, _encoding, callback) { child.stdin.write(bytes, callback); },
    destroy(error, callback) {
      child.stdin.destroy(); child.stdout.destroy(); status.destroy(); identity.destroy();
      if (!ended) {
        child.kill('SIGTERM');
        killTimer = setTimeout(() => child.kill('SIGKILL'), 500);
      }
      closed.then(() => callback(error));
    },
  });
  stream.on('error', () => {});
  child.stdout.on('data', bytes => {
    onRead?.(bytes.length);
    if (!stream.push(bytes)) child.stdout.pause();
  });
  child.stdout.pause();
  for (const resource of [child, child.stdin, child.stdout, status]) resource.on('error', () => stream.destroy());
  identity.on('error', () => {}); // If the helper exits early, its status/close still owns the result.
  identity.end(`${deviceId}\n`);
  const deadline = setTimeout(() => stream.destroy(), 3000);
  status.on('data', bytes => {
    statusLine += bytes.toString('ascii');
    if (statusLine.length > 16) stream.destroy();
  });
  status.once('end', () => {
    if (statusLine === 'ready\n' && !stream.destroyed) {
      clearTimeout(deadline);
      opened = true;
      resolveReady();
    } else {
      if (statusLine === 'unavailable\n') failure = 'voice_usb_port_unavailable';
      if (statusLine === 'mismatch\n') failure = 'voice_usb_identity_mismatch';
      stream.destroy();
    }
  });
  child.once('exit', () => {
    ended = true;
    if (opened) stream.destroy();
    else child.stdout.resume(); // Let the bounded open status finish first.
  });
  child.once('close', () => {
    ended = true;
    clearTimeout(deadline); clearTimeout(killTimer);
    rejectReady(fault(failure));
    resolveClosed();
    stream.destroy();
  });
  const released = new Promise(resolve => stream.once('close', resolve));
  return { stream, ready, closed: released, close() { stream.destroy(); return released; } };
}
