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
//   node scripts/body_probe.mjs --out DIR --steps scripts/sessions/session-a.steps   (one guided session; report: scripts/probe_report.mjs DIR)
//
// Steps for guided sessions: "ask TEXT SECONDS" shows a prompt on the body's screen and records where the
// owner taps (left/middle/right third, and the angle from the centre); "photo" saves one camera JPEG;
// "duplex HZ MS VOLUME AFTER_MS" records both input channels (microphone, echo reference) around a tone;
// "listen TEXT MS" has the Mac say the text aloud while the body records; "bgrecord SENSORS INTERVAL MS"
// records sensors while the following steps run, until "bgwait".
//
// Put the steps after "--" whenever an angle is negative.
// Steps run in the order given on one connection. "pause MS" waits; "label
// TEXT" writes a marker line (for example the pose the owner is holding).
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { spawn } from 'node:child_process';

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
    } else if (word === 'storecrops') {   // storecrops /absolute/dir FIRSTSLOT: crops.json from render_fishtank.py
      const path = words[i++];
      if (!path?.startsWith('/')) throw new Error('storecrops needs an absolute directory');
      steps.push({ kind: 'storecrops', path, first: int(words[i++], 0, 47, 'first slot') });
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
    } else if (word === 'ask') {   // ask WORDS_WITH_UNDERSCORES SECONDS: prompt on the screen, the owner answers with one tap
      const text = String(words[i++] ?? '').replaceAll('_', ' ');
      if (!text) throw new Error('ask needs text');
      steps.push({ kind: 'ask', text, seconds: int(words[i++], 1, 60, 'seconds') });
    } else if (word === 'photo') steps.push({ kind: 'photo' });
    else if (word === 'duplex') {   // duplex HZ MS VOLUME AFTER_MS: record mic + reference while a tone plays
      steps.push({ kind: 'duplex', hz: int(words[i++], 20, 12000, 'hz'), durationMs: int(words[i++], 10, 5000, 'durationMs'),
        volume: int(words[i++], 0, 100, 'volume percent') / 100, afterMs: int(words[i++], 0, 5000, 'afterMs') });
    } else if (word === 'listen') {   // listen WORDS_WITH_UNDERSCORES MS: the Mac says the text aloud while the body records
      const text = String(words[i++] ?? '').replaceAll('_', ' ');
      if (!text) throw new Error('listen needs text');
      steps.push({ kind: 'listen', text, durationMs: int(words[i++], 500, 30000, 'durationMs') });
    } else if (word === 'bgrecord') {   // bgrecord SENSORS INTERVAL_MS DURATION_MS: like record, but the next steps run meanwhile
      const sensors = String(words[i++] ?? '').split(',');
      steps.push({ kind: 'bgrecord', sensors, intervalMs: int(words[i++], 20, 10000, 'intervalMs'), durationMs: int(words[i++], 100, 30000, 'durationMs') });
    } else if (word === 'bgwait') steps.push({ kind: 'bgwait' });
    else throw new Error(`unknown step ${word}`);
  }
  if (!steps.length) throw new Error('no steps');
  return steps;
}

/** Read a session file: one step per line, words split on spaces; '#' followed by a space (or alone)
 * starts a comment, so colours like #ffffff stay steps. Exported for tests. */
export function readStepFile(text, { root } = {}) {
  if (root) text = text.replaceAll('${ROOT}', root);
  return text.split('\n').map(line => line.replace(/(^|\s)#(\s.*)?$/, '').trim()).filter(Boolean).flatMap(line => line.split(/\s+/));
}

/** Where a tap sits on the 320×240 screen: thirds for answers, a compass angle from the centre for
 * "tap toward the light" (0° = right, 90° = down, as screen coordinates go). Exported for tests. */
export function tapZone(x, y) {
  const zone = x < 107 ? 'left' : x < 214 ? 'middle' : 'right';
  const angleDeg = Math.round((Math.atan2(y - 120, x - 160) * 180 / Math.PI + 360) % 360);
  return { zone, angleDeg };
}

/** 20 ms RMS windows per channel of interleaved stereo PCM16. Exported for tests. */
export function envelope(pcm, { rate = 24000, channels = 2, windowMs = 20 } = {}) {
  const per = Math.round(rate * windowMs / 1000), frames = Math.floor(pcm.length / (2 * channels));
  const out = Array.from({ length: channels }, () => []);
  for (let start = 0; start < frames; start += per) {
    const end = Math.min(frames, start + per);
    for (let c = 0; c < channels; c++) {
      let sum = 0;
      for (let f = start; f < end; f++) { const v = pcm.readInt16LE((f * channels + c) * 2) / 32768; sum += v * v; }
      out[c].push(Math.round(Math.sqrt(sum / (end - start)) * 10000) / 10000);
    }
  }
  return out;
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
    // A session file (see scripts/sessions/): its steps run before any given on the command line.
    steps: { type: 'string' },
    // The Mac voice for 'listen' steps.
    voice: { type: 'string', default: 'Eddy (Chinese (China mainland))' },
  } });
  const steps = parseSteps([...(values.steps ? readStepFile(readFileSync(values.steps, 'utf8'), { root: resolve(dirname(fileURLToPath(import.meta.url)), '..') }) : []), ...positionals]);
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
    let micTap = null, background = null;
    const playTone = async step => {
      const pcm = withSilentTail(tonesToPcm([{ frequencyHz: step.hz, durationMs: step.durationMs, volume: step.volume }]));
      for (let at = 0; at < pcm.length; at += 480) {
        const frame = Buffer.alloc(480); pcm.copy(frame, 0, at, Math.min(at + 480, pcm.length));
        await connection.sendOutput(frame);
      }
      await connection.drainOutput({ signal });
    };
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
      } else if (['store', 'storedir', 'storecrops', 'show', 'drop', 'bank', 'cycle', 'timeline'].includes(step.kind)) {
        t = performance.now();
        try {
          const store = async (slot, path, x = 0, y = 0) => {
            const image = await loadImageRgb565(path, { maxWidth: 320 - x, maxHeight: 240 - y });
            const tag = frameTag({ ...image, x, y });
            const held = await connection.listFrames({ signal });
            if (held.frames.some(f => f.slot === slot && f.tag === tag)) return { status: 'already', slot, tag };
            return connection.storeFrame({ slot, ...image, x, y, tag }, { signal });
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
          } else if (step.kind === 'storecrops') {
            const manifest = JSON.parse(readFileSync(join(step.path, 'crops.json'), 'utf8'));
            if (step.first + 1 + manifest.frames.length > 48) throw new Error('too many frames for the slots');
            result = [{ file: manifest.background, ...(await store(step.first, join(step.path, manifest.background))) }];
            for (const [k, name] of manifest.frames.entries()) {
              const one = await store(step.first + 1 + k, join(step.path, name), manifest.x, manifest.y);
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
            await playTone(step);
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
      } else if (['ask', 'photo', 'duplex', 'listen', 'bgrecord', 'bgwait'].includes(step.kind)) {
        t = performance.now();
        try {
          if (step.kind === 'ask') {
            // The owner reads the prompt on the body itself and answers with one tap; the tap's place is the answer.
            console.error(`\n>>> 屏幕提问：${step.text}（${step.seconds} 秒内点一下屏幕）\n`);
            await connection.showText({ text: step.text, area: 'full', durationMs: step.seconds * 1000 }, { signal });
            const local = new AbortController();
            const stopLocal = () => local.abort();
            signal.addEventListener('abort', stopLocal, { once: true });
            const recording = connection.recordSensors({ sensors: ['screenTouch'], intervalMs: 100, durationMs: step.seconds * 1000 },
              { signal: local.signal }).catch(() => null);
            let tap = null;
            const begun = performance.now();
            while (!signal.aborted && performance.now() - begun < step.seconds * 1000 + 200) {
              tap = connection.recording?.samples?.find(s => s.sensor === 'screenTouch' && s.value?.phase === 'down') ?? null;
              if (tap || (!connection.recording && performance.now() - begun > 300)) break;
              await sleep(30, undefined, { signal }).catch(() => {});
            }
            local.abort();
            await recording;
            signal.removeEventListener('abort', stopLocal);
            await connection.clearDisplay({ signal }).catch(() => {});
            log('ask', { text: step.text, seconds: step.seconds, answered: !!tap, afterMs: tap?.t ?? null,
              ...(tap ? { x: tap.value.x, y: tap.value.y, ...tapZone(tap.value.x, tap.value.y) } : {}) });
          } else if (step.kind === 'photo') {
            const photo = await connection.captureCamera({ signal });
            const path = join(out, `photo-${Date.now()}.jpg`);
            writeFileSync(path, photo.jpeg, { mode: 0o600 });
            log('photo', { tookMs: Math.round(performance.now() - t), path, width: photo.width, height: photo.height, bytes: photo.jpeg.length });
          } else if (step.kind === 'duplex') {
            // Both input channels (microphone and the codec's echo reference) around one tone: shows what the
            // speaker really played, how much of it the microphone hears, and anything played after the end.
            const chunks = [];
            const bytes = () => chunks.reduce((n, c) => n + c.length, 0);
            micTap = pcm => chunks.push(Buffer.from(pcm));
            await sleep(300, undefined, { signal }).catch(() => {});
            const toneAt = bytes();
            await playTone(step);
            const drainedAt = bytes();
            await sleep(step.afterMs, undefined, { signal }).catch(() => {});
            micTap = null;
            const pcm = Buffer.concat(chunks);
            const path = join(out, `duplex-${step.hz}hz-v${Math.round(step.volume * 100)}-${Date.now()}.wav`);
            writeFileSync(path, pcmToWav(pcm), { mode: 0o600 });
            const windowBytes = 24000 * 0.02 * 2 * 2;
            log('duplex', { target: step, tookMs: Math.round(performance.now() - t), path, windowMs: 20,
              toneStartWindow: Math.floor(toneAt / windowBytes), drainedWindow: Math.floor(drainedAt / windowBytes),
              toneWindows: Math.round(step.durationMs / 20), ...levels(pcm), envelope: envelope(pcm) });
          } else if (step.kind === 'listen') {
            // The Mac speaks a known sentence; the body's microphone records it, for recognition checks later.
            const chunks = [];
            micTap = pcm => chunks.push(Buffer.from(pcm));
            await sleep(300, undefined, { signal }).catch(() => {});
            const speaker = spawn('say', ['-v', values.voice, step.text], { stdio: 'ignore' });
            const spoken = new Promise(done => speaker.once('exit', code => done(code)));
            await sleep(step.durationMs, undefined, { signal }).catch(() => {});
            const sayExit = await Promise.race([spoken, sleep(100).then(() => { speaker.kill(); return 'killed'; })]);
            micTap = null;
            const pcm = Buffer.concat(chunks);
            const path = join(out, `listen-${Date.now()}.wav`);
            writeFileSync(path, pcmToWav(pcm), { mode: 0o600 });
            log('listen', { target: step, tookMs: Math.round(performance.now() - t), path, voice: values.voice, sayExit, ...levels(pcm) });
          } else if (step.kind === 'bgrecord') {
            if (background) throw new Error('one background recording at a time');
            background = connection.recordSensors(step, { signal }).then(
              result => log('bgrecord', { target: step, result: { ...result,
                counts: Object.fromEntries(step.sensors.map(k => [k, result.samples.filter(s => s.sensor === k).length])) } }),
              error => log('bgrecord-failed', { target: step, code: error?.code ?? String(error), missing: error?.missing }));
            log('bgrecord-started', { target: step });
          } else {
            await background;
            background = null;
            log('bgwait', { tookMs: Math.round(performance.now() - t) });
          }
        } catch (error) {
          log(`${step.kind}-failed`, { target: step, tookMs: Math.round(performance.now() - t), code: error?.code ?? String(error),
            ...(step.kind === 'photo' ? { camera: connection.cameraSnapshot?.() } : {}) });
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
    if (background) await background;
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
