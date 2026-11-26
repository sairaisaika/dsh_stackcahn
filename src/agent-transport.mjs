import https from 'node:https';
import { EventEmitter } from 'node:events';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { WebSocketServer, WebSocket } from 'ws';
import { localAddress } from './pairing.mjs';
import { AUDIO, CAMERA, CAPTION_BYTES, MOTION, RECORDING, RING, SENSOR_REPORTS, isRingColor, EXPRESSIONS, MAX_U64, decodeControl, decodePcm, encodePcm } from './agent-protocol.mjs';
import {CameraReception} from './agent-camera.mjs';
import { createUsbAgentWire, createRelayAgentWire } from './agent-usb-wire.mjs';
import { openAgentRelayStream } from './agent-relay.mjs';

class AgentTransportError extends Error {
  constructor(code) { super(`Agent transport: ${code}`); this.code = code; }
}
const fault = code => new AgentTransportError(code);
const nonce = () => randomBytes(16).toString('hex');
const inputBatchLimit = 4;
/** Picture chunks allowed in flight before the device acknowledges them (about 8 KB). */
export const DISPLAY_WINDOW = 4;
export const FRAME_SLOTS = 48;
/** Time the device spends redrawing a full-screen frame, paced to the rate v75 sustained on Sion (10 full-screen frames a second; 90 ms spacing still dropped the link). LVGL
 * holds the display lock while it draws, which also holds off the session loop; showing frames faster
 * than this starves the microphone queue and the link closes. Smaller frames scale with their area. */
export const FRAME_DRAW_MS_FULL = 100;
/** frames 2 (v76) sends frames straight to the LCD without the display lock: a full screen is about 31 ms
 * of SPI at 40 MHz, so pacing is that transfer rather than an LVGL redraw. */
export const FRAME_PUSH_MS_FULL = 34;
/** 16 hex: a digest of the picture and where it sits, so an unchanged frame need not be sent again. */
export function frameTag({width,height,x=0,y=0,rgb565}){
  return createHash('sha256').update(`${width}x${height}+${x}+${y}:`).update(rgb565).digest('hex').slice(0,16);
}
// Recognition is segment based, so late audio is still useful. Hold four seconds
// (10 ms frames) before giving up on a backlog; never treat lateness as a fault.
const inputBacklogFrames = 400;
// A device may skip capture frames while its own send queue is congested.
const inputSequenceGapLimit = 6000n;
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  // Owners may observe connection failure before starting to await readiness.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

/** One message wire. Ready requires transport authentication and an Agent hello. */
class AgentConnection extends EventEmitter {
  constructor(socket, { deviceId, pairId, timeoutMs, heartbeatMs, recoverInput, voiceDiagnostics }) {
    super();
    this.socket = socket; this.deviceId = deviceId; this.pairId = pairId;
    this.timeoutMs = timeoutMs; this.heartbeatMs = heartbeatMs;
    this.recoverInput = recoverInput;
    this.voiceDiagnostics = voiceDiagnostics;
    this.phase = 'hello'; this.epoch = 0n; this.bootId = null;
    this.input = []; this.outputs = new Map(); this.reader = null; this.operation = null;
    this.playback = null; this.playbackSupported = false;
    this.inputSequence = 0n; this.outputSequence = 0n; this.readyState = deferred(); this.ready = this.readyState.promise;
    this.helloTimer = setTimeout(() => this.fail('hello-timeout'), timeoutMs);
    socket.on('message', (bytes, binary) => {
      try { this.receive(bytes, binary); }
      catch (error) {
        this.fail('protocol-invalid', false, error instanceof AgentTransportError ? error.code : undefined);
      }
    });
    socket.on('error', () => this.fail('connection-failed'));
    socket.on('close', () => this.fail('disconnected'));
  }
  snapshot() { return { phase: this.phase, deviceId: this.deviceId, bootId: this.bootId, epoch: String(this.epoch) }; }
  negotiatedCapabilities() {
    if(!this.bootId||this.phase==='closed')return null;
    return {active:this.phase==='active',captionRequested:this.captionRequested,versions:{
      audio:1,playbackFence:this.playbackSupported?1:0,expression:this.expressionSupported?1:0,
      camera:this.cameraSupported?1:0,motion:this.motionSupported?(this.motionFramesSupported?2:1):0,ring:this.ringSupported?1:0,
      ...(this.batterySupported?{battery:1}:{}),
      ...(this.ambientSupported?{ambient:1}:{}),
      ...(this.headTouchVersion?{headTouch:this.headTouchVersion}:{}),
      ...(this.imuSupported?{imu:1}:{}),
      ...(this.healthSupported?{health:1}:{}),
      ...(this.screenTouchSupported?{screenTouch:1}:{}),
      ...(this.powerSupported?{power:1}:{}),
      ...(this.infraredSupported?{infrared:1}:{}),
      ...(this.nfcSupported?{nfc:1}:{}),
      ...(this.ringFramesSupported?{ringFrames:1}:{}),
      ...(this.volumeSupported?{volume:1}:{}),
      ...(this.setpointSupported?{setpoint:1}:{}),
      ...(this.displaySupported?{display:this.displayImageSupported?2:1}:{}),
      ...(this.framesSupported?{frames:this.framesVersion}:{}),
      ...(this.reportRateSupported?{reportRate:1}:{}),
    },inFlight:{
      camera:!!this.cameraRequest,motion:!!this.motionRequest,ring:!!this.ringRequest,
    }};
  }
  batterySnapshot(now=performance.now()) {
    const report=this.batteryReport;
    if(!this.batterySupported)return undefined;
    if(this.phase!=='active'||report?.epoch!==String(this.epoch))return {version:1,status:'waiting'};
    if(now<report.receivedAt||now-report.receivedAt>=6000)return {version:1,status:'stale'};
    if(report.percent===null)return {version:1,status:'unavailable'};
    return {version:1,status:'current',percent:report.percent,direction:report.direction};
  }
  ambientSnapshot(now=performance.now()) {
    const report=this.ambientReport;
    if(!this.ambientSupported)return undefined;
    if(this.phase!=='active'||report?.epoch!==String(this.epoch))return {version:1,status:'waiting'};
    if(now<report.receivedAt||now-report.receivedAt>=6000)return {version:1,status:'stale'};
    if(report.light===null&&report.proximity_raw===null)return {version:1,status:'unavailable'};
    return {version:1,status:'current',
      ...(report.light===null?{}:{light:report.light}),
      ...(report.proximity_raw===null?{}:{proximityRaw:report.proximity_raw}),
    };
  }
  headTouchSnapshot(now=performance.now()) {
    const report=this.headTouchReport;
    const version=this.headTouchVersion;
    if(!version)return undefined;
    if(this.phase!=='active')return {version,status:'waiting'};
    const epoch=String(this.epoch);
    const gestures=version===2?{recentGestures:(this.headTouchGestures??[])
      .filter(event=>event.epoch===epoch&&now>=event.receivedAt&&now-event.completedAt<30000)
      .map(({sequence,kind,duration_ms,peak,completedAt})=>({
        sequence,kind,durationMs:duration_ms,peak,ageMs:Math.round(now-completedAt),
      }))}:{};
    if(report?.epoch!==epoch)return {version,status:'waiting',...gestures};
    if(now<report.receivedAt||now-report.receivedAt>=1000)return {version,status:'stale',...gestures};
    if(report.levels===null)return {version,status:'unavailable',...gestures};
    return {version,status:'current',levels:report.levels.slice(),...gestures};
  }
  imuSnapshot(now=performance.now()) {
    const report=this.imuReport;
    if(!this.imuSupported)return undefined;
    if(this.phase!=='active'||report?.epoch!==String(this.epoch))return {version:1,status:'waiting'};
    if(now<report.receivedAt||now-report.receivedAt>=1000)return {version:1,status:'stale'};
    if(report.axes===null)return {version:1,status:'unavailable'};
    // The version 1 wire uses signed BMI270 counts at ±2g and ±2000°/s.
    return {version:1,status:'current',
      accelerationMg:report.axes.slice(0,3).map(value=>Math.round(value*2000/32768)||0),
      angularVelocityMdps:report.axes.slice(3).map(value=>Math.round(value*2000000/32768)),
    };
  }
  cameraSnapshot(now=performance.now()) {
    const report=this.cameraReport;
    const online=['idle','active'].includes(this.phase);
    const current=online&&report&&report.epoch===String(this.epoch)&&now>=report.receivedAt&&now-report.receivedAt<CAMERA.statusFreshMs;
    return {capability:this.phase==='closed'?'disconnected':this.cameraSupported?'available':'unsupported',
      status:!this.cameraStatusSupported?'unavailable':!online||!report||report.epoch!==String(this.epoch)?'waiting':current?'current':'stale',
      permission:current?report.permission:'unknown',phase:current?report.phase:'unknown',busy:current?report.busy:false,error:current?report.error:''};
  }
  motionSnapshot(now=performance.now()) {
    const report=this.motionReport;
    const online=['idle','active'].includes(this.phase);
    const sameEpoch=online&&report?.epoch===String(this.epoch);
    const current=sameEpoch&&now>=report.receivedAt&&now-report.receivedAt<MOTION.statusFreshMs;
    return {capability:this.phase==='closed'?'disconnected':this.motionSupported?'available':'unsupported',
      status:!this.motionSupported?'unavailable':!sameEpoch?'waiting':current?'current':'stale',
      permission:current?report.permission:'unknown',phase:current?report.phase:'unknown',error:current?report.error:''};
  }
  ringSnapshot(now=performance.now()) {
    const report=this.ringReport;
    const online=['idle','active'].includes(this.phase);
    const sameEpoch=online&&report?.epoch===String(this.epoch);
    const current=sameEpoch&&now>=report.receivedAt&&now-report.receivedAt<RING.statusFreshMs;
    return {capability:this.phase==='closed'?'disconnected':this.ringSupported?'available':'unsupported',
      status:!this.ringSupported?'unavailable':!sameEpoch?'waiting':current?'current':'stale',
      permission:current?report.permission:'unknown',phase:current?report.phase:'unknown',error:current?report.error:''};
  }
  fail(code, graceful = false, protocolCode) {
    if (this.phase === 'closed') return;
    this.voiceDiagnostics?.closeLink(code);
    this.phase = 'closed'; this.failure = fault(code);
    if (protocolCode !== undefined) this.failure.protocolCode = protocolCode;
    clearTimeout(this.helloTimer); clearInterval(this.heartbeat);
    this.readyState.reject(this.failure); this.operation?.reject(this.failure); this.operation = null;
    this.clearAudio(this.failure);
    if(graceful&&this.socket.finish)this.socket.finish();else this.socket.terminate();
    this.emit('disconnect', this.failure);
  }
  clearAudio(error) {
    this.cameraRequest?.receiver.clear();this.cameraRequest?.reject(error);this.cameraRequest=null;
    this.motionRequest?.reject(error);this.motionRequest=null;
    for(const op of this.rateRequests?.values()??[])op.reject(error);this.rateRequests?.clear();
    this.volumeRequest?.reject(error);this.volumeRequest=null;
    this.irRequest?.reject(error);this.irRequest=null;
    this.nfcRequest?.reject(error);this.nfcRequest=null;
    this.displayRequest?.waiter?.reject(error);this.displayRequest?.ackWaiter?.reject(error);this.displayRequest=null;
    for(const op of this.frameShows?.values()??[])op.reject(error);this.frameShows?.clear();
    this.ringRequest?.reject(error);this.ringRequest=null;
    this.expressionRequest?.reject(error); this.expressionRequest = null;
    this.input.length = 0; this.reader?.reject(error); this.reader = null;
    this.playback?.reject(error); this.playback = null;
    this.clearOutput(error);
  }
  clearOutput(error) {
    for (const pending of this.outputs.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.outputs.clear();
  }
  send(value) {
    const bytes = Buffer.isBuffer(value) ? value : JSON.stringify(value);
    if (this.phase === 'closed' || this.socket.readyState !== WebSocket.OPEN) throw fault('disconnected');
    if (this.socket.bufferedAmount + Buffer.byteLength(bytes) > 32768) {
      this.fail('send-overflow'); throw this.failure;
    }
    this.socket.send(bytes, { binary: Buffer.isBuffer(value), compress: false }, error => {
      if (error) this.fail('send-failed');
    });
  }
  receive(bytes, binary) {
    if (this.phase === 'closed') return;
    if (binary) {
      const frame = decodePcm(bytes, 1);
      // In-flight samples after Stop are discarded; they never enter another epoch.
      if (this.phase === 'stopping' && frame.epoch === this.epoch) return;
      if (this.phase !== 'active' || frame.epoch !== this.epoch || this.inputSequence === MAX_U64) throw fault('input-order');
      const receivedAt = performance.now();
      const skipped = frame.sequence - this.inputSequence;
      if (skipped !== 0n) {
        // Only a recovering consumer accepts a bounded forward gap. Replays stay invalid.
        if (!this.recoverInput || skipped < 0n || skipped > inputSequenceGapLimit) throw fault('input-order');
        this.dropInput(Number(skipped), 'device');
      }
      this.inputSequence = frame.sequence + 1n;
      if (this.reader) {
        const reader = this.reader; this.reader = null;
        reader.resolve({ entries: [{ frame, receivedAt }], generation: this.inputGeneration });
      } else {
        const capacity = this.recoverInput ? inputBacklogFrames : AUDIO.inputQueueFrames;
        if (this.input.length === capacity) {
          if (!this.recoverInput) { this.fail('input-overflow'); return; }
          this.dropInput(0, 'capacity');
        }
        this.input.push({ frame, receivedAt });
      }
      this.voiceDiagnostics?.inputFrame(receivedAt, this.input.length);
      return;
    }
    const message = decodeControl(bytes);
    if (this.phase === 'hello') {
      if (message.type !== 'hello' || message.device_id !== this.deviceId || message.pair_id !== this.pairId)
        throw fault('identity-mismatch');
      this.bootId = message.boot_id; this.epoch = BigInt(message.epoch); this.phase = 'idle';
      this.playbackSupported = message.playback_fence === 1;
      this.motionSupported=message.motion===1;
      this.motionFramesSupported=this.motionSupported&&message.motion_frames===1;
      this.screenTouchSupported=message.screen_touch===1;
      this.powerSupported=message.power===1;
      this.volumeSupported=message.volume===1;
      this.infraredSupported=message.infrared===1;
      this.nfcSupported=message.nfc===1;
      this.displaySupported=message.display===1||message.display===2;
      this.displayImageSupported=message.display===2;   // Pictures need chunk acks (v73).
      this.framesVersion=this.displayImageSupported&&(message.frames===1||message.frames===2)?message.frames:0;
      this.framesSupported=this.framesVersion>0;
      this.setpointSupported=this.motionFramesSupported&&message.setpoint===1;
      this.reportRateSupported=message.report_rate===1;
      this.ringSupported=message.ring===1;
      this.ringFramesSupported=this.ringSupported&&message.ring_frames===1;
      this.voiceIndicatorSupported=message.voice_indicator===1;
      if(this.voiceIndicatorSupported&&!this.ringSupported)throw fault('voice-indicator-capability-invalid');
      this.batterySupported=message.battery===1;
      this.ambientSupported=message.ambient===1;
      this.headTouchVersion=message.head_touch;
      this.imuSupported=message.imu===1;
      this.healthSupported=message.health===1;
      this.expressionSupported = message.expression === 1;
      this.captionRequested = message.caption === 1 || message.caption === 2;
      // 2: the face also shows a transient status line (thinking, tools).
      this.captionStatus = message.caption === 2;
      // 2: the device stays linked while it waits, and the Host decides when it
      // is being addressed. (1 was an on-device wake phrase, since removed.)
      this.standbyMode = message.standby === 2 ? 2 : 0;
      this.cameraSupported = message.camera === 1;
      this.cameraStatusSupported = message.camera_status === 1;
      if(this.cameraStatusSupported&&!this.cameraSupported)throw fault('camera-capability-invalid');
      clearTimeout(this.helloTimer); this.readyState.resolve(this); return;
    }
    if (message.boot_id !== this.bootId) throw fault('boot-mismatch');
    const epoch = BigInt(message.epoch);
    // Stop retires capability requests before its receipt advances the epoch.
    const retiredCapabilityResult = epoch < this.epoch || (this.phase === 'stopping' && epoch === this.epoch);
    if(message.type==='battery_state'){
      if(!this.batterySupported)throw fault('battery-state-unsupported');
      if(retiredCapabilityResult)return;
      if(epoch!==this.epoch||this.phase!=='active')throw fault('battery-state-mismatch');
      this.batteryReport={...message,receivedAt:performance.now()};
      this.sample('battery',message);
      return;
    }
    if(message.type==='ambient_state'){
      if(!this.ambientSupported)throw fault('ambient-state-unsupported');
      if(retiredCapabilityResult)return;
      if(epoch!==this.epoch||this.phase!=='active')throw fault('ambient-state-mismatch');
      this.ambientReport={...message,receivedAt:performance.now()};
      this.sample('ambient',message);
      return;
    }
    if(message.type==='head_touch_state'){
      if(!this.headTouchVersion)throw fault('head-touch-state-unsupported');
      if(retiredCapabilityResult)return;
      if(epoch!==this.epoch||this.phase!=='active')throw fault('head-touch-state-mismatch');
      this.headTouchReport={...message,receivedAt:performance.now()};
      this.sample('headTouch',message);
      // Raw-reading tally for diagnosing false touches; reported with each health sample.
      const w=this.headTouchWindow??={samples:0,unreadable:0,touched:[0,0,0],strong:[0,0,0],peak:[0,0,0]};
      w.samples++;
      if(!message.levels)w.unreadable++;
      else message.levels.forEach((level,i)=>{
        if(level>=1)w.touched[i]++;
        if(level>=2)w.strong[i]++;
        if(level>w.peak[i])w.peak[i]=level;
      });
      return;
    }
    if(message.type==='power_state'){
      if(!this.powerSupported)throw fault('power-state-unsupported');
      if(retiredCapabilityResult)return;
      if(epoch!==this.epoch||this.phase!=='active')throw fault('power-state-mismatch');
      this.powerReport={...message,receivedAt:performance.now()};
      this.sample('power',message);
      return;
    }
    if(message.type==='screen_touch'){
      if(!this.screenTouchSupported)throw fault('screen-touch-unsupported');
      if(retiredCapabilityResult)return;
      if(epoch!==this.epoch||this.phase!=='active')throw fault('screen-touch-mismatch');
      this.sample('screenTouch',message);
      return;
    }
    if(message.type==='head_touch_gesture'){
      if(this.headTouchVersion!==2)throw fault('head-touch-gesture-unsupported');
      if(retiredCapabilityResult)return;
      if(epoch!==this.epoch||this.phase!=='active')throw fault('head-touch-gesture-mismatch');
      const prior=this.headTouchGestures??[];
      const last=prior.at(-1);
      if(last?.epoch===message.epoch&&message.sequence<=last.sequence)return;
      const receivedAt=performance.now();
      this.headTouchGestures=[...(last?.epoch===message.epoch?prior.slice(-3):[]),
        {...message,receivedAt,completedAt:receivedAt-message.age_ms}];
      this.voiceDiagnostics?.stage('head-touch-gesture',{kind:message.kind,durationMs:message.duration_ms,peak:message.peak});
      try{this.onHeadTouchGesture?.({kind:message.kind,durationMs:message.duration_ms,peak:message.peak});}catch{}
      return;
    }
    if(message.type==='health_state'){
      if(!this.healthSupported)throw fault('health-state-unsupported');
      if(retiredCapabilityResult)return;
      if(epoch!==this.epoch||this.phase!=='active')throw fault('health-state-mismatch');
      this.healthReport={...message,receivedAt:performance.now()};
      const [touchGap,lvglGap,loopGap]=message.gap_ms;
      // Numbers and a four-letter task tag only; the diagnostics sink is a local log.
      this.voiceDiagnostics?.stage('device-health',{sequence:message.sequence,uptimeMs:message.uptime_ms,
        chipCelsius:message.chip_decicelsius===null?null:message.chip_decicelsius/10,
        busyPermille:message.busy_permille,topTask:message.top_task,topPermille:message.top_permille,
        touchGapMs:touchGap,lvglGapMs:lvglGap,loopGapMs:loopGap,touchErrors:message.touch_errors,
        battery:message.battery,charging:message.charging,discharging:message.discharging,brightness:message.brightness,
        mouthOpenTicks:message.mouth_ticks});
      if(this.headTouchWindow){
        this.voiceDiagnostics?.stage('head-touch-window',this.headTouchWindow);
        this.headTouchWindow=null;
      }
      return;
    }
    if(message.type==='attention'){
      if(this.standbyMode!==2)throw fault('attention-unsupported');
      if(retiredCapabilityResult)return;
      if(epoch!==this.epoch||this.phase!=='active')throw fault('attention-mismatch');
      try{this.onAttention?.(message.intent==='sleep'?'sleep':'toggle');}catch{}
      return;
    }
    if(message.type==='imu_state'){
      if(!this.imuSupported)throw fault('imu-state-unsupported');
      if(retiredCapabilityResult)return;
      if(epoch!==this.epoch||this.phase!=='active')throw fault('imu-state-mismatch');
      this.imuReport={...message,receivedAt:performance.now()};
      this.sample('imu',message);
      return;
    }
    if(message.type==='ring_state'){
      if(!this.ringSupported)throw fault('ring-state-unsupported');
      if(epoch<this.epoch)return;
      if(epoch!==this.epoch||!['idle','active','stopping','starting'].includes(this.phase))throw fault('ring-state-mismatch');
      this.ringReport={...message,receivedAt:performance.now()};return;
    }
    if(message.type==='ring_result'){
      if(retiredCapabilityResult)return;
      const op=this.ringRequest;
      if(this.phase!=='active'||epoch!==this.epoch||!op||message.request_id!==op.id)throw fault('ring-mismatch');
      this.ringRequest=null;
      if(message.code==='release-unconfirmed')op.reject(fault('ring-release-unconfirmed'));
      else if(op.cancelled||message.code!=='completed')op.reject(fault(`ring-${op.cancelled?'cancelled':message.code}`));
      else op.resolve({version:1,status:'completed'});
      return;
    }
    if(message.type==='motion_state'){
      if(!this.motionSupported)throw fault('motion-state-unsupported');
      if(epoch<this.epoch)return;
      if(epoch!==this.epoch||!['idle','active','stopping','starting'].includes(this.phase))throw fault('motion-state-mismatch');
      this.motionReport={...message,receivedAt:performance.now()};return;
    }
    if(message.type==='motion_result'){
      if(retiredCapabilityResult)return;
      const op=this.motionRequest;
      if(this.phase!=='active'||epoch!==this.epoch||!op||message.request_id!==op.id)throw fault('motion-mismatch');
      this.motionRequest=null;
      if(message.code==='release-unconfirmed')op.reject(fault('motion-release-unconfirmed'));
      else if(op.cancelled||message.code!=='reached'){
        // Where the head stopped (a stall says where it met resistance).
        const error=fault(`motion-${op.cancelled?'cancelled':message.code}`);
        if(message.yaw!==undefined)error.observed={yaw:message.yaw,pitch:message.pitch};
        op.reject(error);
      }
      else if(op.kind==='sense'){op.reject(fault('motion-result-invalid'));throw fault('servo-state-missing');}
      else if((op.kind==='head'||op.kind==='move')&&(message.yaw===undefined||
        Math.abs(message.yaw-op.yaw)>20||Math.abs(message.pitch-op.pitch)>20)){
        op.reject(fault('motion-result-invalid'));
        throw fault('motion-feedback-mismatch');
      }else if(op.kind==='head')op.resolve({version:1,status:'reached',observed:{yaw:message.yaw,pitch:message.pitch}});
      else op.resolve({version:1,status:'reached',holding:message.holding===true,
        ...(message.yaw===undefined?{}:{observed:{yaw:message.yaw,pitch:message.pitch}})});
      return;
    }
    if(message.type==='setpoint_rejected'){
      if(epoch!==this.epoch)return;
      this.setpointRejections=(this.setpointRejections??0)+1;this.lastSetpointRejection=message.reason;
      return;
    }
    if(message.type==='display_result'&&this.frameShows?.has(message.request_id)){
      if(epoch!==this.epoch)throw fault('display-mismatch');
      const op=this.frameShows.get(message.request_id);this.frameShows.delete(message.request_id);
      op.resolve(message.code);
      return;
    }
    if(message.type==='frame_list'){
      const op=this.displayRequest;
      if(!op||epoch!==this.epoch||message.request_id!==op.id||!op.waiter)throw fault('display-mismatch');
      const waiter=op.waiter;op.waiter=null;waiter.resolve(message);
      return;
    }
    if(message.type==='display_result'){
      const op=this.displayRequest;
      if(!op||epoch!==this.epoch||message.request_id!==op.id)throw fault('display-mismatch');
      const waiter=op.waiter;op.waiter=null;
      if(waiter)waiter.resolve(message.code);
      else{op.failed=message.code;const wake=op.ackWaiter;op.ackWaiter=null;wake?.resolve();}   // An unrequested reply (a bad chunk) ends the image.
      return;
    }
    if(message.type==='image_ack'){
      const op=this.displayRequest;
      if(!op||epoch!==this.epoch||message.request_id!==op.id||message.received<=(op.acked??0))throw fault('display-mismatch');
      op.acked=message.received;
      const wake=op.ackWaiter;op.ackWaiter=null;wake?.resolve();
      return;
    }
    if(message.type==='ir_result'){
      const op=this.irRequest;
      if(!op||epoch!==this.epoch||message.request_id!==op.id)throw fault('ir-mismatch');
      this.irRequest=null;
      if(message.code==='sent')op.resolve({version:1,status:'sent'});else op.reject(fault(`ir-${message.code}`));
      return;
    }
    if(message.type==='ir_received'){
      if(!this.infraredSupported)throw fault('ir-unsupported');
      if(retiredCapabilityResult)return;
      if(epoch!==this.epoch||this.phase!=='active')throw fault('ir-received-mismatch');
      this.sample('infrared',message);
      return;
    }
    if(message.type==='nfc_data'){
      const op=this.nfcRequest;
      if(!op||epoch!==this.epoch||message.request_id!==op.id||message.page!==op.page||message.count!==op.count)throw fault('nfc-mismatch');
      this.nfcRequest=null;
      // Poll stage counts since this conversation enabled the reader (firmware v74+), raw.
      const pollStats=message.stats?Object.fromEntries(Object.entries(message.stats).map(([k,v])=>[k.replace(/_(.)/g,(_,c)=>c.toUpperCase()),v])):undefined;
      if(message.code!=='read'){
        const error=fault(message.code==='unsupported'?'nfc-not-type2':`nfc-${message.code}`);
        if(pollStats)error.pollStats=pollStats;
        op.reject(error);return;
      }
      op.resolve({version:1,card:{uid:message.uid,atqa:message.atqa,sak:message.sak,getVersion:message.version||null},
        page:message.page,count:message.count,dataHex:message.data_hex,...(pollStats?{pollStats}:{})});
      return;
    }
    if(message.type==='nfc_card'){
      if(!this.nfcSupported)throw fault('nfc-unsupported');
      if(retiredCapabilityResult)return;
      if(epoch!==this.epoch||this.phase!=='active')throw fault('nfc-card-mismatch');
      this.sample('nfc',message);
      return;
    }
    if(message.type==='volume_result'){
      const op=this.volumeRequest;
      if(!op||epoch!==this.epoch||message.request_id!==op.id||message.volume!==op.volume)throw fault('volume-mismatch');
      this.volumeRequest=null;
      if(message.applied)op.resolve({version:1,volume:message.volume});else op.reject(fault('volume-not-applied'));
      return;
    }
    if(message.type==='report_rate'){
      const op=this.rateRequests?.get(message.request_id);
      if(!op||epoch!==this.epoch||message.sensor!==SENSOR_REPORTS[op.sensor].wire||message.interval_ms!==op.intervalMs)
        throw fault('report-rate-mismatch');
      this.rateRequests.delete(message.request_id);op.resolve();
      return;
    }
    if(message.type==='servo_state'){
      if(retiredCapabilityResult)return;
      const op=this.motionRequest;
      if(!this.motionFramesSupported||this.phase!=='active'||epoch!==this.epoch||!op||op.kind!=='sense'||message.request_id!==op.id)
        throw fault('servo-state-mismatch');
      this.motionRequest=null;
      if(op.cancelled){op.reject(fault('motion-cancelled'));return;}
      const axis=a=>({angle:a.angle,position:a.position,speed:a.speed,load:a.load,voltage:a.voltage,
        temperature:a.temperature,current:a.current,moving:a.moving,torque:a.torque,inRange:a.in_range});
      op.resolve({version:1,status:'read',holding:message.holding,yaw:axis(message.yaw),pitch:axis(message.pitch)});
      return;
    }
    if(message.type==='camera_state'){
      if(!this.cameraStatusSupported)throw fault('camera-state-unsupported');
      if(epoch<this.epoch)return;
      if(epoch!==this.epoch||!['idle','active','stopping','starting'].includes(this.phase))throw fault('camera-state-mismatch');
      this.cameraReport={...message,receivedAt:performance.now()};return;
    }
    if(message.type.startsWith('camera_')){
      if(retiredCapabilityResult)return;
      const op=this.cameraRequest;
      if(this.phase!=='active'||epoch!==this.epoch||!op||message.request_id!==op.id)throw fault('camera-mismatch');
      if(message.type==='camera_error'){
        op.receiver.clear();this.cameraRequest=null;op.reject(fault(`camera-${message.code}`));return;
      }
      const reply=op.receiver.receive(message);
      if(reply.result){this.cameraRequest=null;op.resolve(reply.result);}
      else this.send({type:'camera_next',boot_id:this.bootId,epoch:String(this.epoch),request_id:op.id,offset:String(reply.next)});
      return;
    }
    if (message.type === 'expression_result') {
      if (retiredCapabilityResult) return;
      const op = this.expressionRequest;
      if (this.phase !== 'active' || epoch !== this.epoch || !op || message.request_id !== op.id || message.expression !== op.expression)
        throw fault('expression-mismatch');
      this.expressionRequest = null;
      op.resolve({version:1,expression:message.expression,status:message.status}); return;
    }
    if (message.type === 'ended') { this.fail(`device-${message.reason}`); return; }
    if (message.type === 'renewed') {
      if (this.phase === 'stopping' && epoch === this.epoch) return;
      if (this.phase !== 'active' || epoch !== this.epoch) throw fault('renewal-mismatch');
      this.lastRenewal = performance.now(); return;
    }
    if (message.type === 'output') {
      if (this.phase === 'stopping' && epoch === this.epoch) return;
      if (this.phase !== 'active' || epoch !== this.epoch) throw fault('output-mismatch');
      if (this.playback?.response === 'output_interrupted') {
        if (BigInt(message.sequence) >= this.playback.boundary) throw fault('output-order');
        return; // Earlier credits are retired by the interrupt boundary receipt.
      }
      const sequence = BigInt(message.sequence); const pending = this.outputs.get(sequence);
      if (!pending || sequence !== this.outputs.keys().next().value) throw fault('output-order');
      this.outputs.delete(sequence); clearTimeout(pending.timer); pending.resolve({ accepted: true }); return;
    }
    if (message.type === 'output_drained' || message.type === 'output_interrupted') {
      if (this.phase === 'stopping' && epoch === this.epoch) return;
      const op = this.playback;
      if (this.phase !== 'active' || epoch !== this.epoch || !op || message.type !== op.response ||
          message.request_id !== op.id || BigInt(message.next_sequence) !== op.boundary || this.outputs.size) {
        throw fault('playback-mismatch');
      }
      this.playback = null;
      op.resolve({ playbackIdle: true, discarded: message.type === 'output_interrupted', nextSequence: message.next_sequence });
      return;
    }
    const op = this.operation;
    if (!op || message.type !== op.response || message.request_id !== op.id || epoch !== op.epoch)
      throw fault('response-mismatch');
    this.operation = null; this.epoch = epoch;
    if (message.type === 'started') {
      this.phase = 'active'; this.inputSequence = this.outputSequence = 0n; this.lastRenewal = performance.now();
      this.inputGeneration = 0;
      this.voiceDiagnostics?.startCapture();
      this.voiceIndicator = this.sentVoiceIndicator = undefined;
      this.heartbeat = setInterval(() => {
        if (performance.now() - this.lastRenewal >= this.timeoutMs) return this.fail('lease-timeout');
        try {
          this.send({ type: 'renew', boot_id: this.bootId, epoch: String(this.epoch) });
          this.flushVoiceIndicator();
        }
        catch { this.fail('send-failed'); }
      }, this.heartbeatMs);
      op.resolve({ bootId: this.bootId, epoch: String(epoch) });
    } else {
      this.voiceDiagnostics?.endCapture('stop-ack');
      this.phase = 'idle'; op.resolve({ deviceIdle: true, bootId: this.bootId, epoch: String(epoch) });
    }
  }
  async command(action, signal) {
    signal?.throwIfAborted();
    if (this.operation || this.phase !== (action === 'start' ? 'idle' : 'active')) throw fault('not-ready');
    // A session must leave room for both Begin and its subsequent Stop fence.
    if (this.epoch > MAX_U64 - (action === 'start' ? 2n : 1n)) throw fault('epoch-exhausted');
    const pending = deferred(); const id = nonce();
    this.operation = { ...pending, id, epoch: this.epoch + 1n, response: action === 'start' ? 'started' : 'stopped' };
    this.phase = action === 'start' ? 'starting' : 'stopping';
    if (action === 'stop') { clearInterval(this.heartbeat); this.clearAudio(fault('stopped')); }
    const abort = () => this.fail('cancelled');
    const timer = setTimeout(() => this.fail('command-timeout'), this.timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      this.send({ type: action, request_id: id, boot_id: this.bootId, epoch: String(this.epoch) });
      return await pending.promise;
    } catch (error) { this.fail('command-failed'); throw error; }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  start({ signal } = {}) { return this.command('start', signal); }
  stop({ signal } = {}) { return this.command('stop', signal); }
  setVoiceIndicator(state) {
    const states = this.standbyMode === 2 ? ['listening','waiting','standby'] : ['listening','waiting'];
    if (!this.voiceIndicatorSupported || this.phase !== 'active' || !states.includes(state)) return;
    this.voiceIndicator = state;
    this.flushVoiceIndicator();
  }
  flushVoiceIndicator() {
    if (this.phase !== 'active' || this.voiceIndicator === this.sentVoiceIndicator ||
        this.socket.bufferedAmount > AUDIO.maxMessageBytes) return;
    this.send({type:'voice_indicator',boot_id:this.bootId,epoch:String(this.epoch),state:this.voiceIndicator});
    this.sentVoiceIndicator = this.voiceIndicator;
  }
  sendCaption(speaker, text, { required = false } = {}) {
    if (!this.captionRequested || this.phase !== 'active' ||
        !(speaker === 'user' || speaker === 'assistant' || speaker === 'status' && this.captionStatus) ||
        typeof text !== 'string') return false;
    // Digital audio and Stop take precedence over this transient display.
    if (!required && this.socket.bufferedAmount > AUDIO.maxMessageBytes) return false;
    // One whole UTF-8 prefix, without controls other than line breaks. Hex keeps
    // the existing flat, unescaped JSON command grammar.
    const cleaned = text.slice(0, CAPTION_BYTES + 1).toWellFormed()
      .replace(/\r\n?/gu, '\n').replace(/[\p{Cc}\p{Cf}]/gu, ch => ch === '\n' ? ch : ' ').trim();
    const bytes = Buffer.from(cleaned, 'utf8');
    if (!bytes.length) return false;
    let payload = bytes;
    if (bytes.length > CAPTION_BYTES || text.length > CAPTION_BYTES + 1) {
      let end = Math.min(bytes.length, CAPTION_BYTES - 3);
      while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) --end;
      payload = Buffer.concat([bytes.subarray(0, end), Buffer.from('...')]);
    }
    this.send({ type:'caption', boot_id:this.bootId, epoch:String(this.epoch), speaker, text_hex:payload.toString('hex') });
    return true;
  }
  async captureCamera({signal}={}){
    signal?.throwIfAborted();
    if(!this.cameraSupported)throw fault('camera-unsupported');
    if(this.phase!=='active')throw fault('not-ready');
    if(this.cameraRequest)throw fault('camera-busy');
    const pending=deferred(),id=nonce();
    this.cameraRequest={...pending,id,receiver:new CameraReception()};
    const abort=()=>this.fail('camera-cancelled');
    const timer=setTimeout(()=>this.fail('camera-timeout'),CAMERA.timeoutMs);
    signal?.addEventListener('abort',abort,{once:true});
    try{
      try{this.send({type:'capture_camera',boot_id:this.bootId,epoch:String(this.epoch),request_id:id});}
      catch(error){this.fail('camera-send-failed');throw error;}
      return await pending.promise;
    }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
  }
  async moveHead({yaw,pitch,durationMs=1000}, {signal}={}){
    signal?.throwIfAborted();
    if(!this.motionSupported)throw fault('motion-unsupported');
    if(this.phase!=='active')throw fault('not-ready');
    if(this.motionRequest)throw fault('motion-busy');
    const inRange=(value,min,max)=>Number.isInteger(value)&&value>=min&&value<=max;
    if(!inRange(yaw,MOTION.yawMin,MOTION.yawMax)||!inRange(pitch,MOTION.pitchMin,MOTION.pitchMax)||
       !inRange(durationMs,MOTION.durationMin,MOTION.durationMax))throw fault('motion-invalid');
    const pending=deferred();
    const command={boot_id:this.bootId,epoch:String(this.epoch),request_id:nonce()};
    const op={...pending,id:command.request_id,kind:'head',yaw,pitch,cancelled:false};
    this.motionRequest=op;
    const abort=()=>{
      if(this.motionRequest!==op)return;
      op.cancelled=true;
      try{this.send({type:'cancel_move',...command});}catch{this.fail('motion-cancel-send-failed');}
    };
    const timer=setTimeout(()=>this.fail('motion-timeout'),MOTION.timeoutMs);
    signal?.addEventListener('abort',abort,{once:true});
    try{
      try{this.send({type:'move_head',...command,yaw:String(yaw),pitch:String(pitch),duration_ms:String(durationMs)});}
      catch{this.fail('motion-send-failed');}
      return await pending.promise;
    }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
  }
  /** Raw sample for an active sensor recording, as the device reported it. */
  sample(kind,message){
    const recording=this.recording;
    if(!recording?.sensors.has(kind)||recording.samples.length>=RECORDING.maxSamples)return;
    const t=Math.round(performance.now()-recording.startedAt);
    let value;
    if(kind==='imu')value=message.axes===null?null:{
      accelerationMg:message.axes.slice(0,3).map(v=>Math.round(v*2000/32768)||0),
      angularVelocityMdps:message.axes.slice(3).map(v=>Math.round(v*2000000/32768)),raw:message.axes,
      ...(message.mag?{magnetometerRaw:message.mag}:{})};
    else if(kind==='headTouch')value=message.levels===null?null:{levels:message.levels};
    else if(kind==='ambient')value={light:message.light,proximityRaw:message.proximity_raw};
    else if(kind==='power')value=message.bus_raw===null?null:{
      busMv:Math.round(message.bus_raw*1.25),currentMa:message.shunt_raw*0.25,raw:{bus:message.bus_raw,shunt:message.shunt_raw}};
    else if(kind==='infrared')value={protocol:'nec',address:message.address,command:message.command,repeat:message.repeat,ageMs:message.age_ms};
    else if(kind==='nfc')value={phase:message.phase,technology:'iso14443a',uid:message.uid,atqa:message.atqa,sak:message.sak,
      getVersion:message.version||null,ageMs:message.age_ms};
    else if(kind==='screenTouch')value={phase:message.phase,x:message.x,y:message.y,ageMs:message.age_ms};
    else value={percent:message.percent,direction:message.direction};
    recording.samples.push({t,sensor:kind,value});
  }
  /** One real-time head target while a torque hold runs; not acknowledged. */
  sendSetpoint({yaw,pitch,durationMs=20}){
    if(!this.setpointSupported)throw fault('setpoint-unsupported');
    if(this.phase!=='active')throw fault('not-ready');
    const inRange=(v,min,max)=>Number.isInteger(v)&&v>=min&&v<=max;
    if(!inRange(yaw,MOTION.yawMin,MOTION.yawMax)||!inRange(pitch,MOTION.pitchMin,MOTION.pitchMax)||
       !inRange(durationMs,MOTION.durationMin>20?20:MOTION.durationMin,MOTION.durationMax))throw fault('motion-invalid');
    this.send({type:'servo_setpoint',boot_id:this.bootId,epoch:String(this.epoch),
      yaw:String(yaw),pitch:String(pitch),duration_ms:String(durationMs)});
  }
  /** points: [{atMs, yaw?, pitch?, frame?}] in time order (≤ 400 points, ≤ 20 s, ≥ 20 ms apart). Each point
   * carries a head target (yaw and pitch together), a frame-bank slot to show, or both, so head and picture
   * follow one timeline. With any head target the torque is held for the whole run; each target is sent at
   * its time without waiting for arrival. At most one frame show waits for its reply: a frame due
   * while one is pending replaces any frame still waiting to go (latest wins, counted as skipped), so a
   * timeline faster than the screen can redraw never fills the device's receive queue. */
  async streamSetpoints({points,holdMs,frameMs=60000},{signal}={}){
    signal?.throwIfAborted();
    const inRange=(v,min,max)=>Number.isInteger(v)&&v>=min&&v<=max;
    const head=p=>p?.yaw!==undefined||p?.pitch!==undefined;
    if(!Array.isArray(points)||points.length<1||points.length>400||
       points.some((p,i)=>!inRange(p?.atMs,0,20000)||(i>0&&p.atMs-points[i-1].atMs<20)||
         (head(p)&&(!inRange(p.yaw,MOTION.yawMin,MOTION.yawMax)||!inRange(p.pitch,MOTION.pitchMin,MOTION.pitchMax)))||
         (p.frame!==undefined&&!inRange(p.frame,0,FRAME_SLOTS-1))||(!head(p)&&p.frame===undefined)))throw fault('motion-invalid');
    const moves=points.some(head),frames=points.some(p=>p.frame!==undefined);
    if(moves&&!this.setpointSupported)throw fault('setpoint-unsupported');
    if(frames&&!this.framesSupported)throw fault('frames-unsupported');
    if(!inRange(frameMs,100,60000))throw fault('display-invalid');
    const total=points.at(-1).atMs;
    const hold=Math.min(MOTION.holdMaxMs,holdMs??total+1500);
    if(moves&&hold<total+200)throw fault('motion-invalid');
    if(moves)await this.setTorque({torque:'hold',holdMs:hold},{signal});
    const before=this.setpointRejections??0,start=performance.now();
    const shows=[];
    let sent=0,skipped=0,waiting=null,busy=null;
    // Each show also keeps the screen busy while it redraws: pace by the frame's area.
    const sizes=new Map();
    if(frames)for(const f of (await this.listFrames({signal})).frames)sizes.set(f.slot,f.width*f.height);
    const drawMs=slot=>Math.ceil((this.framesVersion>=2?FRAME_PUSH_MS_FULL:FRAME_DRAW_MS_FULL)*(sizes.get(slot)??320*240)/(320*240));
    const showNext=frame=>{
      const late=Math.round(performance.now()-start-frame.atMs),sentAt=performance.now();
      busy=this.showFrame({slot:frame.slot,durationMs:frameMs}).then(async r=>{
          const rest=drawMs(frame.slot)-(performance.now()-sentAt);
          if(rest>0)await new Promise(resolve=>setTimeout(resolve,rest));
          return {ok:true,roundTripMs:r.roundTripMs,late};
        },
        error=>({ok:false,code:error.code??String(error.message),late}));
      shows.push(busy);
      busy.then(()=>{busy=null;if(waiting&&this.phase==='active'){const next=waiting;waiting=null;showNext(next);}});
    };
    for(let i=0;i<points.length;i++){
      const wait=points[i].atMs-(performance.now()-start);
      if(wait>0)await new Promise((resolve,reject)=>{const t=setTimeout(resolve,wait);
        signal?.addEventListener('abort',()=>{clearTimeout(t);reject(signal.reason);},{once:true});});
      signal?.throwIfAborted();
      if(points[i].frame!==undefined){
        const frame={slot:points[i].frame,atMs:points[i].atMs};
        if(busy){if(waiting)skipped++;waiting=frame;}
        else showNext(frame);
      }
      if(head(points[i])){
        const next=points.slice(i+1).find(head);
        this.sendSetpoint({yaw:points[i].yaw,pitch:points[i].pitch,durationMs:Math.min(3000,Math.max(20,next?next.atMs-points[i].atMs:200))});
        sent++;
      }
    }
    await new Promise(resolve=>setTimeout(resolve,100));   // Late rejections.
    const rejected=(this.setpointRejections??0)-before;
    const result={version:1,sent,rejected,lastRejection:rejected?this.lastSetpointRejection:undefined,holdingMs:moves?hold:0};
    if(frames){
      while(busy||waiting){if(busy)await busy;else if(waiting){skipped++;waiting=null;}}
      const done=await Promise.all(shows),trips=done.filter(d=>d.ok).map(d=>d.roundTripMs).sort((a,b)=>a-b);
      const failed=done.filter(d=>!d.ok);
      result.frames={sent:done.length,shown:trips.length,failed:failed.length,skipped,lastFailure:failed.at(-1)?.code,
        roundTripMs:trips.length?{median:trips[trips.length>>1],max:trips.at(-1)}:undefined,maxLateMs:Math.max(0,...done.map(d=>d.late))};
    }
    return result;
  }
  async displayCommand(payload,{id,expect}){
    const op=this.displayRequest;
    const waiter=deferred();op.waiter=waiter;
    const timer=setTimeout(()=>this.fail('display-timeout'),10000);
    try{
      this.send({...payload,boot_id:this.bootId,epoch:String(this.epoch),request_id:id});
      const code=await waiter.promise;
      if(!expect.includes(code))throw fault(`display-${code}`);
      return code;
    }finally{clearTimeout(timer);}
  }
  displayBegin(){
    if(!this.displaySupported)throw fault('display-unsupported');
    if(this.phase!=='active')throw fault('not-ready');
    if(this.displayRequest)throw fault('display-busy');
    const id=nonce();this.displayRequest={id,waiter:null,failed:null};return id;
  }
  /** Text over the face (area full/top/bottom) for durationMs. UTF-8, at most 896 bytes. */
  async showText({text,area='full',durationMs=10000},{signal}={}){
    signal?.throwIfAborted();
    const bytes=Buffer.from(typeof text==='string'?text.toWellFormed():'', 'utf8');
    if(!bytes.length||bytes.length>CAPTION_BYTES||!['full','top','bottom'].includes(area)||
       !Number.isInteger(durationMs)||durationMs<100||durationMs>60000)throw fault('display-invalid');
    const id=this.displayBegin();
    try{
      await this.displayCommand({type:'show_text',text_hex:bytes.toString('hex'),area,duration_ms:String(durationMs)},{id,expect:['shown']});
      return {version:1,status:'shown'};
    }finally{this.displayRequest=null;}
  }
  /** An RGB565 little-endian picture at (x, y) for durationMs. */
  async showImage({width,height,x=0,y=0,rgb565,durationMs=10000},{signal}={}){
    signal?.throwIfAborted();
    const ok=v=>Number.isInteger(v)&&v>=0;
    if(!this.displayImageSupported&&this.displaySupported)throw fault('display-unsupported');
    if(!ok(width)||!ok(height)||!ok(x)||!ok(y)||!width||!height||x+width>320||y+height>240||
       !Buffer.isBuffer(rgb565)||rgb565.length!==width*height*2||!Number.isInteger(durationMs)||durationMs<100||durationMs>60000)
      throw fault('display-invalid');
    const id=this.displayBegin();
    try{
      await this.displayCommand({type:'image_begin',width:String(width),height:String(height),x:String(x),y:String(y),
        duration_ms:String(durationMs)},{id,expect:['ready']});
      await this.uploadPixels(id,rgb565,signal);
      await this.displayCommand({type:'image_end'},{id,expect:['shown']});
      return {version:1,status:'shown',width,height};
    }finally{this.displayRequest=null;}
  }
  /** Sends the pixels of the upload begun under id, keeping at most DISPLAY_WINDOW chunks unacknowledged. */
  async uploadPixels(id,rgb565,signal){
    const chunk=896,op=this.displayRequest;op.acked=0;
    for(let offset=0;offset<rgb565.length;offset+=chunk){
      signal?.throwIfAborted();
      if(op.failed)throw fault(`display-${op.failed}`);
      // The device acknowledges every chunk; at most DISPLAY_WINDOW stay unacknowledged so the
      // device's receive queue (24 messages) keeps room for speech and Stop.
      while(offset-op.acked>=DISPLAY_WINDOW*chunk){
        const wake=deferred();op.ackWaiter=wake;
        const timer=setTimeout(()=>wake.reject(fault('display-timeout')),10000);
        try{await wake.promise;}finally{clearTimeout(timer);op.ackWaiter=null;}
        if(op.failed)throw fault(`display-${op.failed}`);
        signal?.throwIfAborted();
      }
      this.displayMaxUnacked=Math.max(this.displayMaxUnacked??0,(offset-op.acked)/chunk+1);
      this.send({type:'image_chunk',boot_id:this.bootId,epoch:String(this.epoch),request_id:id,offset:String(offset),
        data_hex:rgb565.subarray(offset,offset+chunk).toString('hex')});
    }
  }
  /** Store an RGB565 picture in frame-bank slot 0..47 (shown later by number). tag: 16 hex, default a content digest. */
  async storeFrame({slot,width,height,x=0,y=0,rgb565,tag},{signal}={}){
    signal?.throwIfAborted();
    if(!this.framesSupported)throw fault('frames-unsupported');
    const ok=v=>Number.isInteger(v)&&v>=0;
    if(!Number.isInteger(slot)||slot<0||slot>=FRAME_SLOTS||!ok(width)||!ok(height)||!ok(x)||!ok(y)||!width||!height||
       x+width>320||y+height>240||!Buffer.isBuffer(rgb565)||rgb565.length!==width*height*2)throw fault('display-invalid');
    tag??=frameTag({width,height,x,y,rgb565});
    if(!/^[0-9a-f]{16}$/.test(tag))throw fault('display-invalid');
    const id=this.displayBegin(),started=performance.now();
    try{
      const ready=await this.displayCommand({type:'frame_begin',slot:String(slot),width:String(width),height:String(height),
        x:String(x),y:String(y),tag},{id,expect:['ready','no-room']});
      if(ready==='no-room')throw fault('display-no-room');
      await this.uploadPixels(id,rgb565,signal);
      await this.displayCommand({type:'image_end'},{id,expect:['stored']});
      return {version:1,status:'stored',slot,width,height,x,y,tag,tookMs:Math.round(performance.now()-started)};
    }finally{this.displayRequest=null;}
  }
  /** Show a stored frame. Several may be in flight (no display lock), so a timeline can run at frame rate. */
  async showFrame({slot,durationMs=60000},{signal}={}){
    signal?.throwIfAborted();
    if(!this.framesSupported)throw fault('frames-unsupported');
    if(this.phase!=='active')throw fault('not-ready');
    if(!Number.isInteger(slot)||slot<0||slot>=FRAME_SLOTS||!Number.isInteger(durationMs)||durationMs<100||durationMs>60000)
      throw fault('display-invalid');
    const id=nonce(),pending=deferred(),started=performance.now();
    (this.frameShows??=new Map()).set(id,pending);
    const timer=setTimeout(()=>{if(this.frameShows.delete(id))pending.reject(fault('display-timeout'));},5000);
    try{
      this.send({type:'frame_show',boot_id:this.bootId,epoch:String(this.epoch),request_id:id,slot:String(slot),duration_ms:String(durationMs)});
      const code=await pending.promise;
      if(code!=='shown')throw fault(`display-${code}`);
      return {version:1,status:'shown',slot,roundTripMs:Math.round((performance.now()-started)*10)/10};
    }finally{clearTimeout(timer);}
  }
  /** Drop one slot, or every frame with slot 'all'. Takes it off the screen first if it is showing. */
  async dropFrame({slot},{signal}={}){
    signal?.throwIfAborted();
    if(!this.framesSupported)throw fault('frames-unsupported');
    if(slot!=='all'&&(!Number.isInteger(slot)||slot<0||slot>=FRAME_SLOTS))throw fault('display-invalid');
    const id=this.displayBegin();
    try{await this.displayCommand({type:'frame_drop',slot:String(slot)},{id,expect:['dropped']});return {version:1,status:'dropped',slot};}
    finally{this.displayRequest=null;}
  }
  /** What the frame bank holds: [{slot,width,height,x,y,tag}], bytes used and the budget. */
  async listFrames({signal}={}){
    signal?.throwIfAborted();
    if(!this.framesSupported)throw fault('frames-unsupported');
    const id=this.displayBegin();
    try{
      const op=this.displayRequest,waiter=deferred();op.waiter=waiter;
      const timer=setTimeout(()=>this.fail('display-timeout'),10000);
      let message;
      try{this.send({type:'frame_list',boot_id:this.bootId,epoch:String(this.epoch),request_id:id});message=await waiter.promise;}
      finally{clearTimeout(timer);}
      return {version:1,used:message.used,budget:message.budget,frames:message.frames};
    }finally{this.displayRequest=null;}
  }
  async clearDisplay({signal}={}){
    signal?.throwIfAborted();
    const id=this.displayBegin();
    try{await this.displayCommand({type:'clear_display'},{id,expect:['cleared']});return {version:1,status:'cleared'};}
    finally{this.displayRequest=null;}
  }
  /** Send one NEC infrared code (address 0..65535, command 0..255) plus up to 5 repeat frames. */
  async sendInfrared({address,command,repeats=0},{signal}={}){
    signal?.throwIfAborted();
    if(!this.infraredSupported)throw fault('ir-unsupported');
    if(!Number.isInteger(address)||address<0||address>65535||!Number.isInteger(command)||command<0||command>255||
       !Number.isInteger(repeats)||repeats<0||repeats>5)throw fault('ir-invalid');
    if(this.phase!=='active')throw fault('not-ready');
    if(this.irRequest)throw fault('ir-busy');
    const pending=deferred(),id=nonce();
    this.irRequest={...pending,id};
    const timer=setTimeout(()=>this.fail('ir-timeout'),5000);
    try{
      this.send({type:'ir_send',boot_id:this.bootId,epoch:String(this.epoch),request_id:id,
        address:String(address),command:String(command),repeats:String(repeats)});
      return await pending.promise;
    }finally{clearTimeout(timer);}
  }
  /** Read 1..64 pages (4 bytes each) of the Type 2 tag on the reader. Read-only: the device can only send READ. */
  async readNfc({page,count},{signal}={}){
    signal?.throwIfAborted();
    if(!this.nfcSupported)throw fault('nfc-unsupported');
    if(!Number.isInteger(page)||page<0||page>255||!Number.isInteger(count)||count<1||count>64||page+count>256)throw fault('nfc-invalid');
    if(this.phase!=='active')throw fault('not-ready');
    if(this.nfcRequest)throw fault('nfc-busy');
    const pending=deferred(),id=nonce();
    this.nfcRequest={...pending,id,page,count};
    // The device tries up to 8 polls (250 ms apart) for the card, then reads at most 16 blocks.
    const timer=setTimeout(()=>this.fail('nfc-timeout'),6000);
    try{
      this.send({type:'nfc_read',boot_id:this.bootId,epoch:String(this.epoch),request_id:id,page:String(page),count:String(count)});
      return await pending.promise;
    }finally{clearTimeout(timer);}
  }
  /** Speaker volume 0..100, for now; the device keeps it until restarted unless saved in Settings. */
  async setVolume(volume,{signal}={}){
    signal?.throwIfAborted();
    if(!this.volumeSupported)throw fault('volume-unsupported');
    if(!Number.isInteger(volume)||volume<0||volume>100)throw fault('volume-invalid');
    if(this.phase!=='active')throw fault('not-ready');
    if(this.volumeRequest)throw fault('volume-busy');
    const pending=deferred(),id=nonce();
    this.volumeRequest={...pending,id,volume};
    const timer=setTimeout(()=>this.fail('volume-timeout'),5000);
    try{
      this.send({type:'set_volume',boot_id:this.bootId,epoch:String(this.epoch),request_id:id,volume:String(volume)});
      return await pending.promise;
    }finally{clearTimeout(timer);}
  }
  async setReportRate(sensor,intervalMs,{signal}={}){
    signal?.throwIfAborted();
    const spec=SENSOR_REPORTS[sensor];
    if(!spec||!Number.isInteger(intervalMs)||intervalMs<spec.minMs||intervalMs>10000)throw fault('recording-invalid');
    if(this.phase!=='active')throw fault('not-ready');
    this.rateRequests??=new Map();
    const pending=deferred();
    const id=nonce();
    this.rateRequests.set(id,{...pending,sensor,intervalMs});
    const timer=setTimeout(()=>{if(this.rateRequests.delete(id))pending.reject(fault('report-rate-timeout'));},5000);
    try{
      this.send({type:'set_report_rate',boot_id:this.bootId,epoch:String(this.epoch),request_id:id,
        sensor:spec.wire,interval_ms:String(intervalMs)});
      await pending.promise;
    }finally{clearTimeout(timer);}
  }
  /** Record raw sensor reports for durationMs at intervalMs (each sensor no faster than it allows),
   * then put the rates back. Samples are what the device sent, timestamped from the start. */
  async recordSensors({sensors,intervalMs,durationMs},{signal}={}){
    signal?.throwIfAborted();
    const kinds=[...new Set(sensors??[])];
    if(!kinds.length||kinds.some(k=>!SENSOR_REPORTS[k]&&k!=='screenTouch'&&k!=='infrared'&&k!=='nfc')||!Number.isInteger(intervalMs)||intervalMs<20||intervalMs>10000||
       !Number.isInteger(durationMs)||durationMs<100||durationMs>RECORDING.maxDurationMs)throw fault('recording-invalid');
    if(this.recording)throw fault('recording-busy');
    if(!this.reportRateSupported)throw Object.assign(fault('recording-unsupported'),{missing:kinds});
    const supported={imu:this.imuSupported,headTouch:!!this.headTouchVersion,ambient:this.ambientSupported,
      battery:this.batterySupported,screenTouch:this.screenTouchSupported,power:this.powerSupported,infrared:this.infraredSupported,nfc:this.nfcSupported};
    const missing=kinds.filter(k=>!supported[k]);
    if(missing.length)throw Object.assign(fault('recording-unsupported'),{missing});
    const recording={sensors:new Set(kinds),samples:[],startedAt:performance.now()};
    this.recording=recording;
    const used={};
    try{
      // Screen touches are events: they arrive as they happen, without a rate.
      for(const kind of kinds.filter(k=>SENSOR_REPORTS[k])){used[kind]=Math.max(intervalMs,SENSOR_REPORTS[kind].minMs);await this.setReportRate(kind,used[kind],{signal});}
      recording.startedAt=performance.now();recording.samples.length=0;
      await new Promise((resolve,reject)=>{
        const timer=setTimeout(resolve,durationMs);
        signal?.addEventListener('abort',()=>{clearTimeout(timer);reject(signal.reason);},{once:true});
      });
    }finally{
      this.recording=null;
      if(this.phase==='active')for(const kind of kinds.filter(k=>SENSOR_REPORTS[k]))
        await this.setReportRate(kind,SENSOR_REPORTS[kind].defaultMs).catch(()=>{});
    }
    return {version:1,durationMs,intervalMs:used,truncated:recording.samples.length>=RECORDING.maxSamples,samples:recording.samples};
  }
  // One motion request at a time: keyframes, torque or a register read.
  async motionCommand(kind,payload,{signal,yaw,pitch,timeoutMs=MOTION.timeoutMs}={}){
    signal?.throwIfAborted();
    if(!this.motionSupported)throw fault('motion-unsupported');
    if(!this.motionFramesSupported)throw fault('motion-frames-unsupported');
    if(this.phase!=='active')throw fault('not-ready');
    if(this.motionRequest)throw fault('motion-busy');
    const pending=deferred();
    const command={boot_id:this.bootId,epoch:String(this.epoch),request_id:nonce()};
    const op={...pending,id:command.request_id,kind,yaw,pitch,cancelled:false};
    this.motionRequest=op;
    const abort=()=>{
      if(this.motionRequest!==op)return;
      op.cancelled=true;
      try{this.send({type:'cancel_move',...command});}catch{this.fail('motion-cancel-send-failed');}
    };
    const timer=setTimeout(()=>this.fail('motion-timeout'),timeoutMs);
    signal?.addEventListener('abort',abort,{once:true});
    try{
      try{this.send({...payload,...command});}
      catch{this.fail('motion-send-failed');}
      return await pending.promise;
    }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
  }
  /** frames: [{yaw,pitch,durationMs}] (1..8); holdMs keeps the drives powered after the last
   * frame, with torque on (torque:'hold') or off (torque:'limp'). */
  async moveFrames({frames,holdMs=0,torque='hold'},{signal}={}){
    const inRange=(value,min,max)=>Number.isInteger(value)&&value>=min&&value<=max;
    if(!Array.isArray(frames)||frames.length<1||frames.length>MOTION.framesMax||
       frames.some(f=>!inRange(f?.yaw,MOTION.yawMin,MOTION.yawMax)||!inRange(f?.pitch,MOTION.pitchMin,MOTION.pitchMax)||
         !inRange(f?.durationMs??1000,MOTION.durationMin,MOTION.durationMax))||
       !inRange(holdMs,0,MOTION.holdMaxMs)||!['hold','limp'].includes(torque))throw fault('motion-invalid');
    const last=frames.at(-1);
    const total=frames.reduce((sum,f)=>sum+(f.durationMs??1000)+MOTION.frameGraceMs,0);
    return this.motionCommand('move',{type:'move_frames',
      frames:frames.map(f=>`${f.yaw},${f.pitch},${f.durationMs??1000}`).join(';'),hold_ms:String(holdMs),torque},
      {signal,yaw:last.yaw,pitch:last.pitch,timeoutMs:Math.max(MOTION.timeoutMs,total+5000)});
  }
  /** torque 'hold' keeps the present pose, 'limp' turns the drives off but keeps them powered
   * and readable, each for holdMs; 'release' turns everything off now. */
  async setTorque({torque,holdMs=0},{signal}={}){
    if(!['hold','limp','release'].includes(torque)||!Number.isInteger(holdMs)||holdMs<0||holdMs>MOTION.holdMaxMs||
       (torque==='release')!==(holdMs===0))throw fault('motion-invalid');
    return this.motionCommand('torque',{type:'set_torque',torque,hold_ms:String(holdMs)},{signal});
  }
  /** Turn the yaw servo continuously at velocity (-1000..1000, not 0) for durationMs, then
   * return it to position mode; release, or hold/limp for holdMs. */
  async rotateYaw({velocity,durationMs,holdMs=0,torque='hold'},{signal}={}){
    const inRange=(value,min,max)=>Number.isInteger(value)&&value>=min&&value<=max;
    if(!inRange(velocity,-MOTION.rotateVelocityMax,MOTION.rotateVelocityMax)||velocity===0||
       !inRange(durationMs,MOTION.rotateMinMs,MOTION.rotateMaxMs)||!inRange(holdMs,0,MOTION.holdMaxMs)||
       !['hold','limp'].includes(torque))throw fault('motion-invalid');
    return this.motionCommand('rotate',{type:'rotate_yaw',velocity:String(velocity),duration_ms:String(durationMs),
      hold_ms:String(holdMs),torque},{signal,timeoutMs:durationMs+MOTION.frameGraceMs+MOTION.timeoutMs});
  }
  /** Read every servo register once; keeps a running hold, otherwise powers up briefly. */
  async readServos({signal}={}){
    return this.motionCommand('sense',{type:'read_servos'},{signal});
  }
  async setRing({color,durationMs=1000},{signal}={}){
    signal?.throwIfAborted();
    if(!this.ringSupported)throw fault('ring-unsupported');
    if(this.phase!=='active')throw fault('not-ready');
    if(this.ringRequest)throw fault('ring-busy');
    if(!isRingColor(color)||!Number.isInteger(durationMs)||durationMs<RING.durationMin||durationMs>RING.durationMax)
      throw fault('ring-invalid');
    const pending=deferred();
    const command={boot_id:this.bootId,epoch:String(this.epoch),request_id:nonce()};
    const op={...pending,id:command.request_id,cancelled:false};
    this.ringRequest=op;
    const abort=()=>{
      if(this.ringRequest!==op)return;
      op.cancelled=true;
      try{this.send({type:'cancel_ring',...command});}catch{this.fail('ring-cancel-send-failed');}
    };
    const timer=setTimeout(()=>this.fail('ring-timeout'),RING.timeoutMs);
    signal?.addEventListener('abort',abort,{once:true});
    try{
      try{this.send({type:'set_ring',...command,rgb:color.slice(1).toLowerCase(),duration_ms:String(durationMs)});}
      catch{this.fail('ring-send-failed');}
      return await pending.promise;
    }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
  }
  /** frames: [{leds:[12 '#rrggbb' strings], durationMs}] (1..8; each 20..10000 ms, 10 s in all);
   * leds 0-5 one side of the ring, 6-11 the other. brightness 0..255 scales every LED. */
  async setRingFrames({frames,brightness=255},{signal}={}){
    signal?.throwIfAborted();
    if(!this.ringSupported)throw fault('ring-unsupported');
    if(!this.ringFramesSupported)throw fault('ring-frames-unsupported');
    if(this.phase!=='active')throw fault('not-ready');
    if(this.ringRequest)throw fault('ring-busy');
    const total=Array.isArray(frames)?frames.reduce((sum,f)=>sum+(f?.durationMs??0),0):0;
    if(!Array.isArray(frames)||frames.length<1||frames.length>8||total>10000||
       frames.some(f=>!Array.isArray(f?.leds)||f.leds.length!==12||!f.leds.every(isRingColor)||
         !Number.isInteger(f.durationMs)||f.durationMs<20||f.durationMs>10000)||
       !Number.isInteger(brightness)||brightness<0||brightness>255)throw fault('ring-invalid');
    const pending=deferred();
    const command={boot_id:this.bootId,epoch:String(this.epoch),request_id:nonce()};
    const op={...pending,id:command.request_id,cancelled:false};
    this.ringRequest=op;
    const abort=()=>{
      if(this.ringRequest!==op)return;
      op.cancelled=true;
      try{this.send({type:'cancel_ring',...command});}catch{this.fail('ring-cancel-send-failed');}
    };
    const timer=setTimeout(()=>this.fail('ring-timeout'),total+RING.timeoutMs);
    signal?.addEventListener('abort',abort,{once:true});
    try{
      try{this.send({type:'set_ring_frames',...command,
        frames:frames.map(f=>f.leds.map(c=>c.slice(1).toLowerCase()).join('')+','+f.durationMs).join(';'),
        brightness:String(brightness)});}
      catch{this.fail('ring-send-failed');}
      return await pending.promise;
    }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
  }
  async setExpression(expression, {signal} = {}) {
    signal?.throwIfAborted();
    if (!EXPRESSIONS.includes(expression)) throw fault('expression-invalid');
    if (!this.expressionSupported) throw fault('expression-unsupported');
    if (this.phase !== 'active') throw fault('not-ready');
    if (this.expressionRequest) throw fault('expression-busy');
    const pending = deferred(); const id = nonce();
    this.expressionRequest = {...pending,id,expression};
    const abort = () => this.fail('expression-cancelled');
    const timer = setTimeout(() => this.fail('expression-timeout'), this.timeoutMs);
    signal?.addEventListener('abort',abort,{once:true});
    try {
      this.send({type:'set_expression',boot_id:this.bootId,epoch:String(this.epoch),request_id:id,expression});
      return await pending.promise;
    } catch (error) {if(this.expressionRequest?.id===id)this.fail('expression-failed');throw error;
    } finally {clearTimeout(timer);signal?.removeEventListener('abort',abort);}
  }
  async playbackFence(action, signal) {
    signal?.throwIfAborted();
    if (!this.playbackSupported) throw fault('playback-unsupported');
    if (this.phase !== 'active' || this.playback) throw fault('not-ready');
    const pending = deferred(); const id = nonce();
    const boundary = this.outputSequence;
    this.playback = { ...pending, id, boundary, response: action === 'drain_output' ? 'output_drained' : 'output_interrupted' };
    if (action === 'interrupt_output') this.clearOutput(fault('playback-interrupted'));
    const abort = () => this.fail('cancelled');
    const timer = setTimeout(() => this.fail('playback-timeout'), this.timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      this.send({ type: action, request_id: id, boot_id: this.bootId, epoch: String(this.epoch), next_sequence: String(boundary) });
      return await pending.promise;
    } catch (error) {
      // Stop legitimately supersedes a pending playback operation, preserving
      // the socket until its stronger resources_stopped receipt arrives.
      if (error.code !== 'stopped') this.fail('playback-failed');
      throw error;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  drainOutput({ signal } = {}) { return this.playbackFence('drain_output', signal); }
  interruptOutput({ signal } = {}) { return this.playbackFence('interrupt_output', signal); }
  // Any discontinuity retires what is queued: the consumer resets on the new
  // generation and resumes from the next frame. The link itself stays active.
  dropInput(missing, reason) {
    const count = missing + this.input.length;
    this.input.length = 0;
    this.inputGeneration++;
    this.voiceDiagnostics?.inputGap(count, reason);
  }
  async readInput({ signal } = {}) {
    return (await this.readInputBatch({ signal, limit: 1 })).frames[0];
  }
  async readInputBatch({ signal, limit = inputBatchLimit } = {}) {
    signal?.throwIfAborted();
    if (this.phase !== 'active') throw fault('not-active');
    if (this.reader) throw fault('reader-busy');
    if (!Number.isInteger(limit) || limit < 1 || limit > inputBatchLimit) throw fault('input-batch-invalid');
    let entries, generation;
    if (this.input.length) {
      entries = this.input.splice(0, limit);
      generation = this.inputGeneration;
    }
    else {
      const pending = deferred(); this.reader = pending;
      const abort = () => { if (this.reader === pending) this.reader = null; pending.reject(fault('cancelled')); };
      signal?.addEventListener('abort', abort, { once: true });
      try { ({ entries, generation } = await pending.promise); } finally { signal?.removeEventListener('abort', abort); }
    }
    const readAt = performance.now();
    for (const entry of entries) this.voiceDiagnostics?.inputRead(readAt - entry.receivedAt);
    return { frames: entries.map(entry => entry.frame), generation };
  }
  async sendOutput(pcm) {
    if (this.phase !== 'active') throw fault('not-active');
    if (this.playback) throw fault('playback-busy');
    if (this.outputs.size >= AUDIO.outputWindowFrames) throw fault('backpressure');
    if (this.outputSequence === MAX_U64) { this.fail('sequence-exhausted'); throw this.failure; }
    const sequence = this.outputSequence;
    const bytes = encodePcm({ kind: 2, epoch: this.epoch, sequence, pcm });
    const pending = deferred();
    pending.timer = setTimeout(() => this.fail('output-timeout'), this.timeoutMs);
    this.outputs.set(sequence, pending); ++this.outputSequence;
    try { this.send(bytes); }
    catch (error) { this.fail('send-failed'); throw error; }
    // Stop deliberately rejects outstanding audio; that is not a socket error.
    return pending.promise;
  }
  close({graceful = false} = {}) {
    this.fail('closed',graceful&&this.phase==='idle');
    return this.socket.closed;
  }
}

/** Explicitly started, single-pair listener. Constructor does not read files or listen. */
export function createAgentTransport({ pairing, deviceId, timeoutMs = 10000, heartbeatMs = 4000,
  recoverInput = false, voiceDiagnostics }) {
  if (!/^[0-9a-f]{12}$/.test(deviceId) || pairing?.version !== 1 ||
      !/^[0-9a-f]{32}$/.test(pairing.record?.pair_id ?? '') ||
      !/^[0-9a-f]{64}$/.test(pairing.record?.local_token ?? '') ||
      !Number.isInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 20000 ||
      !Number.isInteger(heartbeatMs) || heartbeatMs < 10 || heartbeatMs >= timeoutMs)
    throw new TypeError('Invalid agent transport configuration');
  const endpoint = pairing.record.local_url === '' ? undefined : localAddress(pairing.record.local_url, 'wss:');
  const pairId = pairing.record.pair_id;
  const localToken = pairing.record.local_token;
  const authorization = Buffer.from(`Bearer ${localToken}`);
  const hostIdentity = { cert: pairing.host?.cert, key: pairing.host?.key };
  if (typeof hostIdentity.cert !== 'string' || typeof hostIdentity.key !== 'string') throw new TypeError('Missing Host identity');
  const events = new EventEmitter(); const sockets = new Set();
  let server, wss, active, visible, started = false, closed = false, closing, listening;
  let byteWire, relayAttempt;
  const busy = () => active || byteWire || relayAttempt;
  function attach(wire) {
    const connection = new AgentConnection(wire, { deviceId, pairId, timeoutMs, heartbeatMs, recoverInput, voiceDiagnostics });
    active = connection;
    connection.on('disconnect', error => {
      if (active === connection) { active = visible = undefined; events.emit('disconnect', error); }
    });
    connection.ready.then(() => {
      if (active === connection && !closed) { visible = connection; events.emit('connection', connection); }
    }, () => {}).catch(() => connection.fail('consumer-failed'));
    return connection.ready;
  }
  function attachByte(stream, createWire) {
    const wire=createWire(stream,{deviceId,pairId,localToken});
    byteWire=wire;
    wire.closed.then(()=>{byteWire=undefined;});
    return attach(wire);
  }
  const result = {
    events,
    get connection() { return visible; },
    async attachUsb(stream) {
      if (closed) throw fault('closed');
      if (busy()) throw fault('connection-busy');
      return attachByte(stream,createUsbAgentWire);
    },
    async attachRelay({signal,...config}={}) {
      if(closed)throw fault('closed');
      if(busy())throw fault('connection-busy');
      signal?.throwIfAborted();
      const abort=new AbortController();
      const cancel=()=>abort.abort();
      signal?.addEventListener('abort',cancel,{once:true});
      const joiningSignal=abort.signal;
      const attempt={abort};relayAttempt=attempt;
      attempt.done=(async ()=>{
        const stream=await openAgentRelayStream({...config,role:'host',signal:joiningSignal});
        try {
          if(closed)throw fault('closed');
          joiningSignal.throwIfAborted();
          return await attachByte(stream,createRelayAgentWire);
        } catch(error) {
          await new Promise(resolve=>{
            if(stream.closed){resolve();return;}
            stream.once('close',resolve);stream.destroy();
          });
          throw error;
        }
      })();
      try{return await attempt.done;}
      finally{signal?.removeEventListener('abort',cancel);relayAttempt=undefined;}
    },
    async listen({ host = endpoint?.hostname, port = Number(endpoint?.port || 443) } = {}) {
      if (closed || started) throw fault('already-started');
      if (!endpoint) throw fault('lan-address-required');
      if (host !== '127.0.0.1') localAddress(`wss://${host}/`, 'wss:');
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError('Invalid listen port');
      started = true;
      server = https.createServer({ ...hostIdentity, minVersion: 'TLSv1.2', handshakeTimeout: 5000,
        maxHeaderSize: 4096, requestTimeout: 5000, headersTimeout: 5000 }, (_request, response) => {
        response.writeHead(404, { Connection: 'close' }); response.end();
      });
      server.maxConnections = 8;
      server.on('connection', socket => {
        sockets.add(socket); socket.setTimeout(15000, () => socket.destroy());
        socket.on('error', () => {});
        socket.on('close', () => sockets.delete(socket));
      });
      server.on('clientError', (_error, socket) => socket.destroy());
      server.on('tlsClientError', () => {});
      server.on('error', () => active?.fail('listener-failed'));
      wss = new WebSocketServer({ noServer: true, maxPayload: AUDIO.maxMessageBytes,
        maxFragments: 32, maxBufferedChunks: 64, perMessageDeflate: false,
        handleProtocols: protocols => protocols.has('sion-agent-v1') ? 'sion-agent-v1' : false });
      server.on('upgrade', (request, socket, head) => {
        const supplied = Buffer.from(request.headers.authorization ?? '');
        const authorized = supplied.length === authorization.length && timingSafeEqual(supplied, authorization);
        if (closed || !authorized || request.method !== 'GET' || request.url !== endpoint.pathname ||
            request.headers.origin !== undefined || request.headers['x-sion-pair-id'] !== pairId ||
            request.headers['x-sion-device-id'] !== deviceId ||
            request.headers['sec-websocket-protocol'] !== 'sion-agent-v1') {
          socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return;
        }
        if (busy()) { socket.end('HTTP/1.1 409 Conflict\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return; }
        wss.handleUpgrade(request, socket, head, attach);
      });
      try {
        listening = new Promise((resolve, reject) => {
          const error = cause => {
            cleanup();
            const codes = {
              EADDRNOTAVAIL: 'listen-address-unavailable',
              EADDRINUSE: 'listen-port-in-use',
            };
            reject(fault(codes[cause?.code] ?? 'listen-failed'));
          };
          const ready = () => { cleanup(); resolve(); };
          const cleanup = () => { server.off('error', error); server.off('listening', ready); };
          server.once('error', error); server.once('listening', ready); server.listen(port, host);
        });
        await listening;
        if (closed) throw fault('closed');
        return { address: server.address().address, port: server.address().port };
      } catch (error) { await result.close(); throw error; }
    },
    close() {
      if (closing) return closing;
      const byteClosed = byteWire?.closed;
      const joining = relayAttempt;
      closed = true; active?.close();
      joining?.abort.abort();
      closing = (async () => {
        // close() may race the asynchronous bind; wait for that attempt first.
        await listening?.catch(() => {});
        for (const socket of sockets) socket.destroy();
        await Promise.all([
          new Promise(resolve => server ? server.close(() => resolve()) : resolve()),
          new Promise(resolve => wss ? wss.close(() => resolve()) : resolve()),
          byteClosed,
          joining?.done.catch(()=>{}),
        ]);
      })();
      return closing;
    },
  };
  return result;
}
