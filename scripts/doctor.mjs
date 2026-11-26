import { factoryMcpVoice } from '../src/factory-voice.mjs';
import { requiredVoiceCapabilities } from '../src/bridge.mjs';
console.log(JSON.stringify({
  mode: factoryMcpVoice.mode,
  ready: false,
  missing: requiredVoiceCapabilities.filter(k => !factoryMcpVoice.capabilities[k]),
  evidence: factoryMcpVoice.evidence,
  action: 'Use an approved local or factory voice adapter with a verified return path to the original assistant.',
}, null, 2));
process.exitCode = 2;
