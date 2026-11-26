import { VoiceBridge, requiredVoiceCapabilities } from '../src/bridge.mjs';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
// All I/O is simulated. This never records audio or calls a model/device.
const voice = {
  mode: 'simulation', capabilities: Object.fromEntries(requiredVoiceCapabilities.map(k => [k, true])),
  async acquire() {
    return {
      async speak(text) { console.log(`模拟播报: ${text}`); },
      async interrupt() { console.log('模拟停止播放'); },
      async release() { console.log('模拟原助手确认恢复'); return { originalReady: true }; },
    };
  },
};
const bridge = new VoiceBridge({ voice, dsh: { async bind(sessionId) { return { async ask(text) { return `[模拟 DSH ${sessionId}] ${text}`; } }; } } });
console.log('状态机演示：不连接机器人、不调用真实 DSH、不使用麦克风。输入“停止”退出转接。');
await bridge.enter('simulation-session');
const rl = createInterface({ input: stdin, output: stdout });
let id = 0;
for await (const text of rl) {
  console.log(await bridge.receive({ id: String(++id), text, final: true }));
  if (bridge.status().state === 'original') break;
}
await bridge.stop(); rl.close();
