import { VoiceBridge } from './bridge.mjs';
import { createDshSessionAdapter } from './dsh-session.mjs';
import { factoryMcpVoice } from './factory-voice.mjs';

/** Composition seam for a DSH Host plugin; does not install itself or mutate Host configuration. */
export function createHostBridge(ctx, { voice = factoryMcpVoice, ...options } = {}) {
  return new VoiceBridge({
    ...options,
    voice,
    dsh: createDshSessionAdapter({
      controller: ctx.get('sessionController'),
      getAgent: id => ctx.get('agents')?.get(id),
    }),
  });
}

/** Independent device application. Stop releases resources; Home is a separate
 * device action. The original cloud assistant is never claimed ready here. */
export function createHostAgent(ctx, { voice, ...options } = {}) {
  if (!voice) throw new TypeError('An independent device voice adapter is required');
  return createHostBridge(ctx, { ...options, voice, exitTarget: 'device-idle' });
}
