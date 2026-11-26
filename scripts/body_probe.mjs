// Direct body test driver (layer 1 tooling, see wiki/body-interface.md).
//
// Talks to the paired StackChan over USB with the plugin's own pairing, USB and
// protocol code, but without speech recognition, DSH or a model in the loop:
// every command is given exactly, every result is read back and timed, and one
// JSON line per event goes to --out. DSH's voice service must not hold the
// port (turn the voice service off first); the pairing lease makes the two
// mutually exclusive.
//
//   node scripts/body_probe.mjs --out DIR status
//   node scripts/body_probe.mjs --out DIR move 300 450 500 [move ...]
//   node scripts/body_probe.mjs --out DIR sample imu 5 10   (sensor, seconds, Hz)
//   node scripts/body_probe.mjs --out DIR ring '#203040' 1000
//   node scripts/body_probe.mjs --out DIR -- frames 5000 hold '300,450,500;-300,450,500'
//   node scripts/body_probe.mjs --out DIR -- torque limp 10000 read pause 1000 read torque release 0
//   node scripts/body_probe.mjs --out DIR record nfc 100 10000 nfc ndef nfc 0 135   (card events, NDEF, raw pages; read-only)
//   node scripts/body_probe.mjs --out DIR storedir /abs/frames 0 bank cycle 0 12 50 2 timeline /abs/sweep.json drop all
//
// Put the steps after "--" whenever an angle is negative.
// Steps run in the order given on one connection. "pause MS" waits; "label
// TEXT" writes a marker line (for example the pose the owner is holding).
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { createManagedPairing } from '../src/managed-pairing.mjs';
import { createAgentTransport, frameTag } from '../src/agent-transport.mjs';
import { waitForUsbReady } from '../src/agent-usb-wire.mjs';
import { usbPortPattern } from '../src/usb-port.mjs';
import { tonesToPcm, pcmToWav, levels, withSilentTail } from '../src/sound.mjs';
import { loadImageRgb565 } from '../src/display-image.mjs';
import { readType2 } from '../src/nfc-ndef.mjs';
import { writeFileSync } from 'node:fs';

/** Parse the step list. Exported for tests; no device access. */
export function parseSteps(words) {
  const steps = [];
  const int = (value, low, high, name) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < low || n > high) throw new Error(`${name} must be an integer ${low}..${high}`);
    return n;
  };
  for (let i = 0; i < words.length;) {
    const word = words[i++];
    if (word === 'status') steps.push({ kind: 'status' });
    else if (word === 'move') {
      steps.push({ kind: 'move', yaw: int(words[i++], -1280, 1280, 'yaw'), pitch: int(words[i++], 50, 650, 'pitch'),
        durationMs: int(words[i++], 100, 3000, 'durationMs') });
    } else if (word === 'sample') {
      const sensor = words[i++];
      if (!['imu', 'headTouch', 'ambient', 'battery', 'motion'].includes(sensor)) throw new Error(`unknown sensor ${sensor}`);
      steps.push({ kind: 'sample', sensor, seconds: int(words[i++], 1, 120, 'seconds'), hz: int(words[i++], 1, 20, 'hz') });
    } else if (word === 'ring') {
      const color = words[i++];
      if (!/^#[0-9a-fA-F]{6}$/.test(color ?? '')) throw new Error('ring color must be #RRGGBB');
      steps.push({ kind: 'ring', color, durationMs: int(words[i++], 250, 10000, 'durationMs') });
    } else if (word === 'frames') {
      const holdMs = int(words[i++], 0, 60000, 'holdMs');
      const torque = words[i++];
      if (!['hold', 'limp'].includes(torque)) throw new Error('frames torque must be hold or limp');
      const frames = String(words[i++] ?? '').split(';').map(frame => {
        const [yaw, pitch, durationMs] = frame.split(',');
        return { yaw: int(yaw, -1280, 1280, 'yaw'), pitch: int(pitch, 50, 650, 'pitch'), durationMs: int(durationMs, 100, 3000, 'durationMs') };
      });
      if (frames.length > 8) throw new Error('at most 8 frames');
      steps.push({ kind: 'frames', frames, holdMs, torque });
    } else if (word === 'torque') {
      const torque = words[i++];
      if (!['hold', 'limp', 'release'].includes(torque)) throw new Error('torque must be hold, limp or release');
      const holdMs = int(words[i++], 0, 60000, 'holdMs');
      if ((torque === 'release') !== (holdMs === 0)) throw new Error('release takes 0; hold and limp need a time');
      steps.push({ kind: 'torque', torque, holdMs });
    } else if (word === 'read') steps.push({ kind: 'read' });
    else if (word === 'rotate') {
      const velocity = int(words[i++], -1000, 1000, 'velocity');
      if (velocity === 0) throw new Error('velocity must not be 0');
      steps.push({ kind: 'rotate', velocity, durationMs: int(words[i++], 100, 20000, 'durationMs'), holdMs: 0, torque: 'hold' });
    }
    else if (word === 'record') {
      const sensors = String(words[i++] ?? '').split(',');
      steps.push({ kind: 'record', sensors, intervalMs: int(words[i++], 20, 10000, 'intervalMs'), durationMs: int(words[i++], 100, 30000, 'durationMs') });
    } else if (word === 'leds') {
      const leds = String(words[i++] ?? '').split(',').map(v => int(v, 0, 11, 'led'));
      const color = words[i++];
      if (!/^#[0-9a-fA-F]{6}$/.test(color ?? '')) throw new Error('leds color must be #RRGGBB');
      steps.push({ kind: 'leds', leds, color, durationMs: int(words[i++], 20, 10000, 'durationMs') });
    } else if (word === 'volume') steps.push({ kind: 'volume', volume: int(words[i++], 0, 100, 'volume') });
    else if (word === 'tone') steps.push({ kind: 'tone', hz: int(words[i++], 20, 12000, 'hz'), durationMs: int(words[i++], 10, 10000, 'durationMs'),
      volume: int(words[i++], 0, 100, 'volume percent') / 100 });
    else if (word === 'mic') steps.push({ kind: 'mic', durationMs: int(words[i++], 100, 30000, 'durationMs') });
    else if (word === 'text') {   // text WORDS_WITH_UNDERSCORES area ms
      const text = String(words[i++] ?? '').replaceAll('_', ' ');
      const area = words[i++];
      if (!text || !['full', 'top', 'bottom'].includes(area)) throw new Error('text needs words and full|top|bottom');
      steps.push({ kind: 'text', text, area, durationMs: int(words[i++], 100, 60000, 'durationMs') });
    } else if (word === 'image') {   // image /absolute/path ms
      const path = words[i++];
      if (!path?.startsWith('/')) throw new Error('image needs an absolute path');
      steps.push({ kind: 'image', path, durationMs: int(words[i++], 100, 60000, 'durationMs') });
    } else if (word === 'clear') steps.push({ kind: 'clear' });
    // Frame bank (wiki/head-coupled-view.md).
    else if (word === 'store') {   // store SLOT /absolute/image
      const slot = int(words[i++], 0, 47, 'slot'), path = words[i++];
      if (!path?.startsWith('/')) throw new Error('store needs an absolute path');
      steps.push({ kind: 'store', slot, path });
    } else if (word === 'storedir') {   // storedir /absolute/dir FIRSTSLOT: every .bmp/.png in name order
      const path = words[i++];
      if (!path?.startsWith('/')) throw new Error('storedir needs an absolute directory');
      steps.push({ kind: 'storedir', path, first: int(words[i++], 0, 47, 'first slot') });
    } else if (word === 'show') steps.push({ kind: 'show', slot: int(words[i++], 0, 47, 'slot'), durationMs: int(words[i++], 100, 60000, 'durationMs') });
    else if (word === 'drop') {
      const slot = words[i] === 'all' ? (i++, 'all') : int(words[i++], 0, 47, 'slot');
      steps.push({ kind: 'drop', slot });
    } else if (word === 'bank') steps.push({ kind: 'bank' });
    else if (word === 'cycle') {   // cycle FROM TO INTERVAL_MS ROUNDS: frames FROM..TO..FROM, no head motion
      steps.push({ kind: 'cycle', from: int(words[i++], 0, 47, 'from'), to: int(words[i++], 0, 47, 'to'),
        intervalMs: int(words[i++], 20, 2000, 'interval'), rounds: int(words[i++], 1, 50, 'rounds') });
    } else if (word === 'timeline') {   // timeline /absolute/file.json: {points:[{atMs,yaw?,pitch?,frame?}]}
      const path = words[i++];
      if (!path?.startsWith('/')) throw new Error('timeline needs an absolute path');
      steps.push({ kind: 'timeline', path });
    }
    else if (word === 'path') steps.push({ kind: 'path', seconds: int(words[i++], 1, 15, 'seconds') });
    else if (word === 'ir') steps.push({ kind: 'ir', address: int(words[i++], 0, 65535, 'address'), command: int(words[i++], 0, 255, 'command') });
    else if (word === 'nfc') {   // nfc ndef | nfc PAGE COUNT (read-only)
      if (words[i] === 'ndef') { i++; steps.push({ kind: 'nfc' }); }
      else {
        const page = int(words[i++], 0, 255, 'page');
        steps.push({ kind: 'nfc', page, count: int(words[i++], 1, 256 - page, 'count') });
      }
    }
    else if (word === 'pause') steps.push({ kind: 'pause', ms: int(words[i++], 0, 600000, 'pause') });
    else if (word === 'label') {
      if (typeof words[i] !== 'string') throw new Error('label needs text');
      steps.push({ kind: 'label', text: words[i++] });
    } else throw new Error(`unknown step ${word}`);
  }
  if (!steps.length) throw new Error('no steps');
  return steps;
}

function snapshotOf(connection, sensor) {
  const read = { imu: 'imuSnapshot', headTouch: 'headTouchSnapshot', ambient: 'ambientSnapshot',
    battery: 'batterySnapshot', motion: 'motionSnapshot' }[sensor];
  return connection[read]?.();
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    out: { type: 'string' }, port: { type: 'string' },
    profile: { type: 'string', default: join(homedir(), '.dsh/profiles/desktop') },
    standby: { type: 'boolean', default: true },
    // Acquire the pairing identity and build the transport, then stop before
    // opening the serial port: nothing is sent to the device.
    dry: { type: 'boolean', default: false },
  } });
  const steps = parseSteps(positionals);
  if (!values.out) throw new Error('--out DIR is required');
  const out = resolve(values.out);
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const file = join(out, 'body-probe.jsonl');
  const started = performance.now();
  const log = (event, fields = {}) => {
    const line = JSON.stringify({ at: new Date().toISOString(), ms: Math.round(performance.now() - started), event, ...fields });
    appendFileSync(file, line + '\n', { mode: 0o600 });
    try { chmodSync(file, 0o600); } catch {}
    console.log(line);
  };
  const port = values.port ?? readdirSync('/dev').map(name => `/dev/${name}`).find(path => usbPortPattern.test(path));
  if (!port || !usbPortPattern.test(port) || !existsSync(port)) throw new Error('No StackChan USB port; pass --port');

  const abort = new AbortController();
  process.once('SIGINT', () => abort.abort());
  const { signal } = abort;
  const pairing = createManagedPairing({ profileDirectory: values.profile, allowDevice: true });
  let identity, usb, transport;
  try {
    log('probe-started', { port, steps });
    identity = await pairing.acquireIdentity(signal);
    transport = createAgentTransport({ pairing: identity.pairing, deviceId: identity.deviceId, recoverInput: true });
    if (values.dry) { log('dry-run-ready', { deviceIdKnown: /^[0-9a-f]{12}$/.test(identity.deviceId) }); return; }
    usb = identity.openUsb(port);
    await usb.ready;
    log('usb-opened');
    if (values.standby) { await waitForUsbReady(usb.stream, signal); log('usb-device-ready'); }
    await transport.attachUsb(usb.stream);
    const connection = transport.connection;
    connection.on?.('disconnect', failure => log('link-closed', { code: failure?.code ?? String(failure), protocolCode: failure?.protocolCode }));
    log('authenticated', { capabilities: connection.negotiatedCapabilities?.() ?? null });
    let t = performance.now();
    await connection.start({ signal });
    log('session-started', { tookMs: Math.round(performance.now() - t) });
    // Microphone frames arrive while the session is active; read them (kept only during a 'mic' step).
    let micTap = null;
    const drain = (async () => {
      let frames = 0;
      try {
        for (;;) {
          const batch = await connection.readInputBatch({ signal });
          frames += batch.frames.length;
          if (micTap) for (const frame of batch.frames) micTap(frame.pcm);
        }
      } catch { return frames; }
    })();
    for (const step of steps) {
      if (signal.aborted) break;
      if (step.kind === 'status') {
        log('status', { imu: snapshotOf(connection, 'imu'), headTouch: snapshotOf(connection, 'headTouch'),
          ambient: snapshotOf(connection, 'ambient'), battery: snapshotOf(connection, 'battery'),
          motion: snapshotOf(connection, 'motion'), camera: connection.cameraSnapshot?.(), ring: connection.ringSnapshot?.() });
      } else if (step.kind === 'move') {
        t = performance.now();
        try {
          const result = await connection.moveHead(step, { signal });
          log('move', { target: step, tookMs: Math.round(performance.now() - t), result });
        } catch (error) {
          log('move-failed', { target: step, tookMs: Math.round(performance.now() - t), code: error?.code ?? String(error) });
        }
      } else if (['frames', 'torque', 'read', 'rotate'].includes(step.kind)) {
        t = performance.now();
        try {
          const result = step.kind === 'frames' ? await connection.moveFrames(step, { signal })
            : step.kind === 'torque' ? await connection.setTorque(step, { signal })
            : step.kind === 'rotate' ? await connection.rotateYaw(step, { signal })
            : await connection.readServos({ signal });
          log(step.kind, { target: step, tookMs: Math.round(performance.now() - t), result });
        } catch (error) {
          log(`${step.kind}-failed`, { target: step, tookMs: Math.round(performance.now() - t), code: error?.code ?? String(error),
            ...(error?.pollStats ? { pollStats: error.pollStats } : {}) });
        }
      } else if (['store', 'storedir', 'show', 'drop', 'bank', 'cycle', 'timeline'].includes(step.kind)) {
        t = performance.now();
        try {
          const store = async (slot, path) => {
            const image = await loadImageRgb565(path);
            const tag = frameTag({ ...image, x: 0, y: 0 });
            const held = await connection.listFrames({ signal });
            if (held.frames.some(f => f.slot === slot && f.tag === tag)) return { status: 'already', slot, tag };
            return connection.storeFrame({ slot, ...image, tag }, { signal });
          };
          let result;
          if (step.kind === 'store') result = await store(step.slot, step.path);
          else if (step.kind === 'storedir') {
            const files = readdirSync(step.path).filter(n => /\.(bmp|png)$/i.test(n)).sort();
            if (step.first + files.length > 48) throw new Error('too many frames for the slots');
            result = [];
            for (const [k, name] of files.entries()) {
              const one = await store(step.first + k, join(step.path, name));
              log('stored', { file: name, ...one });
              result.push({ file: name, slot: one.slot, status: one.status, tookMs: one.tookMs });
            }
          } else if (step.kind === 'show') result = await connection.showFrame(step, { signal });
          else if (step.kind === 'drop') result = await connection.dropFrame(step, { signal });
          else if (step.kind === 'bank') result = await connection.listFrames({ signal });
          else if (step.kind === 'cycle') {
            const up = Array.from({ length: Math.abs(step.to - step.from) + 1 }, (_, k) => step.from + Math.sign(step.to - step.from) * k);
            const order = [];
            for (let r = 0; r < step.rounds; r++) order.push(...(r ? up.slice(1) : up), ...up.slice(0, -1).reverse());
            const points = order.slice(0, 400).map((frame, k) => ({ atMs: k * step.intervalMs, frame }))
              .filter(p => p.atMs <= 20000);
            result = await connection.streamSetpoints({ points }, { signal });
          } else {
            const { points } = JSON.parse(readFileSync(step.path, 'utf8'));
            result = await connection.streamSetpoints({ points }, { signal });
          }
          log(step.kind, { target: step, tookMs: Math.round(performance.now() - t), result });
        } catch (error) {
          log(`${step.kind}-failed`, { target: step, tookMs: Math.round(performance.now() - t), code: error?.code ?? String(error) });
        }
      } else if (['record', 'leds', 'volume', 'tone', 'mic', 'path', 'ir', 'nfc', 'text', 'image', 'clear'].includes(step.kind)) {
        t = performance.now();
        try {
          let result;
          if (step.kind === 'record') result = await connection.recordSensors(step, { signal });
          else if (step.kind === 'text') result = await connection.showText(step, { signal });
          else if (step.kind === 'image') result = await connection.showImage({ ...(await loadImageRgb565(step.path)), durationMs: step.durationMs }, { signal });
          else if (step.kind === 'clear') result = await connection.clearDisplay({ signal });
          else if (step.kind === 'nfc') result = await readType2((page, count) => connection.readNfc({ page, count }, { signal }), step);
          else if (step.kind === 'leds') {
            const leds = Array.from({ length: 12 }, (_, i) => step.leds.includes(i) ? step.color : '#000000');
            result = await connection.setRingFrames({ frames: [{ leds, durationMs: step.durationMs }] }, { signal });
          } else if (step.kind === 'volume') result = await connection.setVolume(step.volume, { signal });
          else if (step.kind === 'tone') {
            const pcm = withSilentTail(tonesToPcm([{ frequencyHz: step.hz, durationMs: step.durationMs, volume: step.volume }]));
            for (let at = 0; at < pcm.length; at += 480) {
              const frame = Buffer.alloc(480); pcm.copy(frame, 0, at, Math.min(at + 480, pcm.length));
              await connection.sendOutput(frame);
            }
            await connection.drainOutput({ signal });
            result = { played: true };
          } else if (step.kind === 'mic') {
            const chunks = [];
            micTap = pcm => chunks.push(Buffer.from(pcm));
            await sleep(step.durationMs, undefined, { signal }).catch(() => {});
            micTap = null;
            const pcm = Buffer.concat(chunks);
            const path = join(out, `mic-${Date.now()}.wav`);
            writeFileSync(path, pcmToWav(pcm), { mode: 0o600 });
            result = { path, bytes: pcm.length, ...levels(pcm) };
          } else if (step.kind === 'path') {
            // A slow side-to-side sine with a small nod, 50 points a second.
            const points = Array.from({ length: step.seconds * 50 }, (_, i) => ({ atMs: i * 20,
              yaw: Math.round(300 * Math.sin(2 * Math.PI * i / 100)), pitch: Math.round(350 + 50 * Math.sin(2 * Math.PI * i / 50)) }));
            result = await connection.streamSetpoints({ points }, { signal });
          } else result = await connection.sendInfrared(step, { signal });
          if (step.kind === 'record') result = { ...result, counts: Object.fromEntries(step.sensors.map(k => [k, result.samples.filter(s => s.sensor === k).length])) };
          log(step.kind, { target: step, tookMs: Math.round(performance.now() - t), result });
        } catch (error) {
          log(`${step.kind}-failed`, { target: step, tookMs: Math.round(performance.now() - t), code: error?.code ?? String(error),
            ...(error?.pollStats ? { pollStats: error.pollStats } : {}) });
        }
      } else if (step.kind === 'ring') {
        t = performance.now();
        try {
          const result = await connection.setRing({ color: step.color, durationMs: step.durationMs }, { signal });
          log('ring', { target: step, tookMs: Math.round(performance.now() - t), result });
        } catch (error) {
          log('ring-failed', { target: step, tookMs: Math.round(performance.now() - t), code: error?.code ?? String(error) });
        }
      } else if (step.kind === 'sample') {
        const count = step.seconds * step.hz;
        for (let i = 0; i < count && !signal.aborted; i++) {
          log('sample', { sensor: step.sensor, value: snapshotOf(connection, step.sensor) });
          await sleep(1000 / step.hz, undefined, { signal }).catch(() => {});
        }
      } else if (step.kind === 'pause') await sleep(step.ms, undefined, { signal }).catch(() => {});
      else if (step.kind === 'label') log('label', { text: step.text });
    }
    t = performance.now();
    await connection.stop({ signal }).catch(error => log('stop-failed', { code: error?.code ?? String(error) }));
    log('session-stopped', { tookMs: Math.round(performance.now() - t), micFrames: await Promise.race([drain, sleep(500).then(() => null)]) });
  } catch (error) {
    log('probe-failed', { code: error?.code ?? error?.message ?? String(error) });
    process.exitCode = 1;
  } finally {
    await Promise.resolve(transport?.close()).catch(() => {});
    await Promise.resolve(usb?.close()).catch(() => {});
    await identity?.release?.().catch(() => {});
    await pairing.dispose().catch(() => {});
    log('probe-ended');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
