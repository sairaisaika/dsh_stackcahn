import {defineTool,ToolArgsError} from '@deepseek-ai/dsh-tools';
import {HarnessError} from '@deepseek-ai/dsh-error';
import {EXPRESSIONS,MOTION,RING,isRingColor} from './agent-protocol.mjs';
import {capabilityReportSchema} from './device-capabilities.mjs';
import {readType2} from './nfc-ndef.mjs';

const failures={
  capability_inactive:'Connect the selected DSH session to Sion before using device tools.',
  capability_session_mismatch:'This session is not the session connected to Sion.',
  capability_session_required:'The calling session could not be identified.',
  voice_restart_required:'Saved voice preferences changed; restart the voice service before using device tools.',
  voice_device_missing:'The authenticated device connection is unavailable.',
  'expression-unsupported':'This device firmware does not advertise expression capability version 1.',
  'expression-busy':'Another expression request is pending. It has not been replaced.',
  'expression-invalid':'The requested expression is unsupported.',
  'not-ready':'The device voice session is not active.',
  stopped:'The voice session stopped before the device result was confirmed.',
  camera_attachments_unavailable:'The DSH image attachment service is unavailable. No image result was published.',
  camera_image_invalid:'The camera data could not be fully decoded within the declared image limits.',
  camera_attachment_failed:'DSH could not save the camera image. No image result was published.',
  camera_session_changed:'The device session changed while preparing the image. The old result was discarded.',
  'camera-unsupported':'This device firmware does not advertise camera capability version 1.',
  'camera-busy':'A camera capture or image import is still pending. It has not been replaced.',
  'camera-disabled':'Enable camera permission on the device before requesting a photo.',
  'camera-cancelled':'The image was cancelled. No image result was published.',
  'camera-unavailable':'The device camera is unavailable.',
  'camera-close':'The device could not confirm camera release. No image result was published.',
  'camera-timeout':'The camera operation timed out. No image result was published.',
  'camera-memory':'The device could not allocate the bounded camera buffer.',
  'camera-open':'The device camera could not be opened.',
  'camera-capture':'The device could not capture the requested frame.',
  'motion-disabled':'Enable Motion on the device before requesting a head movement.',
  'motion-unsupported':'The connected firmware does not advertise motion capability version 1.',
  'motion-invalid':'The target is outside the allowed motion range.',
  'motion-busy':'A movement or drive release is still in progress.',
  'motion-release-unconfirmed':'The device could not confirm both drives were disabled. Check the device before requesting another movement.',
  'motion-cancelled':'The movement request was cancelled.',
  'motion-open':'The head drive did not start: the DSH firmware on the device could not power up or confirm the servos (a hardware or driver fault, not a permission). The reason is in the device diagnostic record, not visible here. Do not retry repeatedly.',
  'motion-command':'A drive did not accept the movement command.',
  'motion-feedback':'The device could not verify position feedback.',
  'motion-stall':'The head met resistance and the device released it.',
  'motion-timeout':'The movement timed out. Check the device status before retrying.',
  'motion-unavailable':'The motion service is unavailable.',
  'motion-frames-unsupported':'The connected firmware only supports single head moves (stackchan_move_head).',
  'motion-torque':'The drives did not confirm the torque change. Check stackchan_servo_read before trying again.',
  'motion-sense':'The servo registers could not be read.',
  'display-unsupported':'The connected firmware cannot draw on the screen.',
  'display-invalid':'Text: 1..896 UTF-8 bytes; area full/top/bottom; durationMs 100..60000. Image: an absolute path; x, y inside 320x240.',
  'display-unavailable':'The face page is not showing on the device, so nothing can be drawn over it.',
  'display-busy':'Another drawing is still being sent.',
  'wake-not-installed':'The resident body is not set up on this Mac (no resident manifest); see wiki/residency.md.',
  'wake-press-rst':'The robot could not be switched safely right now. Ask the owner to hold the RST button for about 3 s until the green light, then call stackchan_wake again.',
  'wake-port-busy':'The USB port is in use (for example the voice service is attending the factory firmware); stop that and try again.',
  'wake-different-unit':'The connected robot is not the one this body was installed on.',
  'wake-not-from-factory':'The robot is not in the confirmed factory firmware right now (the body may already be starting, or a factory update is pending); nothing was written.',
  'wake-body-missing':'The body firmware is no longer in the robot (a factory update may have replaced it). Reinstalling is a separate step for the owner.',
  'wake-failed':'Switching did not finish cleanly; do not retry, tell the owner.',
  'wake-busy':'A wake is already in progress.',
  'frames-unsupported':'The connected firmware has no frame bank.',
  'display-no-room':'The frame bank is full (4 MiB, about 27 full-screen frames) or the device needs its remaining memory; drop frames first.',
  'display-no-frame':'Nothing complete is stored in that slot.',
  'display-stored':'The device stored the frame instead of showing it.',
  'display-image-unreadable':'macOS could not open that image.',
  'ir-disabled':'The owner has not allowed infrared sending (DSH StackChan settings).',
  'ir-unsupported':'The connected firmware has no infrared.',
  'ir-invalid':'address 0..65535, command 0..255, repeats 0..5.',
  'ir-busy':'Another infrared code is still being sent.',
  'ir-failed':'The device could not transmit the code.',
  'nfc-unsupported':'The connected firmware has no NFC reader.',
  'nfc-invalid':'page 0..255 and count 1..256 with page + count at most 256; or neither, to read the NDEF area.',
  'nfc-busy':'Another NFC read is still running.',
  'nfc-no-card':'No card answered on the NFC reader (it tried for about 2 s). The reader is under the top of the head; ask for the card to lie flat there and try again.',
  'nfc-not-type2':'The card on the reader is not an NFC Forum Type 2 tag (NTAG or Ultralight), so its memory cannot be read here.',
  'nfc-failed':'The card stopped answering during the read (moved away, or a page it protects).',
  'nfc-card-changed':'A different card was on the reader partway through the read.',
  'nfc-no-ndef':'The card has no NFC Forum capability container in page 3, so there is no NDEF area to read.',
  'volume-unsupported':'The connected firmware does not accept volume changes.',
  'volume-invalid':'Volume is an integer 0..100.',
  'sound-invalid':'Give either tones (1..32, each 10+ ms, 20..12000 Hz or 0 for silence, 10 s in all) or an absolute path to a 16-bit PCM WAV of at most 10 s; volume 0..1.',
  'sound-unreadable':'The WAV file could not be read.',
  'sound-unavailable':'Raw recording is not available in this voice setup.',
  'sound-no-input':'No microphone audio arrived during the recording.',
  'recording-invalid':'Pick sensors from imu, headTouch, ambient, battery, power, screenTouch, infrared, nfc; intervalMs 20..10000; durationMs 100..30000.',
  'recording-busy':'Another sensor recording is running on this device.',
  'recording-unsupported':'The connected firmware does not report one of the requested sensors.',
  recording_session_changed:'The device session changed during the recording; its samples were discarded.',
  'motion-rotate':'The yaw servo did not confirm switching into or out of continuous rotation. Check stackchan_servo_read before moving again.',
  'ring-disabled':'Allow the light ring on the device before requesting an effect.',
  'ring-unsupported':'The connected firmware does not advertise light-ring capability version 1.',
  'ring-frames-unsupported':'The connected firmware only supports one colour for the whole ring (stackchan_light_ring).',
  'ring-invalid':'Use a six-digit RGB color and a duration from 250 to 10000 ms.',
  'ring-busy':'A light effect or cleanup is still in progress.',
  'ring-cancelled':'The light effect was cancelled.',
  'ring-open':'The device could not open the light-ring controller.',
  'ring-write':'The device could not confirm the color frame.',
  'ring-release-unconfirmed':'The device could not confirm the black frame and release.',
  'ring-timeout':'The light ring did not confirm completion in time.',
  ring_session_changed:'The selected voice connection changed before the light result returned.',
  motion_session_changed:'The device session changed before the movement result was delivered.',
  'camera-invalid':'The device rejected the captured image as invalid.',
  speech_failed:'The device could not play the speech. It was not delivered.',
};
/** Register only hardware semantics. DSH owns personality, permissions and tool policy. */
export function registerCapabilityTools(ctx,runtime,body=null){
  const status=ctx.tools.register(defineTool({
    name:'stackchan_device_status',
    description:'Read the paired StackChan capability report for any DSH session. Use it when checking what the connected firmware supports, what currently blocks a device tool, or whether this conversation replies aloud or in text. It uses cached state. It does not connect, take a photo, or change device settings.',
    parameters:{},
    output:{schema:capabilityReportSchema,render:(_args,result)=>[{type:'text',text:JSON.stringify(result)}]},
    execute(args,exec){
      if(Object.keys(args).length)throw new ToolArgsError(['no arguments are accepted']);
      exec.signal.throwIfAborted();
      try{return runtime.deviceStatus(exec.agent,exec.signal);}
      catch(error){
        exec.signal.throwIfAborted();
        const code=Object.hasOwn(failures,error?.code)?error.code:'capability_result_unknown';
        throw new HarnessError((failures[code]??'The device capability report is unavailable.')+(error?.owner?` Held by session ${error.owner}.`:''),`stackchan/${code}`);
      }
    },
  }));
  const expression=ctx.tools.register(defineTool({
    name:'stackchan_set_expression',
    description:'Set the visible expression on the paired StackChan. The device must be showing its Avatar page. Does not change personality, move motors, capture images, or speak. An unavailable result means the Avatar page is not visible; do not claim it displayed the expression.',
    parameters:{expression:{type:'string',enum:EXPRESSIONS,required:true,description:'One of the device renderer’s six base expressions.'}},
    output:{schema:{type:'object',additionalProperties:false,properties:{version:{type:'integer',enum:[1],required:true},expression:{type:'string',enum:EXPRESSIONS,required:true},status:{type:'string',enum:['applied','unavailable'],required:true}}},
      render:(_args,result)=>[{type:'text',text:JSON.stringify(result)}]},
    async execute(args,exec){
      if(Object.keys(args).length!==1)throw new ToolArgsError(['only expression is accepted']);
      exec.signal.throwIfAborted();
      try{return await runtime.expression(exec.agent,args.expression,exec.signal);}
      catch(error){
        exec.signal.throwIfAborted();
        const code=Object.hasOwn(failures,error?.code)?error.code:'capability_result_unknown';
        throw new HarnessError((failures[code]??'The device result was not confirmed. The connection may have closed; do not replay the command automatically.')+(error?.owner?` Held by session ${error.owner}.`:''),`stackchan/${code}`);
      }
    },
  }));
  const camera=ctx.tools.register(defineTool({
    name:'stackchan_take_photo',
    description:'Capture one photo from the paired StackChan. Requires camera permission enabled on the device and the DSH attachment service. Returns a durable image attachment using the current model’s normal image support; text-only models cannot see its pixels. The photo is retained by DSH with other attachments. Does not change personality or switch models. Do not automatically repeat failed or cancelled captures.',
    parameters:{},
    output:{schema:{type:'object',additionalProperties:false,properties:{
      version:{type:'integer',enum:[1],required:true},
      attachment:{type:'object',required:true,additionalProperties:false,properties:{
        attachmentId:{type:'string',required:true},mediaType:{type:'string',enum:['image/jpeg','image/png','image/webp','image/gif'],required:true},
        bytes:{type:'integer',required:true},width:{type:'integer',required:true},height:{type:'integer',required:true},name:{type:'string'},
        originalDimensions:{type:'object',additionalProperties:false,properties:{width:{type:'integer',required:true},height:{type:'integer',required:true}}},
      }},
    }},render:(_args,result)=>[{type:'image',attachment:result.attachment}]},
    async execute(args,exec){
      if(Object.keys(args).length)throw new ToolArgsError(['no arguments are accepted']);
      exec.signal.throwIfAborted();
      try{return await runtime.photograph(exec.agent,exec.signal);}
      catch(error){
        exec.signal.throwIfAborted();
        const code=Object.hasOwn(failures,error?.code)?error.code:'capability_result_unknown';
        throw new HarnessError((failures[code]??'The device result was not confirmed. Do not replay the capture automatically.')+(error?.owner?` Held by session ${error.owner}.`:''),`stackchan/${code}`);
      }
    },
  }));
  const attachmentSchema={type:'object',required:true,additionalProperties:false,properties:{
    attachmentId:{type:'string',required:true},mediaType:{type:'string',enum:['image/jpeg','image/png','image/webp','image/gif'],required:true},
    bytes:{type:'integer',required:true},width:{type:'integer',required:true},height:{type:'integer',required:true},name:{type:'string'},
    originalDimensions:{type:'object',additionalProperties:false,properties:{width:{type:'integer',required:true},height:{type:'integer',required:true}}},
  }};
  const burst=ctx.tools.register(defineTool({
    name:'stackchan_take_photos',
    description:'Capture 2 to 5 photos in a row, intervalMs apart (300..10000, default 1000), for seeing change or motion. Each photo is a full 640x480 capture and takes about a second, so the real spacing is at least that. Returns each attachment with the time it was taken (ms from the first). Requires camera permission on the device.',
    parameters:{count:{type:'integer',required:true},intervalMs:{type:'integer'}},
    output:{schema:{type:'object',additionalProperties:false,properties:{
      version:{type:'integer',enum:[1],required:true},
      photos:{type:'array',required:true,items:{type:'object',additionalProperties:false,properties:{
        atMs:{type:'integer',required:true},attachment:attachmentSchema}}},
    }},render:(_args,result)=>result.photos.flatMap(p=>[{type:'text',text:`+${p.atMs} ms`},{type:'image',attachment:p.attachment}])},
    async execute(args,exec){
      if(Object.keys(args).some(key=>!['count','intervalMs'].includes(key)))throw new ToolArgsError(['only count and intervalMs are accepted']);
      const count=args.count,interval=args.intervalMs??1000;
      if(!Number.isInteger(count)||count<2||count>5||!Number.isInteger(interval)||interval<300||interval>10000)
        throw new ToolArgsError(['count 2..5, intervalMs 300..10000']);
      exec.signal.throwIfAborted();
      const photos=[];const start=performance.now();
      try{
        for(let i=0;i<count;i++){
          const due=start+i*interval-performance.now();
          if(due>0)await new Promise((resolve,reject)=>{const t=setTimeout(resolve,due);
            exec.signal.addEventListener('abort',()=>{clearTimeout(t);reject(exec.signal.reason);},{once:true});});
          const at=Math.round(performance.now()-start);
          const shot=await runtime.photograph(exec.agent,exec.signal);
          photos.push({atMs:at,attachment:shot.attachment});
        }
        return {version:1,photos};
      }catch(error){
        exec.signal.throwIfAborted();
        const code=Object.hasOwn(failures,error?.code)?error.code:'capability_result_unknown';
        throw new HarnessError((failures[code]??'A capture was not confirmed.')+` ${photos.length} of ${count} photos were taken before it.`,`stackchan/${code}`);
      }
    },
  }));
  const motion=ctx.tools.register(defineTool({
    name:'stackchan_move_head',
    description:'Move the paired StackChan head to one calibrated yaw and pitch position. Requires Motion permission on the device. One move at a time. Reports the last position measured before drive release. Do not repeat a failed or cancelled movement automatically.',
    parameters:{
      yaw:{type:'integer',required:true,description:'Yaw in tenths of a degree, from -1280 to 1280.'},
      pitch:{type:'integer',required:true,description:'Pitch in tenths of a degree, from 50 to 650 (higher presses the head against the body).'},
      durationMs:{type:'integer',description:'Requested movement duration in milliseconds, from 100 to 3000. Defaults to 1000.'},
    },
    output:{schema:{type:'object',additionalProperties:false,properties:{
      version:{type:'integer',enum:[1],required:true},status:{type:'string',enum:['reached'],required:true},
      observed:{type:'object',required:true,additionalProperties:false,properties:{
        yaw:{type:'integer',required:true},pitch:{type:'integer',required:true},
      }},
    }},render:(_args,result)=>[{type:'text',text:JSON.stringify(result)}]},
    async execute(args,exec){
      if(Object.keys(args).some(key=>!['yaw','pitch','durationMs'].includes(key)))
        throw new ToolArgsError(['only yaw, pitch and durationMs are accepted']);
      exec.signal.throwIfAborted();
      try{return await runtime.moveHead(exec.agent,args,exec.signal);}
      catch(error){
        exec.signal.throwIfAborted();
        const code=Object.hasOwn(failures,error?.code)?error.code:'capability_result_unknown';
        throw new HarnessError((failures[code]??'The device movement result was not confirmed. Check the device before trying again.')+(error?.owner?` Held by session ${error.owner}.`:''),`stackchan/${code}`);
      }
    },
  }));
  // Motion v2: the servos as parts, without built-in gestures. Angles are tenths of a degree in the
  // servo frame (yaw positive = the robot's own right, the viewer's left; pitch larger = head up).
  const motionError=(error,exec,fallback)=>{
    exec.signal.throwIfAborted();
    const code=Object.hasOwn(failures,error?.code)?error.code:'capability_result_unknown';
    const where=error?.observed?` The head stopped at yaw ${error.observed.yaw}, pitch ${error.observed.pitch} (tenths of a degree).`:'';
    return new HarnessError((failures[code]??fallback)+where+(error?.owner?` Held by session ${error.owner}.`:''),`stackchan/${code}`);
  };
  const reachedOutput={schema:{type:'object',additionalProperties:false,properties:{
    version:{type:'integer',enum:[1],required:true},status:{type:'string',enum:['reached'],required:true},
    holding:{type:'boolean',required:true},
    observed:{type:'object',additionalProperties:false,properties:{yaw:{type:'integer',required:true},pitch:{type:'integer',required:true}}},
  }},render:(_args,result)=>[{type:'text',text:JSON.stringify(result)}]};
  const servoMove=ctx.tools.register(defineTool({
    name:'stackchan_servo_move',
    description:`Move the head through 1 to ${MOTION.framesMax} keyframes in one call, powering the servos once. Each frame is a target yaw and pitch (tenths of a degree; yaw ${MOTION.yawMin}..${MOTION.yawMax}, positive turns to the robot's own right (the viewer's left); pitch ${MOTION.pitchMin}..${MOTION.pitchMax}, larger is head up) reached in durationMs (${MOTION.durationMin}..${MOTION.durationMax}). After the last frame the drives either release (holdMs 0) or stay powered for holdMs (up to ${MOTION.holdMaxMs}) with torque on (torque "hold": the head keeps its pose) or off (torque "limp": it can be moved by hand and still read). A later move, torque change or read replaces a hold without powering down. Stops with motion-stall if the head stops short of a frame (for example pressed against something). Needs Motion permission on the device.`,
    parameters:{
      frames:{type:'array',required:true,items:{type:'object',additionalProperties:false,properties:{
        yaw:{type:'integer',required:true},pitch:{type:'integer',required:true},durationMs:{type:'integer'}}}},
      holdMs:{type:'integer',description:'Stay powered this long after the last frame. Default 0.'},
      torque:{type:'string',enum:['hold','limp'],description:'Torque while holding. Default hold.'},
    },
    output:reachedOutput,
    async execute(args,exec){
      if(Object.keys(args).some(key=>!['frames','holdMs','torque'].includes(key)))
        throw new ToolArgsError(['only frames, holdMs and torque are accepted']);
      exec.signal.throwIfAborted();
      try{return await runtime.moveFrames(exec.agent,{frames:args.frames,holdMs:args.holdMs??0,torque:args.torque??'hold'},exec.signal);}
      catch(error){throw motionError(error,exec,'The movement result was not confirmed. Check stackchan_servo_read before trying again.');}
    },
  }));
  const servoTorque=ctx.tools.register(defineTool({
    name:'stackchan_servo_torque',
    description:`Change the head servos' torque without moving them. "hold" keeps the present pose, "limp" turns the drives off but keeps them powered so the head can be moved by hand and still read; both last holdMs (1..${MOTION.holdMaxMs}). "release" turns the drives and their power off now (holdMs 0). Needs Motion permission on the device.`,
    parameters:{
      torque:{type:'string',required:true,enum:['hold','limp','release']},
      holdMs:{type:'integer',description:'Required for hold and limp; 0 or absent for release.'},
    },
    output:reachedOutput,
    async execute(args,exec){
      if(Object.keys(args).some(key=>!['torque','holdMs'].includes(key)))
        throw new ToolArgsError(['only torque and holdMs are accepted']);
      exec.signal.throwIfAborted();
      try{return await runtime.setTorque(exec.agent,{torque:args.torque,holdMs:args.holdMs??0},exec.signal);}
      catch(error){throw motionError(error,exec,'The torque change was not confirmed. Check stackchan_servo_read.');}
    },
  }));
  const servoStream=ctx.tools.register(defineTool({
    name:'stackchan_servo_stream',
    description:'Play a timed series of head targets and stored frames in real time: each point {atMs, yaw, pitch, frame} (yaw and pitch together, frame a frame-bank slot from stackchan_frame_store, or both) is sent at its time (from 0, at least 20 ms apart, up to 20 s and 400 points) without waiting to arrive, so the head follows a path rather than stopping at each point (stackchan_servo_move stops at every frame). Torque is held for the run (holdMs, default the length plus 1.5 s), then released when that ends. Returns how many targets were sent and rejected.',
    parameters:{
      points:{type:'array',required:true,items:{type:'object',additionalProperties:false,properties:{
        atMs:{type:'integer',required:true},yaw:{type:'integer'},pitch:{type:'integer'},frame:{type:'integer'}}}},
      holdMs:{type:'integer'},
    },
    output:{schema:{type:'object',additionalProperties:false,properties:{
      version:{type:'integer',enum:[1],required:true},sent:{type:'integer',required:true},rejected:{type:'integer',required:true},
      lastRejection:{type:'string'},holdingMs:{type:'integer',required:true},
      frames:{type:'object',additionalProperties:false,properties:{sent:{type:'integer',required:true},shown:{type:'integer',required:true},
        failed:{type:'integer',required:true},skipped:{type:'integer',required:true},lastFailure:{type:'string'},maxLateMs:{type:'integer',required:true},
        roundTripMs:{type:'object',additionalProperties:false,properties:{median:{type:'number',required:true},max:{type:'number',required:true}}}}}}},
      render:(_args,result)=>[{type:'text',text:JSON.stringify(result)}]},
    async execute(args,exec){
      if(Object.keys(args).some(key=>!['points','holdMs'].includes(key)))throw new ToolArgsError(['only points and holdMs are accepted']);
      exec.signal.throwIfAborted();
      try{return await runtime.streamSetpoints(exec.agent,{points:args.points,holdMs:args.holdMs},exec.signal);}
      catch(error){throw motionError(error,exec,'The stream did not complete.');}
    },
  }));
  const servoRotate=ctx.tools.register(defineTool({
    name:'stackchan_servo_rotate',
    description:`Turn the head round continuously on the yaw axis, which has no end stop. velocity is the servo's drive duty from -${MOTION.rotateVelocityMax} to ${MOTION.rotateVelocityMax} (not 0; positive turns to the robot's own right, like positive yaw; the same duty does not give the same speed in both directions, so read the angle afterwards), for durationMs (${MOTION.rotateMinMs}..${MOTION.rotateMaxMs}). Afterwards the servo is back in position mode and either released (holdMs 0) or held/limp for holdMs. While turning, the yaw angle is not tracked; read it afterwards (part of a turn is outside the sensor's range). Stops with motion-stall if the head is blocked. Needs Motion permission on the device.`,
    parameters:{
      velocity:{type:'integer',required:true},durationMs:{type:'integer',required:true},
      holdMs:{type:'integer'},torque:{type:'string',enum:['hold','limp']},
    },
    output:reachedOutput,
    async execute(args,exec){
      if(Object.keys(args).some(key=>!['velocity','durationMs','holdMs','torque'].includes(key)))
        throw new ToolArgsError(['only velocity, durationMs, holdMs and torque are accepted']);
      exec.signal.throwIfAborted();
      try{return await runtime.rotateYaw(exec.agent,{velocity:args.velocity,durationMs:args.durationMs,holdMs:args.holdMs??0,torque:args.torque??'hold'},exec.signal);}
      catch(error){throw motionError(error,exec,'The rotation result was not confirmed. Check stackchan_servo_read.');}
    },
  }));
  const recordSensors=ctx.tools.register(defineTool({
    name:'stackchan_sensor_record',
    description:'Record raw sensor reports for a short window and return them with timestamps (ms from the start). Sensors: imu (accelerationMg, angularVelocityMdps and raw counts; the IMU is in the head, +z out of the face, +y toward the top of the screen; magnetometerRaw when the BMM150 answers: raw uncompensated counts, axes and scale not yet calibrated), headTouch (three capacitive channel levels 0..3), ambient (two light channels and raw proximity), battery (percent and direction), power (battery bus voltage busMv and current currentMa from the INA226 monitor; which sign means charging is not yet confirmed), screenTouch (events: phase down/move/up and x,y in pixels on the 320x240 screen, sent as they happen), infrared (events: NEC codes the receiver heard, address and command, as they happen), nfc (events: an ISO14443A card arriving at the NFC reader (phase present) or leaving it (phase removed) with its uid as lowercase hex (4, 7 or 10 bytes), atqa and sak as received; the reader looks about four times a second while a conversation is active, and nothing on the card is read beyond that). intervalMs is the requested report interval; each sensor has its own fastest rate (imu 20 ms, headTouch 50 ms, power 100 ms, ambient 750 ms, battery 1000 ms) and the result says which interval each actually used. Reports can be dropped when the link is busy, so count the samples rather than assuming a fixed rate. Rates return to the defaults afterwards.',
    parameters:{
      sensors:{type:'array',required:true,items:{type:'string',enum:['imu','headTouch','ambient','battery','power','screenTouch','infrared','nfc']}},
      intervalMs:{type:'integer',required:true},durationMs:{type:'integer',required:true},
    },
    output:{schema:{type:'object',additionalProperties:false,properties:{
      version:{type:'integer',enum:[1],required:true},durationMs:{type:'integer',required:true},
      intervalMs:{type:'object',required:true,additionalProperties:false,properties:{
        imu:{type:'integer'},headTouch:{type:'integer'},ambient:{type:'integer'},battery:{type:'integer'},power:{type:'integer'}}},
      truncated:{type:'boolean',required:true},
      samples:{type:'array',required:true,items:{type:'object',additionalProperties:false,properties:{
        t:{type:'integer',required:true},sensor:{type:'string',required:true},value:{type:'json',required:true}}}},
    }},render:(_args,result)=>[{type:'text',text:JSON.stringify(result)}]},
    async execute(args,exec){
      if(Object.keys(args).some(key=>!['sensors','intervalMs','durationMs'].includes(key)))
        throw new ToolArgsError(['only sensors, intervalMs and durationMs are accepted']);
      exec.signal.throwIfAborted();
      try{return await runtime.recordSensors(exec.agent,{sensors:args.sensors,intervalMs:args.intervalMs,durationMs:args.durationMs},exec.signal);}
      catch(error){throw motionError(error,exec,'The sensor recording did not complete.');}
    },
  }));
  const axisOutput={type:'object',required:true,additionalProperties:false,properties:Object.fromEntries(
    ['angle','position','speed','load','voltage','temperature','current'].map(k=>[k,{type:'integer',required:true}])
      .concat(['moving','torque','inRange'].map(k=>[k,{type:'boolean',required:true}])))};
  const servoRead=ctx.tools.register(defineTool({
    name:'stackchan_servo_read',
    description:'Read both head servos once without commanding anything: angle (tenths of a degree in the servo frame), position (raw 0..1000 steps), speed, load and current (signed raw counts), voltage (0.1 V), temperature (degrees C), whether it is moving, whether torque is on, and inRange (false when the yaw servo, which turns all the way round, is in the roughly 47-degree span its sensor cannot measure; angle is then not a position). If a hold is running it continues; otherwise the servos are powered only for the read. Needs Motion permission on the device.',
    parameters:{},
    output:{schema:{type:'object',additionalProperties:false,properties:{
      version:{type:'integer',enum:[1],required:true},status:{type:'string',enum:['read'],required:true},
      holding:{type:'boolean',required:true},yaw:axisOutput,pitch:axisOutput,
    }},render:(_args,result)=>[{type:'text',text:JSON.stringify(result)}]},
    async execute(args,exec){
      if(Object.keys(args).length)throw new ToolArgsError(['no arguments are accepted']);
      exec.signal.throwIfAborted();
      try{return await runtime.readServos(exec.agent,exec.signal);}
      catch(error){throw motionError(error,exec,'The servo read was not confirmed.');}
    },
  }));
  const ringFrames=ctx.tools.register(defineTool({
    name:'stackchan_light_frames',
    description:'Light the 12 LEDs of the ring individually, as 1 to 8 frames shown one after another. Each frame gives 12 colours as "#RRGGBB" (LEDs 0-5 are one side, 6-11 the other; which physical LED each index is has not been mapped yet) and how long it shows (20..10000 ms; 10 s in all). brightness 0..255 scales every LED (default 255). The ring goes dark afterwards. Needs Light ring permission on the device.',
    parameters:{
      frames:{type:'array',required:true,items:{type:'object',additionalProperties:false,properties:{
        leds:{type:'array',required:true,items:{type:'string'}},durationMs:{type:'integer',required:true}}}},
      brightness:{type:'integer'},
    },
    output:{schema:{type:'object',additionalProperties:false,properties:{
      version:{type:'integer',enum:[1],required:true},status:{type:'string',enum:['completed'],required:true},
    }},render:(_args,result)=>[{type:'text',text:JSON.stringify(result)}]},
    async execute(args,exec){
      if(Object.keys(args).some(key=>!['frames','brightness'].includes(key)))
        throw new ToolArgsError(['only frames and brightness are accepted']);
      exec.signal.throwIfAborted();
      try{return await runtime.setRingFrames(exec.agent,{frames:args.frames,brightness:args.brightness??255},exec.signal);}
      catch(error){
        exec.signal.throwIfAborted();
        const code=Object.hasOwn(failures,error?.code)?error.code:'capability_result_unknown';
        throw new HarnessError((failures[code]??'The light result was not confirmed.')+(error?.owner?` Held by session ${error.owner}.`:''),`stackchan/${code}`);
      }
    },
  }));
  const playSound=ctx.tools.register(defineTool({
    name:'stackchan_play_sound',
    description:'Play a sound through the device speaker, queued with speech: either tones (each {frequencyHz, durationMs, volume 0..1}; frequencyHz 0 is a pause) or wavPath, an absolute path to a 16-bit PCM WAV of at most 10 s (any rate, mixed to mono). volume 0..1 scales the whole sound. How loud a given volume is in the room has not been measured yet.',
    parameters:{
      tones:{type:'array',items:{type:'object',additionalProperties:false,properties:{
        frequencyHz:{type:'number',required:true},durationMs:{type:'integer',required:true},volume:{type:'number'}}}},
      wavPath:{type:'string'},volume:{type:'number'},
    },
    output:{schema:{type:'object',additionalProperties:false,properties:{
      version:{type:'integer',enum:[1],required:true},
      status:{type:'string',enum:['played','not-played-text-mode','interrupted','dropped'],required:true},
      durationMs:{type:'integer',required:true},
    }},render:(_args,result)=>[{type:'text',text:JSON.stringify(result)}]},
    async execute(args,exec){
      if(Object.keys(args).some(key=>!['tones','wavPath','volume'].includes(key)))
        throw new ToolArgsError(['only tones, wavPath and volume are accepted']);
      exec.signal.throwIfAborted();
      try{return await runtime.playSound(exec.agent,{tones:args.tones,wavPath:args.wavPath,volume:args.volume??1},exec.signal);}
      catch(error){throw motionError(error,exec,'The sound was not confirmed as played.');}
    },
  }));
  const recordAudio=ctx.tools.register(defineTool({
    name:'stackchan_record_audio',
    description:'Record both device microphones raw (before echo cancellation and recognition) for durationMs (100..30000) into a private WAV on this Mac (24 kHz, 2 channels). Returns the file path and the peak and RMS level of each channel (fractions of full scale). The voice service keeps listening as usual meanwhile.',
    parameters:{durationMs:{type:'integer',required:true}},
    output:{schema:{type:'object',additionalProperties:false,properties:{
      version:{type:'integer',enum:[1],required:true},path:{type:'string',required:true},durationMs:{type:'integer',required:true},
      sampleRate:{type:'integer',required:true},channels:{type:'integer',required:true},
      peak:{type:'array',required:true,items:{type:'number'}},rms:{type:'array',required:true,items:{type:'number'}},
    }},render:(_args,result)=>[{type:'text',text:JSON.stringify(result)}]},
    async execute(args,exec){
      if(Object.keys(args).some(key=>key!=='durationMs'))throw new ToolArgsError(['only durationMs is accepted']);
      exec.signal.throwIfAborted();
      try{return await runtime.recordAudio(exec.agent,{durationMs:args.durationMs},exec.signal);}
      catch(error){throw motionError(error,exec,'The recording did not complete.');}
    },
  }));
  const displayText=ctx.tools.register(defineTool({
    name:'stackchan_show_text',
    description:'Show text over the face on the device screen (320x240) for durationMs (100..60000, default 10000): area full, top or bottom. Uses the device caption font (Chinese and English). Only while the face page is showing; a page change, Stop or a later drawing replaces it.',
    parameters:{text:{type:'string',required:true},area:{type:'string',enum:['full','top','bottom']},durationMs:{type:'integer'}},
    output:{schema:{type:'object',additionalProperties:false,properties:{
      version:{type:'integer',enum:[1],required:true},status:{type:'string',enum:['shown'],required:true}}},
      render:(_args,result)=>[{type:'text',text:JSON.stringify(result)}]},
    async execute(args,exec){
      if(Object.keys(args).some(key=>!['text','area','durationMs'].includes(key)))throw new ToolArgsError(['only text, area and durationMs are accepted']);
      exec.signal.throwIfAborted();
      try{return await runtime.showText(exec.agent,{text:args.text,area:args.area??'full',durationMs:args.durationMs??10000},exec.signal);}
      catch(error){throw motionError(error,exec,'The text was not confirmed on screen.');}
    },
  }));
  const displayImage=ctx.tools.register(defineTool({
    name:'stackchan_show_image',
    description:'Show a picture over the face: path is an absolute path to any image macOS can open; it is fitted (aspect kept) into the screen from x, y (default 0, 0; the screen is 320x240) or into maxWidth x maxHeight, and shown for durationMs (100..60000, default 10000). A full-screen picture takes a few seconds to send. Only while the face page is showing.',
    parameters:{path:{type:'string',required:true},x:{type:'integer'},y:{type:'integer'},maxWidth:{type:'integer'},maxHeight:{type:'integer'},durationMs:{type:'integer'}},
    output:{schema:{type:'object',additionalProperties:false,properties:{
      version:{type:'integer',enum:[1],required:true},status:{type:'string',enum:['shown'],required:true},
      width:{type:'integer',required:true},height:{type:'integer',required:true}}},
      render:(_args,result)=>[{type:'text',text:JSON.stringify(result)}]},
    async execute(args,exec){
      if(Object.keys(args).some(key=>!['path','x','y','maxWidth','maxHeight','durationMs'].includes(key)))
        throw new ToolArgsError(['only path, x, y, maxWidth, maxHeight and durationMs are accepted']);
      exec.signal.throwIfAborted();
      try{return await runtime.showImage(exec.agent,{path:args.path,x:args.x??0,y:args.y??0,maxWidth:args.maxWidth??320,
        maxHeight:args.maxHeight??240,durationMs:args.durationMs??10000},exec.signal);}
      catch(error){throw motionError(error,exec,'The picture was not confirmed on screen.');}
    },
  }));
  const frameOutput=(properties)=>({schema:{type:'object',additionalProperties:false,properties:{
    version:{type:'integer',enum:[1],required:true},...properties}},render:(_args,result)=>[{type:'text',text:JSON.stringify(result)}]});
  const frameStore=ctx.tools.register(defineTool({
    name:'stackchan_frame_store',
    description:'Store a picture in the device frame bank, slot 0..47, to show later by number with stackchan_frame_show or in a stackchan_servo_stream timeline (switching is fast; sending is not: a full-screen frame takes about 2 s). path is an absolute path to any image macOS can open, fitted (aspect kept) from x, y into maxWidth x maxHeight (screen 320x240). The bank holds 4 MiB (about 27 full-screen frames), keeps frames through Stop and reconnects and empties on a device restart. A slot that already holds the same picture is not sent again (status already). Nothing changes on screen.',
    parameters:{slot:{type:'integer',required:true},path:{type:'string',required:true},x:{type:'integer'},y:{type:'integer'},maxWidth:{type:'integer'},maxHeight:{type:'integer'}},
    output:frameOutput({status:{type:'string',enum:['stored','already'],required:true},slot:{type:'integer',required:true},
      width:{type:'integer',required:true},height:{type:'integer',required:true},x:{type:'integer',required:true},y:{type:'integer',required:true},
      tag:{type:'string',required:true},tookMs:{type:'integer'}}),
    async execute(args,exec){
      if(Object.keys(args).some(key=>!['slot','path','x','y','maxWidth','maxHeight'].includes(key)))
        throw new ToolArgsError(['only slot, path, x, y, maxWidth and maxHeight are accepted']);
      exec.signal.throwIfAborted();
      try{return await runtime.storeFrame(exec.agent,{slot:args.slot,path:args.path,x:args.x??0,y:args.y??0,
        maxWidth:args.maxWidth??320,maxHeight:args.maxHeight??240},exec.signal);}
      catch(error){throw motionError(error,exec,'The frame was not confirmed stored.');}
    },
  }));
  const frameShow=ctx.tools.register(defineTool({
    name:'stackchan_frame_show',
    description:'Show a stored frame-bank slot over the face for durationMs (100..60000, default 60000). Only while the face page is showing. Returns the round-trip time. To switch frames quickly or in step with head motion, use stackchan_servo_stream with frame points instead of calling this repeatedly; full-screen frames switch up to about 30 times a second on firmware with frames 2 (10 on frames 1; the stream paces them by area); smooth motion needs small angle steps between frames, not only a high rate.',
    parameters:{slot:{type:'integer',required:true},durationMs:{type:'integer'}},
    output:frameOutput({status:{type:'string',enum:['shown'],required:true},slot:{type:'integer',required:true},roundTripMs:{type:'number',required:true}}),
    async execute(args,exec){
      if(Object.keys(args).some(key=>!['slot','durationMs'].includes(key)))throw new ToolArgsError(['only slot and durationMs are accepted']);
      exec.signal.throwIfAborted();
      try{return await runtime.showFrame(exec.agent,{slot:args.slot,durationMs:args.durationMs??60000},exec.signal);}
      catch(error){throw motionError(error,exec,'The frame was not confirmed on screen.');}
    },
  }));
  const frameDrop=ctx.tools.register(defineTool({
    name:'stackchan_frame_drop',
    description:'Remove one frame-bank slot (0..47), or every frame with slot -1. A frame that is showing is taken off the screen first.',
    parameters:{slot:{type:'integer',required:true}},
    output:frameOutput({status:{type:'string',enum:['dropped'],required:true},slot:{type:'integer',required:true}}),
    async execute(args,exec){
      if(Object.keys(args).some(key=>key!=='slot'))throw new ToolArgsError(['only slot is accepted']);
      exec.signal.throwIfAborted();
      try{return {...await runtime.dropFrame(exec.agent,{slot:args.slot===-1?'all':args.slot},exec.signal),slot:args.slot};}
      catch(error){throw motionError(error,exec,'Dropping the frame was not confirmed.');}
    },
  }));
  const frameList=ctx.tools.register(defineTool({
    name:'stackchan_frame_list',
    description:'List what the device frame bank holds: each slot with its size, position and content tag, plus bytes used and the budget.',
    parameters:{},
    output:frameOutput({used:{type:'integer',required:true},budget:{type:'integer',required:true},frames:{type:'array',required:true,items:{type:'object',
      additionalProperties:false,properties:{slot:{type:'integer',required:true},width:{type:'integer',required:true},height:{type:'integer',required:true},
        x:{type:'integer',required:true},y:{type:'integer',required:true},tag:{type:'string',required:true}}}}}),
    async execute(args,exec){
      if(Object.keys(args).length)throw new ToolArgsError(['no arguments are accepted']);
      exec.signal.throwIfAborted();
      try{return await runtime.listFrames(exec.agent,exec.signal);}
      catch(error){throw motionError(error,exec,'The frame bank could not be read.');}
    },
  }));
  const wake=body?ctx.tools.register(defineTool({
    name:'stackchan_wake',
    description:'Wake your body: switch the robot from its factory assistant into the DSH body firmware once, then attend it over USB. Use it when no body is connected and you want to use one. The factory assistant stays the default; when the owner taps Home in the body (or the robot restarts) it goes back to the factory assistant. If it returns status woken but no body connects within a few seconds, ask the owner to tap the robot\'s face once. It writes one small boot record on the robot and never retries on its own.',
    parameters:{},
    output:{schema:{type:'object',additionalProperties:false,properties:{
      version:{type:'integer',enum:[1],required:true},status:{type:'string',enum:['woken','already-awake'],required:true},
      attending:{type:'boolean'},note:{type:'string'}}},render:(_args,result)=>[{type:'text',text:JSON.stringify(result)}]},
    async execute(args,exec){
      if(Object.keys(args).length)throw new ToolArgsError(['no arguments are accepted']);
      exec.signal.throwIfAborted();
      try{return await body.wake({signal:exec.signal});}
      catch(error){throw motionError(error,exec,'Waking the body did not finish.');}
    },
  })):null;
  const displayClear=ctx.tools.register(defineTool({
    name:'stackchan_clear_display',
    description:'Remove text or a picture shown with stackchan_show_text or stackchan_show_image, leaving the face.',
    parameters:{},
    output:{schema:{type:'object',additionalProperties:false,properties:{
      version:{type:'integer',enum:[1],required:true},status:{type:'string',enum:['cleared'],required:true}}},
      render:(_args,result)=>[{type:'text',text:JSON.stringify(result)}]},
    async execute(args,exec){
      if(Object.keys(args).length)throw new ToolArgsError(['no arguments are accepted']);
      exec.signal.throwIfAborted();
      try{return await runtime.clearDisplay(exec.agent,exec.signal);}
      catch(error){throw motionError(error,exec,'Clearing the screen was not confirmed.');}
    },
  }));
  const infrared=ctx.tools.register(defineTool({
    name:'stackchan_ir_send',
    description:'Send one NEC infrared code from the robot\'s IR emitter (address 0..65535, command 0..255, plus 0..5 repeat frames as if the button were held). This reaches other devices in the room (TV, air conditioner and similar); the owner must allow it in the DSH StackChan settings. To learn a remote\'s codes, record the infrared sensor with stackchan_sensor_record while the owner presses its buttons.',
    parameters:{address:{type:'integer',required:true},command:{type:'integer',required:true},repeats:{type:'integer'}},
    output:{schema:{type:'object',additionalProperties:false,properties:{
      version:{type:'integer',enum:[1],required:true},status:{type:'string',enum:['sent'],required:true}}},
      render:(_args,result)=>[{type:'text',text:JSON.stringify(result)}]},
    async execute(args,exec){
      if(Object.keys(args).some(key=>!['address','command','repeats'].includes(key)))
        throw new ToolArgsError(['only address, command and repeats are accepted']);
      exec.signal.throwIfAborted();
      try{return await runtime.sendInfrared(exec.agent,{address:args.address,command:args.command,repeats:args.repeats??0},exec.signal);}
      catch(error){throw motionError(error,exec,'The infrared send was not confirmed.');}
    },
  }));
  const nfcRead=ctx.tools.register(defineTool({
    name:'stackchan_nfc_read',
    description:'Read the memory of the NFC card on the reader (the reader is under the top of the head, where the touch pads are; the card must lie flat on it). Works for NFC Forum Type 2 tags (NTAG, MIFARE Ultralight); read-only, nothing on the card is ever written. With no arguments it reads pages 0..3 (UID, lock bytes, capability container) and then the NDEF area the capability container announces, and decodes the NDEF message (records with their type and payload; text and URI records also as strings). With page and count it returns exactly those pages (4 bytes each, up to 256 pages; reading past the end of the card fails). card.getVersion is the 8-byte GET_VERSION answer (vendor, product type, subtype, versions, storage size, protocol) as hex.',
    parameters:{page:{type:'integer'},count:{type:'integer'}},
    output:{schema:{type:'object',additionalProperties:false,properties:{
      version:{type:'integer',enum:[1],required:true},card:{type:'json',required:true},
      page:{type:'integer',required:true},count:{type:'integer',required:true},dataHex:{type:'string',required:true},
      capabilityContainer:{type:'json'},ndef:{type:'json'},pollStats:{type:'json'}}},
      render:(_args,result)=>[{type:'text',text:JSON.stringify(result)}]},
    async execute(args,exec){
      if(Object.keys(args).some(key=>!['page','count'].includes(key)))throw new ToolArgsError(['only page and count are accepted']);
      exec.signal.throwIfAborted();
      try{
        return await readType2((page,count)=>runtime.readNfc(exec.agent,{page,count},exec.signal),{page:args.page,count:args.count});
      }catch(error){
        const failure=motionError(error,exec,'The NFC read was not confirmed.');
        // Raw reader facts: how far each poll got since this conversation began.
        if(error?.pollStats)failure.message+=` Reader polls this conversation: ${JSON.stringify(error.pollStats)}.`;
        throw failure;
      }
    },
  }));
  const volume=ctx.tools.register(defineTool({
    name:'stackchan_set_volume',
    description:'Set the device speaker volume, 0..100 (the device setting, which applies to speech and sounds). It lasts until the device restarts; the owner keeps it across restarts with Settings > Save on the device.',
    parameters:{volume:{type:'integer',required:true}},
    output:{schema:{type:'object',additionalProperties:false,properties:{
      version:{type:'integer',enum:[1],required:true},volume:{type:'integer',required:true}}},
      render:(_args,result)=>[{type:'text',text:JSON.stringify(result)}]},
    async execute(args,exec){
      if(Object.keys(args).some(key=>key!=='volume'))throw new ToolArgsError(['only volume is accepted']);
      exec.signal.throwIfAborted();
      try{return await runtime.setVolume(exec.agent,args.volume,exec.signal);}
      catch(error){throw motionError(error,exec,'The volume change was not confirmed.');}
    },
  }));
  const ring=ctx.tools.register(defineTool({
    name:'stackchan_light_ring',
    description:'Show one solid color on the paired StackChan light ring for a limited duration. Requires Light ring permission on the device. Completion means the controller accepted the black frame and released the ring. One effect at a time.',
    parameters:{
      color:{type:'string',required:true,description:'Six-digit RGB color as #RRGGBB.'},
      durationMs:{type:'integer',description:'Duration in milliseconds, from 250 to 10000. Defaults to 1000.'},
    },
    output:{schema:{type:'object',additionalProperties:false,properties:{
      version:{type:'integer',enum:[1],required:true},status:{type:'string',enum:['completed'],required:true},
    }},render:(_args,result)=>[{type:'text',text:JSON.stringify(result)}]},
    async execute(args,exec){
      const duration=args.durationMs??1000;
      if(Object.keys(args).some(key=>!['color','durationMs'].includes(key))||!isRingColor(args.color)||
         !Number.isInteger(duration)||duration<RING.durationMin||duration>RING.durationMax)
        throw new ToolArgsError(['pass color as #RRGGBB and optional durationMs from 250 to 10000']);
      exec.signal.throwIfAborted();
      try{return await runtime.setRing(exec.agent,args,exec.signal);}
      catch(error){
        exec.signal.throwIfAborted();
        const code=Object.hasOwn(failures,error?.code)?error.code:'capability_result_unknown';
        throw new HarnessError((failures[code]??'The light-ring result was not confirmed.')+(error?.owner?` Held by session ${error.owner}.`:''),`stackchan/${code}`);
      }
    },
  }));
  const say=ctx.tools.register(defineTool({
    name:'stackchan_say',
    description:'Speak a short message aloud through the paired StackChan when you want to start talking on your own, for example to tell the user something you noticed or finished. Any session can use it while the device is linked; a device waiting in standby is woken and then listens for an answer. Do not use it to answer something the user just said by voice: those replies are already spoken automatically. Status spoken means playback finished; captioned means the device is in text mode; interrupted or dropped means the user stopped it or the device went back to standby first.',
    parameters:{text:{type:'string',required:true,description:'What to say, in the language you are using with the user. At most 400 characters.'}},
    output:{schema:{type:'object',additionalProperties:false,properties:{
      version:{type:'integer',enum:[1],required:true},status:{type:'string',enum:['spoken','captioned','interrupted','dropped'],required:true},
    }},render:(_args,result)=>[{type:'text',text:JSON.stringify(result)}]},
    async execute(args,exec){
      if(Object.keys(args).length!==1||typeof args.text!=='string'||!args.text.trim()||args.text.length>400)
        throw new ToolArgsError(['pass text as a non-empty string of at most 400 characters']);
      exec.signal.throwIfAborted();
      try{return await runtime.say(exec.agent,args.text.trim(),exec.signal);}
      catch(error){
        exec.signal.throwIfAborted();
        const code=Object.hasOwn(failures,error?.code)?error.code:'capability_result_unknown';
        throw new HarnessError((failures[code]??'The speech result was not confirmed.')+(error?.owner?` Held by session ${error.owner}.`:''),`stackchan/${code}`);
      }
    },
  }));
  return ()=>{wake?.();say();burst();displayText();displayImage();displayClear();frameStore();frameShow();frameDrop();frameList();servoStream();infrared();nfcRead();volume();playSound();recordAudio();ringFrames();ring();recordSensors();servoRead();servoRotate();servoTorque();servoMove();motion();camera();expression();status();};
}
