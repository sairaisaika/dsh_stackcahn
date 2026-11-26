import {headTouchKinds} from './agent-protocol.mjs';
import {describeBody} from './body-description.mjs';

/** Project negotiated and current device facts, without querying hardware. */
const ids = ['audio', 'playbackFence', 'expression', 'camera', 'motion', 'ring'];
const notExposed = ['ambientSensors', 'inertialSensors', 'batteryAndClock', 'touchAndButtons',
  'infrared', 'nfc', 'removableStorage', 'grove', 'bluetooth', 'factoryApps', 'customWake'];
const readingStates = ['waiting', 'stale', 'unavailable', 'current'];
const batteryDirections = ['charging', 'discharging', 'idle'];
const availability = ['supported', 'unsupported', 'unknown'];
const permissions = ['allowed', 'disabled', 'unknown', 'not-applicable'];
const conditions = ['not-available', 'needs-voice', 'restart-required', 'ready', 'permission-disabled',
  'permission-unknown', 'busy', 'fault', 'avatar-page-required', 'attachment-service-unavailable'];
const replyModes = ['inactive', 'spoken', 'caption-only'];
const captionChannels = ['unknown', 'requested', 'not-requested'];
const voicePhases = ['stopped', 'starting', 'listening', 'connecting', 'active', 'stopping', 'fault', 'disposed'];

export const capabilityReportSchema = {
  type:'object',additionalProperties:false,properties:{
    version:{type:'integer',enum:[1],required:true},
    voicePhase:{type:'string',enum:voicePhases,required:true},
    features:{type:'object',required:true,additionalProperties:false,properties:Object.fromEntries(ids.map(id=>[id,{
      type:'object',required:true,additionalProperties:false,properties:{
        availability:{type:'string',enum:availability,required:true},
        // motion 2: keyframes, hold/limp torque and servo reads (stackchan_servo_*).
        version:{type:'integer',enum:[1,2]},
        permission:{type:'string',enum:permissions,required:true},
        condition:{type:'string',enum:conditions,required:true},
      },
    }]))},
    conversation:{type:'object',additionalProperties:false,properties:{
      replyMode:{type:'string',enum:replyModes,required:true},
      captionChannel:{type:'string',enum:captionChannels,required:true},
    }},
    battery:{type:'object',additionalProperties:false,properties:{
      version:{type:'integer',enum:[1],required:true},
      status:{type:'string',enum:readingStates,required:true},
      percent:{type:'integer',description:'Battery percent between 0 and 100 when the reading is current.'},
      direction:{type:'string',enum:batteryDirections},
    }},
    ambient:{type:'object',additionalProperties:false,properties:{
      version:{type:'integer',enum:[1],required:true},
      status:{type:'string',enum:readingStates,required:true},
      light:{type:'object',additionalProperties:false,properties:{
        channel0:{type:'integer',required:true,description:'LTR553 broadband raw count (0–65535).'},
        channel1:{type:'integer',required:true,description:'LTR553 infrared raw count (0–65535).'},
      }},
      proximityRaw:{type:'integer',description:'LTR553 reflected signal count (0–2047). No distance unit.'},
    }},
    headTouch:{type:'object',additionalProperties:false,properties:{
      version:{type:'integer',enum:[1,2],required:true},
      status:{type:'string',enum:readingStates,required:true},
      levels:{type:'array',items:{type:'integer',enum:[0,1,2,3]},
        description:'Current Si12T channels 1, 2, and 3 in order. Zero means idle, 1–3 are increasing touch levels.'},
      recentGestures:{type:'array',description:'Up to four recent gestures in the current connection epoch, oldest first.',
        items:{type:'object',additionalProperties:false,properties:{
          sequence:{type:'integer',required:true,description:'Increasing event number within the current audio session.'},
          kind:{type:'string',enum:headTouchKinds,required:true},
          durationMs:{type:'integer',required:true},
          peak:{type:'integer',enum:[1,2,3],required:true},
          ageMs:{type:'integer',required:true,description:'Approximate milliseconds since the gesture finished.'},
        }}},
    }},
    imu:{type:'object',additionalProperties:false,properties:{
      version:{type:'integer',enum:[1],required:true},
      status:{type:'string',enum:readingStates,required:true},
      accelerationMg:{type:'array',items:{type:'integer'},description:'Acceleration including gravity along the BMI270 chip X, Y and Z axes, in milli-g.'},
      angularVelocityMdps:{type:'array',items:{type:'integer'},description:'Angular velocity around the BMI270 chip X, Y and Z axes, in millidegrees per second.'},
    }},
    notExposed:{type:'array',required:true,items:{type:'string',enum:[...notExposed,'clock','screenTouchAndButtons','magnetometer','buttons']}},
    // Parts, units, ranges, directions and measured facts (body-description.mjs).
    body:{type:'json'},
  },
};

function activeCondition(snapshot, deviceActive) {
  if(snapshot.pendingChanges)return 'restart-required';
  return snapshot.phase==='active'&&deviceActive?'ready':'needs-voice';
}

function condition(id, support, state, gate, inFlight) {
  if(!support)return 'not-available';
  if(state?.status==='current'&&state.phase==='fault')return 'fault';
  if(gate!=='ready')return gate;
  if(id==='expression')return 'avatar-page-required';
  if(id==='audio'||id==='playbackFence')return 'ready';
  if(state?.status!=='current')return 'permission-unknown';
  if(state.permission==='disabled')return 'permission-disabled';
  if(state.permission!=='allowed')return 'permission-unknown';
  if(id==='camera'&&!state.attachmentsAvailable)return 'attachment-service-unavailable';
  if(inFlight||state.busy||state.phase!=='idle'||['capturing','importing','cancelling'].includes(state.operation))return 'busy';
  return 'ready';
}

export function describeDeviceCapabilities(negotiated, snapshot, {captionOnly=false}={}) {
  const gate=activeCondition(snapshot,negotiated?.active);
  const active=snapshot.phase==='active'&&negotiated?.active===true;
  const replyMode=active?(captionOnly?'caption-only':'spoken'):'inactive';
  const captionChannel=negotiated?.captionRequested===true?'requested':
    negotiated?.captionRequested===false?'not-requested':'unknown';
  const features={};
  for(const id of ids){
    const version=negotiated?.versions[id];
    const supported=version===1||(id==='motion'&&version===2);
    const state=snapshot[id];
    const permission=id==='expression'||id==='playbackFence'?'not-applicable':
      supported&&state?.status==='current'?state.permission:'unknown';
    features[id]={
      availability:negotiated?(supported?'supported':'unsupported'):'unknown',
      ...(supported?{version}:{}),
      permission,
      condition:id==='playbackFence'&&gate==='ready'&&replyMode==='caption-only'?'not-available':
        condition(id,supported,state,gate,negotiated?.inFlight?.[id]),
    };
  }
  const batterySupported=negotiated?.versions.battery===1;
  const ambientSupported=negotiated?.versions.ambient===1;
  const touchVersion=negotiated?.versions.headTouch;
  const headTouchSupported=touchVersion===1||touchVersion===2;
  const imuSupported=negotiated?.versions.imu===1;
  const battery=gate==='ready'&&snapshot.battery?snapshot.battery:{version:1,status:'waiting'};
  const ambient=gate==='ready'&&snapshot.ambient?snapshot.ambient:{version:1,status:'waiting'};
  const headTouch=gate==='ready'&&snapshot.headTouch?snapshot.headTouch:{version:touchVersion,status:'waiting'};
  const imu=gate==='ready'&&snapshot.imu?snapshot.imu:{version:1,status:'waiting'};
  return {version:1,voicePhase:snapshot.phase,features,conversation:{replyMode,captionChannel},
    ...(batterySupported?{battery}:{}),
    ...(ambientSupported?{ambient}:{}),
    ...(headTouchSupported?{headTouch}:{}),
    ...(imuSupported?{imu}:{}),
    notExposed:notExposed.filter(id=>(!ambientSupported||id!=='ambientSensors')&&
        !(negotiated?.versions?.infrared&&id==='infrared')&&!(negotiated?.versions?.nfc&&id==='nfc'))
      .map(id=>batterySupported&&id==='batteryAndClock'?'clock':
        headTouchSupported&&id==='touchAndButtons'?(negotiated?.versions?.screenTouch?'buttons':'screenTouchAndButtons'):
          imuSupported&&id==='inertialSensors'?'magnetometer':id),
    ...(negotiated?{body:describeBody(negotiated.versions)}:{})};
}
