import { z } from 'zod';

export const MAX_U64 = (1n << 64n) - 1n;
export const AUDIO = Object.freeze({ rate: 24000, samples: 240, inputChannels: 2, outputChannels: 1,
  inputQueueFrames: 32, outputWindowFrames: 20, headerBytes: 32, maxMessageBytes: 2048 });
const hex = length => z.string().regex(new RegExp(`^[0-9a-f]{${length}}$`));
const u64 = z.string().max(20).regex(/^(0|[1-9][0-9]*)$/).refine(v => BigInt(v) <= MAX_U64);
const identity = { boot_id: hex(32), epoch: u64 };
const response = { ...identity, request_id: hex(32) };
export const EXPRESSIONS = Object.freeze(['neutral','happy','angry','sad','doubt','sleepy']);
export const CAPTION_BYTES = 896;
export const CAMERA = Object.freeze({maxBytes:256*1024,chunkBytes:1024,width:640,height:480,timeoutMs:30000,statusFreshMs:6000});
// pitchMax 650: on Sion (v68) servo pitch ~65 degrees already presses the head
// against the body; this is damage protection, not a behaviour rule.
export const MOTION = Object.freeze({ yawMin: -1280, yawMax: 1280, pitchMin: 50, pitchMax: 650,
  durationMin: 100, durationMax: 3000, timeoutMs: 20000, statusFreshMs: 6000,
  framesMax: 8, holdMaxMs: 60000, frameGraceMs: 3000, rotateVelocityMax: 1000, rotateMinMs: 100, rotateMaxMs: 20000 });
// Sensor recording: fastest report interval each sensor allows, and the default the
// device returns to for every new session.
export const SENSOR_REPORTS = Object.freeze({
  imu:{wire:'imu',minMs:20,defaultMs:250}, headTouch:{wire:'head_touch',minMs:50,defaultMs:200},
  ambient:{wire:'ambient',minMs:750,defaultMs:2000}, battery:{wire:'battery',minMs:1000,defaultMs:2000},
  power:{wire:'power',minMs:100,defaultMs:2000},
});
export const RECORDING = Object.freeze({maxDurationMs:30000,maxSamples:3000});
export const RING = Object.freeze({durationMin:250,durationMax:10000,timeoutMs:15000,statusFreshMs:6000});
export const isRingColor = value => typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value);
const ringErrors = ['open','write','release-unconfirmed'];
const motionErrors = ['open','command','feedback','stall','timeout','release-unconfirmed','torque','sense','rotate'];
const servoAxis = z.strictObject({angle:z.number().int().min(-3600).max(3600),position:z.number().int().min(0).max(1023),
  speed:z.number().int().min(-32767).max(32767),load:z.number().int().min(-1023).max(1023),
  voltage:z.number().int().min(0).max(255),temperature:z.number().int().min(0).max(255),
  current:z.number().int().min(-32767).max(32767),moving:z.boolean(),torque:z.boolean(),in_range:z.boolean()});
const cameraErrors=['disabled','unavailable','memory','open','capture','invalid','timeout','close','cancelled'];
const boundedDecimal = max => u64.refine(value=>BigInt(value)>0n&&BigInt(value)<=BigInt(max));
const touchLevel = z.number().int().min(0).max(3);
export const headTouchKinds = ['tap', 'hold', 'toward_channel_1', 'toward_channel_3'];
const imuAxis = z.number().int().min(-32768).max(32767);
const permilleOrNull = z.number().int().min(0).max(1000).nullable();
const gapMs = z.number().int().min(0).max(65534);
const nfcCount = z.number().int().min(0).max(4294967295);
const nfcCard = { uid:z.string().regex(/^(?:[0-9a-f]{8}|[0-9a-f]{14}|[0-9a-f]{20})$/),
  atqa:z.number().int().min(0).max(65535), sak:z.number().int().min(0).max(255), version:z.string().regex(/^(?:[0-9a-f]{16})?$/) };
const deviceControl = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('hello'), protocol: z.literal(1), device_id: hex(12),
    pair_id: hex(32), ...identity, phase: z.literal('idle'), playback_fence: z.literal(1).optional(), expression: z.literal(1).optional(), camera:z.literal(1).optional(),camera_status:z.literal(1).optional(), motion:z.literal(1).optional(),motion_frames:z.literal(1).optional(),setpoint:z.literal(1).optional(),screen_touch:z.literal(1).optional(),power:z.literal(1).optional(),volume:z.literal(1).optional(),infrared:z.literal(1).optional(),nfc:z.literal(1).optional(),display:z.literal([1,2]).optional(),frames:z.literal([1,2]).optional(),report_rate:z.literal(1).optional(),ring:z.literal(1).optional(),ring_frames:z.literal(1).optional(), voice_indicator:z.literal(1).optional(), caption:z.literal([1,2]).optional(), battery:z.literal(1).optional(), ambient:z.literal(1).optional(), head_touch:z.literal([1,2]).optional(), imu:z.literal(1).optional(), health:z.literal(1).optional(), standby:z.literal(2).optional() }),
  // intent 'sleep': the Stop button on a linked face asks to stop talking and
  // keep waiting; absent means a tap that toggles attending.
  z.strictObject({type:z.literal('attention'),...identity,intent:z.literal('sleep').optional()}),
  // Body-health sample for diagnosis: die temperature, per-core busy share and
  // how long input and UI loops went without progress. Numbers only.
  z.strictObject({type:z.literal('health_state'),...identity,
    sequence:z.number().int().min(1).max(0xffffffff), uptime_ms:z.number().int().min(0).max(0xffffffff),
    chip_decicelsius:z.number().int().min(-400).max(1500).nullable(),
    busy_permille:z.tuple([permilleOrNull,permilleOrNull]),
    top_task:z.string().regex(/^[A-Za-z0-9_?]{0,4}$/), top_permille:permilleOrNull,
    gap_ms:z.tuple([gapMs,gapMs,gapMs]), touch_errors:z.number().int().min(0).max(255),
    battery:z.number().int().min(0).max(100).nullable(), charging:z.boolean(), discharging:z.boolean(),
    brightness:z.number().int().min(0).max(254).nullable(), mouth_ticks:z.number().int().min(0).max(65534)}),
  z.strictObject({type:z.literal('battery_state'),...identity,percent:z.number().int().min(0).max(100).nullable(),
    direction:z.enum(['charging','discharging','idle','unknown'])}).refine(
    state=>(state.percent===null)===(state.direction==='unknown')),
  z.strictObject({type:z.literal('ambient_state'),...identity,
    light:z.strictObject({channel0:z.number().int().min(0).max(65535),channel1:z.number().int().min(0).max(65535)}).nullable(),
    proximity_raw:z.number().int().min(0).max(2047).nullable()}),
  z.strictObject({type:z.literal('head_touch_state'),...identity,
    levels:z.tuple([touchLevel,touchLevel,touchLevel]).nullable()}),
  z.strictObject({type:z.literal('head_touch_gesture'),...identity,
    sequence:z.number().int().min(1).max(0xffffffff), kind:z.enum(headTouchKinds),
    duration_ms:z.number().int().min(1).max(60000), peak:z.number().int().min(1).max(3),
    age_ms:z.number().int().min(0).max(2999)}),
  z.strictObject({type:z.literal('imu_state'),...identity,
    axes:z.tuple([imuAxis,imuAxis,imuAxis,imuAxis,imuAxis,imuAxis]).nullable(),
    // BMM150 raw counts (x, y 13-bit, z 15-bit), uncompensated; null without a magnetometer.
    mag:z.tuple([imuAxis,imuAxis,imuAxis]).nullable().optional()}),
  z.strictObject({type:z.literal('ring_state'),...identity,permission:z.enum(['allowed','disabled']),
    phase:z.enum(['idle','preparing','lit','clearing','fault']),error:z.enum(['',...ringErrors])}),
  z.strictObject({type:z.literal('ring_result'),...response,
    code:z.enum(['completed','invalid','disabled','busy','cancelled',...ringErrors])}),
  z.strictObject({type:z.literal('motion_state'),...identity,permission:z.enum(['allowed','disabled']),
    phase:z.enum(['idle','opening','commanding','moving','torquing','sensing','rotating','holding','releasing','fault']),error:z.enum(['',...motionErrors])}),
  z.strictObject({type:z.literal('servo_state'),...response,holding:z.boolean(),yaw:servoAxis,pitch:servoAxis}),
  z.strictObject({type:z.literal('setpoint_rejected'),...identity,reason:z.enum(['invalid','disabled','not-holding','limp'])}),
  z.strictObject({type:z.literal('display_result'),...response,
    code:z.enum(['shown','ready','cleared','unavailable','no-image','bad-chunk','incomplete','stored','no-room','invalid','no-frame','dropped'])}),
  // The device's frame bank (wiki/head-coupled-view.md).
  z.strictObject({type:z.literal('frame_list'),...response,used:z.number().int().min(0).max(16777216),budget:z.number().int().min(0).max(16777216),
    frames:z.array(z.strictObject({slot:z.number().int().min(0).max(47),width:z.number().int().min(1).max(320),height:z.number().int().min(1).max(240),
      x:z.number().int().min(0).max(319),y:z.number().int().min(0).max(239),tag:hex(16)})).max(48)}),
  // One per accepted picture chunk (display 2): bytes received so far.
  z.strictObject({type:z.literal('image_ack'),...response,received:z.number().int().min(1).max(320*240*2)}),
  z.strictObject({type:z.literal('ir_result'),...response,code:z.enum(['sent','failed','busy'])}),
  z.strictObject({type:z.literal('ir_received'),...identity,address:z.number().int().min(0).max(65535),
    command:z.number().int().min(0).max(255),repeat:z.boolean(),age_ms:z.number().int().min(0).max(60000)}),
  // An ISO14443A card arriving at or leaving the reader: UID (4, 7 or 10 bytes), ATQA and SAK as received;
  // version is the 8-byte GET_VERSION answer of a Type 2 tag, empty otherwise.
  z.strictObject({type:z.literal('nfc_card'),...identity,phase:z.enum(['present','removed']),...nfcCard,
    age_ms:z.number().int().min(0).max(60000)}),
  // Answer to nfc_read: Type 2 pages (4 bytes each) as hex, only with code 'read'. The card is empty when none was read.
  z.strictObject({type:z.literal('nfc_data'),...response,code:z.enum(['read','no-card','unsupported','failed','busy']),
    uid:z.string().regex(/^(?:|[0-9a-f]{8}|[0-9a-f]{14}|[0-9a-f]{20})$/),atqa:z.number().int().min(0).max(65535),
    sak:z.number().int().min(0).max(255),version:z.string().regex(/^(?:[0-9a-f]{16})?$/),
    page:z.number().int().min(0).max(255),count:z.number().int().min(1).max(64),data_hex:z.string().regex(/^(?:[0-9a-f]{2})*$/).max(512),stats:z.strictObject({polls:nfcCount,field_failed:nfcCount,silent:nfcCount,partial:nfcCount,anticollision_failed:nfcCount,select_failed:nfcCount,selected:nfcCount,version_failed:nfcCount,read_failed:nfcCount,collisions:nfcCount,error_irq:nfcCount}).optional()})
    .refine(v=>v.code==='read'?v.data_hex.length===v.count*8&&v.uid!=='':v.data_hex===''),
  z.strictObject({type:z.literal('volume_result'),...response,volume:z.number().int().min(0).max(100),applied:z.boolean()}),
  z.strictObject({type:z.literal('power_state'),...identity,bus_raw:z.number().int().min(0).max(65535).nullable(),
    shunt_raw:z.number().int().min(-32768).max(32767).nullable()}).refine(v=>(v.bus_raw===null)===(v.shunt_raw===null)),
  z.strictObject({type:z.literal('screen_touch'),...identity,phase:z.enum(['down','move','up']),
    x:z.number().int().min(-32768).max(32767),y:z.number().int().min(-32768).max(32767),age_ms:z.number().int().min(0).max(60000)}),
  z.strictObject({type:z.literal('report_rate'),...response,sensor:z.enum(['battery','ambient','head_touch','imu','power']),
    interval_ms:z.number().int().min(20).max(10000)}),
  z.strictObject({type:z.literal('motion_result'),...response,
    code:z.enum(['reached','invalid','disabled','busy','unavailable','cancelled',...motionErrors]),
    yaw:z.number().int().min(-3600).max(3600).optional(),pitch:z.number().int().min(0).max(900).optional(),
    holding:z.literal(true).optional()
  }).refine(v=>(v.yaw===undefined)===(v.pitch===undefined)),
  z.strictObject({type:z.literal('camera_state'),...identity,permission:z.enum(['allowed','disabled']),phase:z.enum(['idle','opening','capturing','closing','transferring','fault']),busy:z.boolean(),error:z.enum(['',...cameraErrors])}),
  z.strictObject({type:z.literal('camera_meta'),...response,bytes:boundedDecimal(CAMERA.maxBytes),width:boundedDecimal(CAMERA.width),height:boundedDecimal(CAMERA.height)}),
  z.strictObject({type:z.literal('camera_chunk'),...response,offset:u64,data:z.string().min(4).max(1368).regex(/^[A-Za-z0-9+/]+={0,2}$/)}),
  z.strictObject({type:z.literal('camera_complete'),...response}),
  z.strictObject({type:z.literal('camera_error'),...response,code:z.enum(cameraErrors)}),
  z.strictObject({ type: z.literal('expression_result'), ...response, expression: z.enum(EXPRESSIONS), status: z.enum(['applied','unavailable']) }),
  z.strictObject({ type: z.literal('started'), ...response }),
  z.strictObject({ type: z.literal('stopped'), ...response, resources_stopped: z.literal(true) }),
  z.strictObject({ type: z.literal('renewed'), ...identity }),
  z.strictObject({ type: z.literal('output'), ...identity, sequence: u64 }),
  z.strictObject({ type: z.literal('output_drained'), ...response, next_sequence: u64 }),
  z.strictObject({ type: z.literal('output_interrupted'), ...response, next_sequence: u64 }),
  z.strictObject({ type: z.literal('ended'), ...identity, reason: z.enum(['stop', 'home', 'audio', 'lease', 'fault']) }),
]);
export function decodeControl(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > AUDIO.maxMessageBytes) throw new Error('Invalid control');
  // Fatal UTF-8 decoding avoids replacing invalid byte sequences before validation.
  return deviceControl.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
}
export function encodePcm({ kind, epoch, sequence, readStartedUs = 0n, pcm }) {
  if (![1, 2].includes(kind) || !Buffer.isBuffer(pcm) || pcm.length !== (kind === 1 ? 960 : 480))
    throw new TypeError('Invalid PCM shape');
  for (const value of [epoch, sequence, readStartedUs])
    if (typeof value !== 'bigint' || value < 0n || value > MAX_U64) throw new TypeError('Invalid PCM integer');
  if (kind === 2 && readStartedUs !== 0n) throw new TypeError('Playback timestamp must be zero');
  const bytes = Buffer.alloc(AUDIO.headerBytes + pcm.length);
  bytes.write('SIA1', 0, 'ascii'); bytes[4] = kind;
  bytes.writeBigUInt64BE(epoch, 8); bytes.writeBigUInt64BE(sequence, 16); bytes.writeBigUInt64BE(readStartedUs, 24);
  pcm.copy(bytes, AUDIO.headerBytes); return bytes;
}
export function decodePcm(bytes, expectedKind) {
  if (!Buffer.isBuffer(bytes) || ![1, 2].includes(expectedKind) ||
      bytes.length !== AUDIO.headerBytes + (expectedKind === 1 ? 960 : 480) ||
      bytes.toString('ascii', 0, 4) !== 'SIA1' || bytes[4] !== expectedKind || bytes[5] || bytes[6] || bytes[7])
    throw new Error('Invalid PCM frame');
  const readStartedUs = bytes.readBigUInt64BE(24);
  if (expectedKind === 2 && readStartedUs !== 0n) throw new Error('Invalid playback timestamp');
  return { kind: expectedKind, epoch: bytes.readBigUInt64BE(8), sequence: bytes.readBigUInt64BE(16),
    readStartedUs, pcm: Buffer.from(bytes.subarray(AUDIO.headerBytes)) };
}
