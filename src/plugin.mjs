import { createVoiceRuntime } from './voice-runtime.mjs';
import { registerCapabilityTools } from './capability-tools.mjs';
import { registerBodySkill } from './body-skill.mjs';
import z from '@deepseek-ai/schemastery';
import { createManagedPairing } from './managed-pairing.mjs';
import { PairingRemote, VoiceRemote } from '../lib/remote-api.js';
import { usbPortPattern } from './usb-port.mjs';
import { createVoiceDiagnosticStore } from './voice-diagnostics.mjs';
import { createAutoStandby } from './auto-standby.mjs';
export * from './bridge.mjs';

export const name = 'stackchan';
export const ENTRY_ID = 'stackchan';
export const Config = z.object({
  // Host installation settings, intentionally not volatile/Client-editable.
  pairing: z.object({
    directory: z.string().max(4096).default(''),
    python: z.string().max(4096).default('python3'),
    // Missing uses one-request managed USB. Explicit true/false is an install policy.
    deviceAccess: z.boolean(),
  }).default({}),
  voice: z.object({
    python: z.string().max(4096).default(''),
    audioDirectory: z.string().max(4096).default(''),
    assetsDirectory: z.string().max(4096).default(''),
    whisperBinary: z.string().max(4096).default(''),
    temporaryDirectory: z.string().max(4096).default(''),
    logLatency: z.boolean().default(false),
  }).default({}),
  preferences: z.object({
    sessionId: z.string().max(256).default(''),
    transport: z.union(['lan', 'usb', 'relay']).default('lan'),
    usbPort: z.union(['', z.string().pattern(usbPortPattern)]).default(''),
    language: z.union(['auto', 'zh', 'en']).default('auto'),
    asrBackend: z.union(['unconfigured', 'whisper.cpp']).default('unconfigured'),
    ttsBackend: z.union(['unconfigured', 'kokoro']).default('unconfigured'),
    voice: z.string().max(128).default(''),
    speechRate: z.number().min(0.5).max(2).default(1),
    measureLatency: z.boolean().default(false),
    captionOnly: z.boolean().default(false),
    // Opt-in: start the voice service and wait for Sion whenever DSH starts.
    autoStandby: z.boolean().default(false),
    // Owner voice: who may wake a waiting device, or be listened to at all.
    ownerOnly: z.union(['off', 'wake', 'always']).default('off'),
    // Body events (touch, pickup, battery…) told to DSH: same kind at most once per
    // cooldown, all kinds at most eventsPerHour. 0 seconds turns event telling off.
    eventCooldownSec: z.natural().max(3600).default(30),
    eventsPerHour: z.natural().max(120).default(12),
    // Head-touch facts (channel, direction, strength, duration) for DSH: 'context'
    // hands them over with the next thing said, 'turn' tells her at once within
    // the budget above, 'off' leaves them in stackchan_device_status only.
    bodyFacts: z.union(['off', 'context', 'turn']).default('context'),
    // Sending infrared reaches other devices in the room; off until the owner allows it.
    infraredSend: z.boolean().default(false),
    // Read aloud replies in the voice session that came from elsewhere (desktop, Telegram, tasks).
    speakSessionReplies: z.boolean().default(false),
    // Names the device answers to. Plain text, [abc] for any one character,
    // (ab|cd) for alternative spellings. Personal names belong in local config.
    wakeNames: z.array(z.string().min(1).max(200)).max(32).default(['stackchan','stack chan']),
    // Optional clean-up of what the recognizer heard, before the conversation sees it.
    transcriptSimplify: z.boolean().default(false),
    transcriptReplacements: z.array(z.object({ from: z.string().min(1).max(100), to: z.string().max(100) })).max(64).default([]),
  }).default({}).volatile(),
});

/** Host service for accepted preferences. No listener, prompt, or audio starts
 * on installation. Settings owns persistence and conflict detection. */
export function apply(ctx, config) {
  const lifetime = new AbortController();
  const pairing = createManagedPairing({
    profileDirectory: ctx.get('profileContext')?.dir,
    directory: config.pairing.directory, python: config.pairing.python, allowDevice: config.pairing.deviceAccess,
  });
  ctx.provide('stackchanPairing', pairing);
  new PairingRemote(ctx);
  const latencyLogger = config.voice.logLatency ? ctx.logger('stackchan-latency') : null;
  const voiceLogger = ctx.logger('stackchan-voice');
  const diagnosticStore = createVoiceDiagnosticStore(ctx.get('profileContext')?.dir,
    () => voiceLogger.warn('STACKCHAN_VOICE_TRACE_STORAGE_UNAVAILABLE'));
  const runtime = createVoiceRuntime({ ctx, pairing,
    profileDirectory: ctx.get('profileContext')?.dir,
    // autoStandby only steers the supervisor below; toggling it never needs a service restart.
    getPreferences: () => { const { autoStandby: _auto, ...voice } = config.preferences.get(); return voice; },
    installation: config.voice,
    onVoiceFault: sample => voiceLogger.warn('STACKCHAN_VOICE_FAULT %s', JSON.stringify(sample)),
    onVoiceDiagnostic: sample => {
      diagnosticStore?.write(sample);
      voiceLogger.info('STACKCHAN_VOICE_TRACE %s', JSON.stringify(sample));
    },
    onLatency: latencyLogger ? (sample, transport) => {
      const durations = Object.fromEntries(Object.entries(sample)
        .filter(([, value]) => Number.isFinite(value) && value >= 0)
        .map(([name, value]) => [name, Math.round(value)]));
      latencyLogger.info('STACKCHAN_VOICE_LATENCY %s', JSON.stringify({ version: 1, transport, ...durations }));
    } : undefined,
  });
  const autoStandby = createAutoStandby({ runtime, getPreferences: () => config.preferences.get(),
    onState: sample => voiceLogger.info('STACKCHAN_VOICE_AUTO %s', JSON.stringify(sample)) });
  ctx.provide('stackchanVoice', autoStandby.wrap(runtime));
  new VoiceRemote(ctx);
  ctx.inject(['tools'],child=>{registerCapabilityTools(child,runtime);});
  ctx.inject(['skills'],child=>{registerBodySkill(child);});
  ctx.effect(() => async () => {
    try { await autoStandby.dispose(); await runtime.dispose(); }
    finally { await Promise.all([pairing.dispose(), diagnosticStore?.flush()]); }
  });
  // The session controller must exist before a saved session can be bound.
  ctx.inject(['sessionController'], () => { autoStandby.start(); });
  const service = {
    snapshot() {
      lifetime.signal.throwIfAborted();
      const state = runtime.snapshot();
      return { preferences: structuredClone(config.preferences.get()), applied: state.applied,
        runtime: state, unavailable: state.applied ? ['wake'] : ['voice-not-active', 'wake'] };
    },
    async checkSession(signal) {
      const combined = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
      combined.throwIfAborted();
      const { sessionId } = config.preferences.get();
      if (!sessionId) return { status: 'unselected' };
      const controller = ctx.get('sessionController');
      if (!controller?.projections) return { status: 'unavailable' };
      const snapshot = await controller.projections({ sessionId }, combined);
      combined.throwIfAborted();
      if (config.preferences.get().sessionId !== sessionId) return { status: 'superseded' };
      if (!snapshot) return { status: 'missing' };
      return { status: snapshot.kind === 'sequenced' ? 'valid' : 'migration-required' };
    },
  };
  ctx.provide('stackchanSettings', service);
  ctx.effect(() => () => lifetime.abort());
  ctx.inject(['settings'], child => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber));
  });
}
