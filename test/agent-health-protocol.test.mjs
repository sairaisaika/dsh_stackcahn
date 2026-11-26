import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeControl } from '../src/agent-protocol.mjs';

// The exact strings firmware/agent/agent_session_test.cc asserts the device emits.
const boot = 'b'.repeat(32);
const emitted = [
  '{"type":"health_state","boot_id":"BOOT","epoch":"1","sequence":1,"uptime_ms":40500,"chip_decicelsius":497,"busy_permille":[20,0],"top_task":"esp_","top_permille":9,"gap_ms":[21,40,20],"touch_errors":0,"battery":100,"charging":true,"discharging":false,"brightness":70,"mouth_ticks":12}',
  '{"type":"health_state","boot_id":"BOOT","epoch":"1","sequence":2,"uptime_ms":40500,"chip_decicelsius":null,"busy_permille":[20,null],"top_task":"a?b","top_permille":9,"gap_ms":[21,40,20],"touch_errors":0,"battery":null,"charging":false,"discharging":false,"brightness":null,"mouth_ticks":0}',
];
test('health reports exactly as the firmware writes them pass the Mac protocol check', () => {
  const [first, second] = emitted.map(text => decodeControl(Buffer.from(text.replace('BOOT', boot))));
  assert.equal(first.type, 'health_state');
  assert.deepEqual(first.busy_permille, [20, 0]);
  assert.equal(first.chip_decicelsius, 497);
  assert.equal(second.chip_decicelsius, null);
  assert.equal(second.top_task, 'a?b');
  for (const bad of [{ chip_decicelsius: 12.5 }, { busy_permille: [1001, 0] }, { gap_ms: [1, 2] }, { top_task: 'toolong' }, { extra: 1 }])
    assert.throws(() => decodeControl(Buffer.from(JSON.stringify({ ...first, ...bad }))));
});
