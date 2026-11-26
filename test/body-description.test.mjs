import test from 'node:test';
import assert from 'node:assert/strict';
import { describeBody } from '../src/body-description.mjs';
import { MOTION } from '../src/agent-protocol.mjs';

test('the body description follows the negotiated firmware and the shared limits', () => {
  const full = describeBody({ motion: 2, imu: 1, headTouch: 2, ring: 1, ringFrames: 1, infrared: 1, nfc: 1, screenTouch: 1, power: 1 });
  assert.equal(full.parts.head.available, true);
  assert.equal(full.parts.head.joints.head_pitch.command.max, MOTION.pitchMax);
  assert.equal(full.parts.head.joints.head_yaw.continuousRotation, true);
  assert.match(full.parts.head.joints.head_yaw.positive, /own right/);
  assert.equal(full.parts.lightRing.perLed, true);
  assert.equal(full.parts.infrared.send.includes('owner-allowed'), true);
  assert.equal(full.parts.nfc.chip, 'ST25R3916');
  const old = describeBody({ motion: 1 });
  assert.equal(old.parts.head.joints.head_yaw.continuousRotation, false);
  assert.deepEqual(old.parts.infrared, { available: false });
  assert.deepEqual(old.parts.nfc, { available: false });
  assert.equal(old.parts.imu.available, false);
  assert.doesNotThrow(() => JSON.stringify(full));
});
