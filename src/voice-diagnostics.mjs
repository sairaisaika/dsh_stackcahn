import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { performance } from 'node:perf_hooks';

const reportIntervalMs = 5000;
const clockIntervalMs = 50;
const fileBudget = 512 * 1024;
// Older files kept after rotation: voice.previous.jsonl, then .2 to .4 (about a few days of a
// linked body), so a fault after many hours still has its lead-up on disk.
const keptFiles = 4;
const logQueueBudget = 32;
const maxima = ['usbReadBytesMax', 'usbReadGapMsMax', 'inputGapMsMax', 'queueDepthMax',
  'queueWaitMsMax', 'frontendMsMax', 'clockDelayMsMax'];
const windowStats = () => ({
  usbReads: 0, usbBytes: 0, inputFrames: 0, inputReads: 0, droppedByAge: 0, droppedByCapacity: 0, droppedByDevice: 0,
  frontendCalls: 0, frontendFrames: 0, frontendMsTotal: 0, frontendPendingFrames: 0,
  clockTicks: 0, clockDelayMsMax: 0,
});

/** Keep the latest few private files across a DSH restart. Do no I/O until
 * the first service event. A slow or unavailable disk cannot block capture. */
export function createVoiceDiagnosticStore(profileDirectory, onUnavailable) {
  if (typeof profileDirectory !== 'string' || !isAbsolute(profileDirectory)) return;
  const directory = join(profileDirectory, '.stackchan-diagnostics');
  const current = join(directory, 'voice.jsonl');
  let pending = 0, skipped = 0, disabled = false, prepared = false, tail = Promise.resolve();
  const privateEntry = stat => stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0;
  const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  async function append(line) {
    if (!prepared) {
      await mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
      const stat = await lstat(directory);
      if (!stat.isDirectory() || !privateEntry(stat)) throw new Error('voice-diagnostic-directory');
      prepared = true;
    }
    async function write() {
      const file = await open(current, flags, 0o600);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.nlink !== 1 || !privateEntry(stat)) throw new Error('voice-diagnostic-file');
        if (stat.size + Buffer.byteLength(line) > fileBudget) return false;
        await file.writeFile(line);
        return true;
      } finally { await file.close(); }
    }
    if (await write()) return;
    const older = n => join(directory, n === 1 ? 'voice.previous.jsonl' : `voice.previous.${n}.jsonl`);
    for (let n = keptFiles - 1; n >= 1; n--)
      await rename(older(n), older(n + 1)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await rename(current, older(1));
    if (!await write()) throw new Error('voice-diagnostic-rotation');
  }
  return {
    write(sample) {
      if (disabled) return;
      if (pending >= logQueueBudget) { skipped++; return; }
      const line = JSON.stringify({ at: new Date().toISOString(), ...sample,
        ...(skipped ? { skippedLogs: skipped } : {}) }) + '\n';
      skipped = 0;
      pending++;
      tail = tail.then(() => disabled ? undefined : append(line)).catch(() => {
        disabled = true;
        try { onUnavailable(); } catch {}
      }).finally(() => { pending--; });
    },
    flush: () => tail,
  };
}

/** Local operational logs. Only clocks, bounded counters and fixed stage names
 * cross this sink. There is no PCM or reference to durable device/session IDs. */
export function createVoiceDiagnostics(transport, sink) {
  const run = randomUUID();
  const startedAt = performance.now();
  let metrics, timer, lastTick, windowAt, lastUsb, lastFrame, frontendStartedAt, capture = 0, gapLogged;
  const emit = (event, fields = {}) => {
    try {
      sink({ version: 1, transport, run, capture, event,
        elapsedMs: Math.round(performance.now() - startedAt), ...fields });
    } catch {} // A logging failure must not affect the voice path.
  };
  function maximum(name, value) {
    metrics[name] = Math.max(metrics[name] ?? 0, value);
  }
  function publish(event, now, fields) {
    const count = metrics.frontendCalls;
    const rounded = Object.fromEntries(maxima.map(name => [name, Math.round(metrics[name] ?? 0)]));
    const { frontendMsTotal, ...counts } = metrics;
    emit(event, { windowMs: Math.round(now - windowAt),
      ...counts, ...rounded, ...(count ? { frontendMsMean: Math.round(frontendMsTotal / count) } : {}),
      ...(frontendStartedAt === undefined ? {} : { frontendPendingMs: Math.round(now - frontendStartedAt) }),
      ...fields });
    const { frontendPendingFrames } = metrics;
    metrics = { ...windowStats(), frontendPendingFrames };
    windowAt = now;
  }
  function endCapture(outcome) {
    if (!metrics) return;
    clearInterval(timer);
    publish('capture-ended', performance.now(), { outcome });
    metrics = undefined;
  }
  return {
    stage: emit,
    startCapture() {
      const now = performance.now();
      metrics = windowStats();
      windowAt = lastTick = now;
      lastUsb = lastFrame = frontendStartedAt = undefined;
      gapLogged = false;
      capture++;
      emit('capture-started');
      timer = setInterval(() => {
        const now = performance.now();
        maximum('clockDelayMsMax', now - lastTick - clockIntervalMs);
        metrics.clockTicks++;
        lastTick = now;
        if (now - windowAt >= reportIntervalMs) publish('capture-window', now);
      }, clockIntervalMs);
      timer.unref();
    },
    endCapture,
    closeLink(outcome) {
      endCapture('link-ended');
      emit('link-ended', { outcome });
    },
    usbRead(bytes) {
      if (!metrics) return;
      const now = performance.now();
      metrics.usbReads++;
      metrics.usbBytes += bytes;
      maximum('usbReadBytesMax', bytes);
      if (lastUsb !== undefined) maximum('usbReadGapMsMax', now - lastUsb);
      lastUsb = now;
    },
    inputFrame(at, depth) {
      if (!metrics) return;
      metrics.inputFrames++;
      if (lastFrame !== undefined) maximum('inputGapMsMax', at - lastFrame);
      lastFrame = at;
      maximum('queueDepthMax', depth);
    },
    inputRead(waitMs) {
      if (!metrics) return;
      metrics.inputReads++;
      maximum('queueWaitMsMax', waitMs);
    },
    inputGap(count, cause) {
      if (!metrics) return;
      if (cause === 'device') metrics.droppedByDevice += count;
      else metrics.droppedByCapacity += count;
      if (!gapLogged) {
        gapLogged = true;
        emit('first-input-gap', { cause, droppedFrames: count, queueDepthMax: metrics.queueDepthMax ?? 0 });
      }
    },
    frontendStart(frames) {
      if (metrics) {
        metrics.frontendPendingFrames = frames;
        frontendStartedAt = performance.now();
      }
    },
    frontendDone(frames, durationMs) {
      if (!metrics) return;
      frontendStartedAt = undefined;
      metrics.frontendPendingFrames = 0;
      metrics.frontendCalls++;
      metrics.frontendFrames += frames;
      metrics.frontendMsTotal += durationMs;
      maximum('frontendMsMax', durationMs);
    },
  };
}
