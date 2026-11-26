/** Evidence-based capability report; this is NOT a fabricated device driver. */
export const factoryMcpVoice = Object.freeze({
  mode: 'factory-mcp-unavailable',
  capabilities: Object.freeze({
    continuousTranscripts: false,
    speakText: false,
    interruptPlayback: false,
    restoreOriginal: false,
    preservesOriginalAssistant: true,
  }),
  evidence: {
    toolResultSpeech: 'Existing cloud assistant can speak MCP tool results; exact rendering is cloud-controlled.',
    missing: 'No verified original-cloud transcript subscription, direct TTS, routing lease, or restore acknowledgment.',
    source: 'm5stack/StackChan@28b9f0c8bd6acd81cb3c70f1a93c3e373b39d400',
  },
  async acquire() { throw new Error('Factory continuous voice handoff is not available through the current MCP endpoint'); },
});
