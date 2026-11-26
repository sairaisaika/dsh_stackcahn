// What the body is made of: parts, what each can be asked to do, units, ranges,
// directions and facts measured on the real device. Facts only; what any of it
// means is for DSH to decide. Kept in one place so tools and status agree.
import { MOTION, SENSOR_REPORTS } from './agent-protocol.mjs';

const measured = (value, source) => ({ value, source });

export function describeBody(versions = {}) {
  const has = key => Number(versions?.[key] ?? 0) > 0;
  return {
    version: 1,
    units: { angle: 'tenths of a degree, servo frame', time: 'milliseconds' },
    parts: {
      head: {
        available: has('motion'),
        joints: {
          head_yaw: {
            command: { min: MOTION.yawMin, max: MOTION.yawMax },
            positive: "turns to the robot's own right (the viewer's left when facing her; clockwise seen from above)",
            directionSource: 'v71 video (v68-v70 owner answers were from the viewer\'s side)',
            mechanical: 'no end stop; turns all the way round',
            sensorWindow: measured({ min: -1437, max: 1687, blindDegrees: 47 }, 'v69 hand sweep'),
            continuousRotation: has('motion') && versions.motion >= 2,
          },
          head_pitch: {
            command: { min: MOTION.pitchMin, max: MOTION.pitchMax },
            positive: 'larger is head up',
            mechanicalStops: measured({ min: -125, max: 740 }, 'v69 hand sweep'),
            servoVsWorld: measured('servo 30 deg had the face about 40 deg up; servo 70 deg was about 87 deg from the ground',
              'v68 IMU and owner'),
          },
        },
        reference: 'the factory zero (Setup > servo home) is angle 0 on both joints; on Sion it is the factory default, so pitch 0 is near the bottom',
        ownerFacing: measured({ yaw: 0, pitch: 335 }, "owner's desk, v69"),
        accuracy: measured('about 1 degree', 'v68'),
        callOverheadMs: measured(1100, 'v68: power-up and release per call; keyframes, holds and setpoints avoid it'),
        protections: ['pitch range above', 'stall: no progress past the frame time, or current/load high or rising (stock rules)',
          'holds end after at most 60 s', 'Stop, disconnect and the Motion switch release at once'],
        permission: 'Motion switch on the device',
        tools: ['stackchan_servo_move', 'stackchan_servo_stream', 'stackchan_servo_rotate', 'stackchan_servo_torque',
          'stackchan_servo_read', 'stackchan_move_head'],
      },
      imu: {
        available: has('imu'),
        location: 'in the head; moves with pitch and yaw',
        axes: measured({ z: 'out of the face', y: 'toward the top of the screen', x: "the robot's own left" }, 'v68 poses, v71 tilt on video'),
        ranges: { accelerationG: 2, angularVelocityDps: 2000 },
        fastestMs: SENSOR_REPORTS.imu.minMs,
        magnetometer: 'BMM150 raw counts (it answered on Sion, v71); axes, offsets and scale not yet calibrated',
        tools: ['stackchan_sensor_record (imu)', 'stackchan_device_status'],
      },
      headTouch: {
        available: has('headTouch'),
        channels: 3, levels: '0..3 each', fastestMs: SENSOR_REPORTS.headTouch.minMs,
        notes: measured('channels 1-2 are toward the face (a press there reads on both), channel 3 toward the back; several channels can read at once',
          'v71: owner pressed the front twice and the back once; the log shows two presses on 1-2 and one on 3'),
        tools: ['stackchan_sensor_record (headTouch)', 'body facts in the voice session'],
      },
      screen: {
        size: { width: 320, height: 240 },
        touch: has('screenTouch') ? 'down/move/up events with x, y' : 'not reported by this firmware',
        face: 'six expressions on the face page (stackchan_set_expression)',
        overlay: !has('display') ? 'not supported by this firmware'
          : versions.display >= 2 ? 'text and pictures over the face (stackchan_show_text, stackchan_show_image, stackchan_clear_display)'
          : 'text over the face (stackchan_show_text, stackchan_clear_display); pictures need newer firmware',
        overlayMeasured: measured('text at top and full screen, Chinese and English readable, face returns after the time', 'v72 owner'),
        frameBank: !has('frames') ? 'not supported by this firmware'
          : 'pictures stored ahead in slots 0-47 (4 MiB, about 27 full screens; kept through Stop and reconnects, gone after a restart) and shown by number: stackchan_frame_store, stackchan_frame_show, stackchan_frame_list, stackchan_frame_drop; frame points in stackchan_servo_stream switch them in step with the head',
        frameBankMeasured: has('frames') ? measured('a full-screen frame takes about 1.7 s to store; a switch about 30 ms round trip; full-screen frames up to about 30 per second with frames 2 (v76; 10 per second with frames 1); smoothness comes from small angle steps, not frame rate alone; a head sweep with frames on one timeline stayed in step; frames survive a reconnect', 'v75-v76 owner') : undefined,
      },
      lightRing: {
        available: has('ring'), leds: 12, layout: "0-5 on the strip on the robot's own right side, 6-11 on its left side; 6 sits above 11; the order within 0-5 is not yet mapped",
        layoutSource: 'v71 video',
        perLed: has('ringFrames'), tools: ['stackchan_light_frames', 'stackchan_light_ring'], permission: 'Light ring switch on the device',
      },
      power: {
        battery: has('battery') ? 'percent and charging direction' : 'not reported',
        monitor: has('power') ? 'INA226: bus voltage and current (sign for charging not yet confirmed)' : 'not reported',
      },
      ambient: { available: has('ambient'), light: 'two raw channels', proximity: 'raw' },
      sound: {
        speaker: 'speech and sounds (stackchan_say, stackchan_play_sound); volume 0..100 (stackchan_set_volume)',
        microphones: '2; raw recording to a private WAV (stackchan_record_audio)',
      },
      infrared: has('infrared')
        ? { send: 'NEC, owner-allowed only (stackchan_ir_send)', receive: 'NEC codes as events (stackchan_sensor_record infrared)' }
        : { available: false },
      nfc: has('nfc')
        ? { chip: 'ST25R3916', read: 'ISO14443A card arriving or leaving, with UID, ATQA, SAK and (Type 2 tags) GET_VERSION, as events (stackchan_sensor_record nfc)',
          memory: 'Type 2 tag pages and the decoded NDEF message (stackchan_nfc_read); read-only, the device can only send READ',
          polling: 'about every 250 ms, RF field on only for each poll and only while a conversation is active',
          location: measured('top of the head, where the touch pads are', 'v73 owner'),
          measuredCard: measured('owner card NTAG215 (GET_VERSION 0004040201001103) lying flat on the head top: 51 of 51 polls selected it; NDEF is one URI record https://www.m5stack.com',
            'v74 driver log'),
          notSupported: 'writing, card emulation, MIFARE Classic sectors and other card types (B, F, V)' }
        : { available: false },
      camera: { available: has('camera'), size: { width: 640, height: 480 }, tools: ['stackchan_take_photo'] },
    },
  };
}
