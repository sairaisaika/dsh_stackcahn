import {isAbsolute,join} from 'node:path';
import { createTranscriptFilter } from './transcript-text.mjs';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {symbols} from '@deepseek-ai/cordis';
import {createAgentTransport,frameTag} from './agent-transport.mjs';
import {waitForUsbReady} from './agent-usb-wire.mjs';
import {createLocalVoice} from './local-voice.mjs';
import {createHostAgent} from './host.mjs';
import {createVoiceEnvironment} from './voice-environment.mjs';
import {createVoiceInstallation,voiceInstallationErrors} from './voice-installation.mjs';
import {saveCameraAttachment} from './camera-attachment.mjs';
import {describeDeviceCapabilities} from './device-capabilities.mjs';
import {createIdleMotion} from './idle-motion.mjs';
import {createOwnerVoice,SPEAKER_MODEL} from './speaker-verify.mjs';
import {usbPortPattern} from './usb-port.mjs';
import {readRelayConfiguration} from './agent-relay-config.mjs';
import {createVoiceDiagnostics} from './voice-diagnostics.mjs';
import {loadImageRgb565} from './display-image.mjs';
import {SOUND,tonesToPcm,wavToPcm,pcmToWav,levels,withSilentTail} from './sound.mjs';
import {mkdir,readFile,writeFile,chmod} from 'node:fs/promises';

const fail=code=>Object.assign(new Error(code),{code});
const known=new Set(['host_busy','host_unconfigured','active_identity_required','reconcile_required',
  'private_storage_required','private_storage_invalid','identity_unavailable','identity_protocol_invalid',
  'identity_release_unconfirmed','voice_unconfigured','voice_preferences_required','voice_session_required',
  'voice_caption_required','voice_caption_delivery_failed',
  'voice_not_started','voice_device_missing','voice_restart_required','voice_busy','voice_disposed',
  'voice_identity_lost','voice_release_unconfirmed','voice_cancelled','voice_start_failed','voice_connect_failed','voice_action_invalid',
  'voice_environment_required','voice_environment_failed','voice_preview_preferences','voice_installation_custom',
  'voice_usb_port_required','voice_usb_port_unavailable','voice_usb_identity_mismatch','voice_usb_open_failed','voice_usb_access_disabled','voice_usb_handshake_failed',
  'voice_usb_standby_interrupted','voice_input_overloaded',
  'voice_relay_config_missing','voice_relay_config_invalid','voice_relay_identity_mismatch','voice_relay_timeout','voice_relay_unavailable','voice_relay_handshake_failed',
  'voice_lan_address_required','voice_address_unavailable','voice_port_in_use',...voiceInstallationErrors]);
const listenerErrors={
  'lan-address-required':'voice_lan_address_required',
  'listen-address-unavailable':'voice_address_unavailable',
  'listen-port-in-use':'voice_port_in_use',
};
const relayErrors={
  'relay-timeout':'voice_relay_timeout',
  'relay-closed':'voice_relay_timeout',
  'relay-connection-failed':'voice_relay_unavailable',
};
const standbyRetryCodes=new Set(['voice_caption_required','voice_usb_standby_interrupted','voice_usb_port_unavailable',
  'voice_usb_open_failed','voice_usb_handshake_failed','voice_device_link_lost','voice_connect_failed',
  'voice_local_audio_start_failed','voice_device_audio_start_failed','voice_device_missing']);
const publicCode=(error,fallback)=>known.has(error?.code)?error.code:fallback;
function publicConnectCode(error) {
  if (error?.activationStage==='local-audio') return 'voice_local_audio_start_failed';
  if (error?.activationStage==='device-audio') return 'voice_device_audio_start_failed';
  if (error?.activationStage==='device-link') return 'voice_device_link_lost';
  if (['session-not-found','session-migration-required','dsh-api-unavailable'].includes(error?.code)) return 'voice_selected_session_unavailable';
  return publicCode(error,'voice_connect_failed');
}
const key=value=>JSON.stringify(value);
// How long a device in standby keeps attending after the last speech or reply.
const standbyIdleReleaseMs=20000;
// Defaults for body-event telling; preferences eventCooldownSec/eventsPerHour override.
const defaultEventCooldownSec=30,defaultEventsPerHour=12;
const latencyFields=['asrMs','asrQueueMs','bridgeQueueMs','dshAdmissionMs','dshPromptToTurnEndMs',
  'ttsFirstPcmMs','ttsPreparedBeforeTurnEndMs','outputAckMs','segmentToFirstOutputAckMs'];
const faultSources=new Set(['transport','audio-input','recognition','synthesis','session','playback',
  // Who woke, slept or silenced her: fixed words from the bridge, never user text.
  'phrase','attention','tap','voice','stop-button','voice-stop','touch','agent','event','stroke','test']);
const faultCodes=new Set([
  'disconnected','connection-failed','protocol-invalid','lease-timeout','input-overflow','send-overflow','send-failed',
  'backpressure','output-timeout','playback-timeout','not-active','audio-process-failed','audio-protocol-invalid','audio-timeout','voice-input-overloaded',
  'speech-process-failed','speech-process-ended','speech-startup-failed','speech-protocol-invalid','speech-result-invalid',
  'speech-timeout','speech-transcription-failed','speech-synthesis-failed','voice-recognition-overflow','voice-transcript-invalid',
  'voice-playback-pcm-invalid','voice_caption_delivery_failed','dsh-disconnected','dsh-protocol','dsh-turn-incomplete',
  'dsh-api-unavailable','invalid-response','timeout',
]);
const turnFaultCodes=new Set([...faultCodes,'session-concurrent-input','voice-playback-busy','voice-not-active','turn-failed']);
const protocolFaultCodes=new Set([
  'input-order','boot-mismatch','response-mismatch','renewal-mismatch','output-order','output-mismatch','playback-mismatch',
  'battery-state-mismatch','ambient-state-mismatch','head-touch-state-mismatch','head-touch-gesture-mismatch','imu-state-mismatch',
  'camera-mismatch','camera-state-mismatch','motion-mismatch','motion-state-mismatch','motion-feedback-mismatch',
  'ring-mismatch','ring-state-mismatch','expression-mismatch',
]);
function projectLatency(sample){
  const result={};
  for(const field of latencyFields){
    const value=sample[field];
    if(Number.isFinite(value)&&value>=0)result[field]=Math.round(value);
  }
  return result.segmentToFirstOutputAckMs===undefined?null:Object.freeze(result);
}
// Cordis get() creates a fresh traceable proxy. Compare the provider identity,
// while invoking methods on the traced service so context policy is preserved.
const providerIdentity=service=>service?.[symbols.original]??service;

/** One profile runtime. No I/O before explicit start. Factories are Host-only test seams. */
export function createVoiceRuntime({ctx,pairing,getPreferences,installation={},profileDirectory,onLatency,onVoiceFault,onVoiceDiagnostic,factories={}}){
  const make={transport:createAgentTransport,voice:createLocalVoice,bridge:createHostAgent,...factories};
  const pathNames=['python','audioDirectory','assetsDirectory','whisperBinary','temporaryDirectory'];
  const custom=pathNames.some(name=>!!installation[name]);
  const setup=factories.installation??createVoiceInstallation({profileDirectory});
  const selectInstallation=async()=>custom?structuredClone(installation):(await setup.active()??{});
  const environmentFor=options=>factories.environment??createVoiceEnvironment({installation:options});
  const relayRetryDelay=factories.relayRetryDelay??delay;
  let current=null,job=null,disposed=false,phase='stopped',lastError='',deviceIdleConfirmed=false,revision=0,cameraPending=false;
  let cameraOwner=null,cameraOperation='idle',cameraError='',cameraAgent='';
  // Any DSH session may use the body; one holder per capability at a time.
  const occupants={motion:null,ring:null};const photoLog=[];
  const busy=(code,owner)=>Object.assign(fail(code),{owner});
  const logLatency=typeof onLatency==='function';
  const standbyCanWarm=r=>current===r&&!r.cancelled&&!!r.standby&&!r.standby.abort.signal.aborted&&
    key(r.preferences)===key(getPreferences());
  const makeBridge=r=>{
    const record=r.preferences.measureLatency===true;
    const bridge=make.bridge(ctx,{voice:r.voice,timeoutMs:25000,idleReleaseMs:standbyIdleReleaseMs,eventCooldownMs:(r.preferences.eventCooldownSec??defaultEventCooldownSec)*1000,eventsPerHour:r.preferences.eventsPerHour??defaultEventsPerHour,ownerOnly:r.preferences.ownerOnly??'off',speakEarly:true,speakSessionReplies:r.preferences.speakSessionReplies===true,wakeNames:r.preferences.wakeNames,bodyFacts:r.preferences.bodyFacts??'context',onReleased:result=>{
      if(current===r&&r.bridge===bridge)r.standby?.released?.(result);
    },onStage:r.diagnostics ? (stage,fields)=>{
      if(current!==r||r.cancelled||r.bridge!==bridge)return;
      // Fixed vocabularies only: a DSH error message never reaches the log.
      const source=fields&&faultSources.has(fields.source)?fields.source:undefined;
      const code=fields&&turnFaultCodes.has(fields.code)?fields.code:fields?.code?'unknown':undefined;
      r.diagnostics.stage(stage,{...(source?{source}:{}),...(code?{code}:{})});
    }:undefined,onLatency:record||logLatency?sample=>{
      if(current!==r||r.cancelled||r.bridge!==bridge||bridge.status().state!=='bridged')return;
      if(record)r.latestLatency=projectLatency(sample);
      if(logLatency)return onLatency(sample,r.mode);
    }:undefined});
    return bridge;
  };
  const snapshot=()=>{
    const state=current?.bridge?.status();
    const standby=!!current?.standby&&!current.standby.abort.signal.aborted;
    const canRecover=state?.state==='recovering'&&current.voice.canReconnect?.()===true;
    const live=phase==='listening'&&state?.state==='bridged'?'active'
      :phase==='listening'&&(state?.state==='connecting'||current?.outboundConnecting&&!standby)?'connecting'
      :phase==='listening'&&state?.state==='recovering'&&!(standby&&canRecover)?'fault'
      :phase==='listening'&&state?.state==='releasing'?'stopping':phase;
    const result={phase:live,connected:!!current?.transport?.connection,transport:current?.mode??null,
      camera:{...(current?.transport?.connection?.cameraSnapshot?.()??{capability:'disconnected',status:'unavailable',permission:'unknown',phase:'unknown',busy:false,error:''}),
        attachmentsAvailable:!!ctx.get?.('attachments')?.saveImage,
        operation:cameraPending&&(cameraOwner!==current||live!=='active')?'cancelling':cameraOwner===current?cameraOperation:'idle',
        operationError:cameraOwner===current?cameraError:''},
      ring:current?.transport?.connection?.ringSnapshot?.()??
        {capability:'disconnected',status:'unavailable',permission:'unknown',phase:'unknown',error:''},
      motion:current?.transport?.connection?.motionSnapshot?.()??
        {capability:'disconnected',status:'unavailable',permission:'unknown',phase:'unknown',error:''},
      installation:{...setup.snapshot(),mode:custom?'custom':profileDirectory||factories.installation?'managed':'unavailable'},
      sessionId:current?.preferences.sessionId??'',
      pendingChanges:!!current&&key(current.preferences)!==key(getPreferences()),
      relayStandby:standby&&current.mode==='relay',
      lanStandby:standby&&current.mode==='lan',
      usbStandby:standby&&current.mode==='usb',
      latency:{enabled:current?.preferences.measureLatency===true,latest:current?.latestLatency??null},
      ownerVoice:{...ownerVoice.status(),policy:current?.preferences.ownerOnly??getPreferences().ownerOnly??'off'},
      applied:live==='active',lastError:lastError||(state?.lastError==='voice-input-overloaded'?'voice_input_overloaded'
        :state?.lastError==='voice_caption_delivery_failed'?'voice_caption_delivery_failed'
        :state?.lastError&&!(standby&&canRecover)?'voice_connect_failed':''),
      canReconnect:live==='fault'&&canRecover,
      deviceIdleConfirmed:current?.transport?.connection
        ?current.transport.connection.snapshot().phase==='idle'&&state?.state==='idle'
        :current?current.standbyStoppedConfirmed===true:deviceIdleConfirmed};
    const negotiated=current?.transport?.connection?.negotiatedCapabilities?.();
    const captionOnly=current?.preferences.captionOnly===true;
    const battery=current?.transport?.connection?.batterySnapshot?.();
    const ambient=current?.transport?.connection?.ambientSnapshot?.();
    const headTouch=current?.transport?.connection?.headTouchSnapshot?.();
    const imu=current?.transport?.connection?.imuSnapshot?.();
    return {...result,capabilities:describeDeviceCapabilities(negotiated,{...result,battery,ambient,headTouch,imu},{captionOnly})};
  };
  function settings(){
    const p=structuredClone(getPreferences());
    if(!p.sessionId)throw fail('voice_session_required');
    if(p.asrBackend!=='whisper.cpp'||(p.captionOnly!==true&&(p.ttsBackend!=='kokoro'||!['','zf_001','zf_038','af_maple'].includes(p.voice))))
      throw fail('voice_preferences_required');
    return p;
  }
  async function runOffline(work,signal,failure){
    if(disposed)throw fail('voice_disposed');
    if(job||current||phase!=='stopped')throw fail('voice_busy');
    const abort=new AbortController();const combined=signal?AbortSignal.any([signal,abort.signal]):abort.signal;
    const op={abort,revision:++revision};job=op;
    op.promise=(async()=>{
      combined.throwIfAborted();
      const options=await selectInstallation();
      combined.throwIfAborted();
      return work(environmentFor(options),combined);
    })();
    try{
      const result=await op.promise;
      combined.throwIfAborted();
      return result;
    }catch(error){throw fail(combined.aborted?'voice_cancelled':publicCode(error,failure));}
    finally{if(job===op)job=null;}
  }
  async function closeResources(r){
    if(r.closing)return r.closing;
    r.cancelled=true;
    const standby=r.standby;
    standby?.abort.abort();
    if(!r.identity)r.identityAbort.abort();
    r.closing=(async()=>{
      await r.acquiring?.catch(()=>{});
      let error;
      if(r.bridge){
        try{
          const peer=r.transport?.connection;
          const result=await r.bridge.stop('runtime-shutdown');
          deviceIdleConfirmed=result.state==='idle'&&(r.standbyStoppedConfirmed===true||
            !!peer&&peer===r.transport?.connection&&peer.snapshot().phase==='idle');
          if(result.state!=='idle')error=fail('voice_release_unconfirmed');
        }catch{deviceIdleConfirmed=false;error=fail('voice_release_unconfirmed');}
      }
      // Even unknown device release must not retain a listener/credentials forever.
      try{await r.transport?.close();}catch{error??=fail('voice_release_unconfirmed');}
      await standby?.done;
      await r.usb?.close();
      try{await r.voice?.dispose();}catch{error??=fail('voice_release_unconfirmed');}
      try{await r.identity?.release();}catch{error??=fail('identity_release_unconfirmed');}
      if(current===r)current=null;
      if(error)throw error;
    })();
    return r.closing;
  }
  async function shutdown(){
    ++revision;job?.abort.abort();
    phase='stopping';
    const r=current;
    let error;
    try{if(r)await closeResources(r);}catch(e){error=e;lastError=publicCode(e,'voice_release_unconfirmed');}
    await job?.promise.catch(()=>{});
    phase=disposed?'disposed':'stopped';
    // stopped means Host service stopped, not an invented hardware idle receipt.
    if(error)throw error;
    return snapshot();
  }
  async function start(signal){
    const preferences=settings();
    const mode=preferences.transport??'lan';
    if(!['lan','usb','relay'].includes(mode))throw fail('voice_preferences_required');
    if(mode==='usb'&&(typeof preferences.usbPort!=='string'||!usbPortPattern.test(preferences.usbPort)))throw fail('voice_usb_port_required');
    const r={preferences,mode,identityAbort:new AbortController(),cancelled:false};current=r;
    const diagnostics=onVoiceDiagnostic&&createVoiceDiagnostics(mode,onVoiceDiagnostic);
    r.diagnostics=diagnostics;
    diagnostics?.stage('service-start-requested');
    const cancel=()=>{r.cancelled=true;if(!r.identity)r.identityAbort.abort();};
    signal.addEventListener('abort',cancel,{once:true});
    try{
      signal.throwIfAborted();
      if(mode==='relay')r.relayConfiguration=await readRelayConfiguration(profileDirectory);
      signal.throwIfAborted();
      const installation=await selectInstallation();r.installation=installation;
      for(const name of pathNames)
        if(typeof installation[name]!=='string'||!isAbsolute(installation[name]))throw fail('voice_unconfigured');
      const report=await environmentFor(installation).inspect(signal);
      if(!report.filesVerified)throw fail('voice_environment_required');
      signal.throwIfAborted();if(r.cancelled)throw fail('voice_cancelled');
      r.acquiring=pairing.acquireIdentity(r.identityAbort.signal).then(identity=>{r.identity=identity;return identity;});
      await r.acquiring;signal.throwIfAborted();if(r.cancelled)throw fail('voice_cancelled');
      if(r.relayConfiguration&&r.relayConfiguration.pairId!==r.identity.pairing?.record?.pair_id)
        throw fail('voice_relay_identity_mismatch');
      r.identity.closed.then(()=>{
        if(current===r&&!r.cancelled){lastError='voice_identity_lost';void shutdown().catch(()=>{});}
      });
      r.transport=make.transport({pairing:r.identity.pairing,deviceId:r.identity.deviceId,
        recoverInput:true,voiceDiagnostics:diagnostics});
      // A device may disconnect while DSH validates the saved session.
      // A replacement peer must complete its own connect attempt.
      r.voice=make.voice({getConnection:()=>r.connectingPeer===r.transport.connection?r.connectingPeer:undefined,
        voiceDiagnostics:diagnostics,
        keepSynthesisWarm:()=>standbyCanWarm(r),
        onActiveFault:(onVoiceFault||diagnostics)?sample=>{
          if(current!==r||r.cancelled)return;
          const {source,code,protocolCode,firstInputReceived,activeMs}=sample;
          const projected={version:1,transport:mode,source:faultSources.has(source)?source:'unknown',
            code:faultCodes.has(code)?code:'unknown',
            ...(source==='transport'&&code==='protocol-invalid'&&protocolFaultCodes.has(protocolCode)?{protocolCode}:{}),
            firstInputReceived:firstInputReceived===true,
            ...(Number.isFinite(activeMs)&&activeMs>=0?{activeMs:Math.round(activeMs)}:{})};
          if(diagnostics)diagnostics.stage('voice-fault',{source:projected.source,code:projected.code,
            ...(projected.protocolCode?{protocolCode:projected.protocolCode}:{})});
          return onVoiceFault?.(projected);
        }:undefined,
        captionOnly:r.preferences.captionOnly===true,
        // Judged only when the owner asked for it or is enrolling; otherwise no voice is examined.
        speaker:pcm=>ownerVoice.check(pcm,{verify:(r.preferences.ownerOnly??'off')!=='off'}),
        audio:{python:installation.python,directory:installation.audioDirectory,aecV12:installation.aecV12},
        recognition:{binary:installation.whisperBinary,model:installation.assetsDirectory+'/whisper/ggml-small-q5_1.bin',
          temporaryDirectory:installation.temporaryDirectory,protocol:installation.whisperProtocol},
        synthesis:{python:installation.python,assets:installation.assetsDirectory},
        language:preferences.language,voice:preferences.voice,speechRate:preferences.speechRate,
        transcriptFilter:createTranscriptFilter({simplify:preferences.transcriptSimplify===true,replacements:preferences.transcriptReplacements??[]}),
        measureLatency:preferences.measureLatency===true||logLatency});
      ownerVoice.configure(installation.assetsDirectory?join(installation.assetsDirectory,'speaker',SPEAKER_MODEL.file):null);
      await ownerVoice.load();
      // Paid here, before any audio flows, rather than on the first judged utterance.
      if((preferences.ownerOnly??'off')!=='off')ownerVoice.warm();
      r.bridge=makeBridge(r);
      if(mode==='lan'){
        try{await r.transport.listen();}
        catch(error){const code=listenerErrors[error?.code];if(code)throw fail(code);throw error;}
      }else if(mode==='usb'&&!r.identity.openUsb)throw fail('voice_usb_access_disabled');
      signal.throwIfAborted();if(r.cancelled)throw fail('voice_cancelled');
      r.voice.prewarmSynthesis?.();
      diagnostics?.stage('service-listening');
      phase='listening';return snapshot();
    }catch(error){
      diagnostics?.stage('service-start-ended',{outcome:signal.aborted?'cancelled':publicCode(error,'voice_start_failed')});
      try{await closeResources(r);}catch(cleanup){lastError=publicCode(cleanup,'voice_release_unconfirmed');}
      phase='stopped';throw signal.aborted?fail('voice_cancelled'):error;
    }finally{signal.removeEventListener('abort',cancel);}
  }
  async function connectUsb(r,signal,standby){
    r.outboundConnecting=true;
    const abort=()=>{void r.usb?.close();};
    signal.addEventListener('abort',abort,{once:true});
    try{
      await r.usb?.close(); // A reconnect must follow complete closure of the old handle.
      signal.throwIfAborted();
      r.diagnostics?.stage('usb-open-requested');
      r.usb=r.identity.openUsb(r.preferences.usbPort,r.diagnostics?.usbRead);
      await r.usb.ready;
      r.diagnostics?.stage('usb-opened');
      signal.throwIfAborted();
      // Standby only listens: it writes nothing until the DSH firmware announces itself, so the
      // factory firmware on the same port is never sent a byte (wiki/residency.md).
      if(standby)await waitForUsbReady(r.usb.stream,signal,{listenOnly:true});
      if(standby)r.diagnostics?.stage('usb-device-ready');
      signal.throwIfAborted();
      if(key(r.preferences)!==key(getPreferences()))throw fail('voice_restart_required');
      try{await r.transport.attachUsb(r.usb.stream);}
      catch{throw fail('voice_usb_handshake_failed');}
      r.diagnostics?.stage('usb-authenticated');
      signal.throwIfAborted();
    }catch(error){
      r.diagnostics?.stage('usb-connect-ended',{outcome:signal.aborted?'cancelled':publicCode(error,'voice_connect_failed')});
      await r.usb?.close();
      throw error;
    }finally{
      r.outboundConnecting=false;
      signal.removeEventListener('abort',abort);
    }
  }
  async function connectRelay(r,signal){
    const {endpoint,roomId,token,ca}=r.relayConfiguration;
    r.outboundConnecting=true;
    try {
      await r.transport.attachRelay({endpoint,roomId,token,ca,signal});
    } catch(error) {
      throw fail(relayErrors[error?.code]??'voice_relay_handshake_failed');
    } finally { r.outboundConnecting=false; }
  }
  function armStandby(mode,signal){
    const r=current;
    signal?.throwIfAborted();
    if(!r)throw fail('voice_not_started');
    if(r.mode!==mode)throw fail('voice_preferences_required');
    if(key(r.preferences)!==key(getPreferences()))throw fail('voice_restart_required');
    const state=r.bridge.status().state;
    if(state==='recovering'&&r.voice.canReconnect?.()!==true)throw fail('voice_release_unconfirmed');
    if(phase!=='listening'||r.transport.connection||r.standby||!['idle','recovering'].includes(state))throw fail('voice_busy');
    const standby={abort:new AbortController()};
    r.standby=standby;r.standbyStoppedConfirmed=false;lastError='';
    standby.done=runStandby(r,standby).finally(()=>{r.standby=null;});
    return snapshot();
  }
  async function runStandby(r,standby){
    const signal=standby.abort.signal;
    let retry=250;
    try {
      r.voice.prewarmSynthesis?.();
      while(!signal.aborted){
        const released=Promise.withResolvers();
        standby.released=released.resolve;
        let connected=false;
        let backoff=false,recheck=false;
        let peer;
        try{
          if(r.mode==='lan') {
            peer=r.transport.connection??(await once(r.transport.events,'connection',{signal}))[0];
            // The transport emits only after authenticated idle hello.
            signal.throwIfAborted();
            if(peer!==r.transport.connection)continue;
          }
          await connect(signal,{usbStandby:r.mode==='usb'});
          peer??=r.transport.connection;
          connected=true;
          retry=250;
          const stopped=await released.promise;
          r.standbyStoppedConfirmed=stopped.state==='idle'&&!!peer&&
            peer===r.transport.connection&&peer.snapshot().phase==='idle';
          if(stopped.state!=='idle'&&r.voice.canReconnect?.()!==true)throw fail('voice_release_unconfirmed');
          if(r.mode==='usb'&&!r.standbyStoppedConfirmed&&!signal.aborted)throw fail('voice_usb_standby_interrupted');
        }catch(error){
          if(signal.aborted)break;
          const code=publicConnectCode(error);
          const interrupted=publicCode(error,'voice_connect_failed')==='voice_connect_failed'&&r.voice.canReconnect?.()===true;
          // Standby is the user's standing request to be reachable. Unplugging,
          // a device restart or one failed attempt waits and tries again; only a
          // condition that needs the user ends it.
          // An unconfirmed release is judged again once this link has closed.
          recheck=code==='voice_release_unconfirmed'&&r.mode!=='relay';
          const transient=standbyRetryCodes.has(code)||recheck;
          if(r.mode==='lan'){
            const retryPeer=error?.code==='voice-device-not-ready'&&peer!==r.transport.connection;
            if(!retryPeer&&!interrupted&&!transient)throw error;
          }else if(r.mode==='usb'){
            if(!transient)throw error;
            backoff=true;
          }else if(r.transport.connection||!interrupted&&!['voice_relay_timeout','voice_relay_unavailable','voice_relay_handshake_failed','voice_caption_required'].includes(code))throw error;
          lastError=code==='voice_relay_timeout'?'':code;
        }finally{
          standby.released=null;
          await (r.mode==='lan'?peer:r.transport.connection)?.close({graceful:r.mode==='usb'});
        }
        if(recheck&&r.bridge.status().state==='recovering'&&r.voice.canReconnect?.()!==true){
          lastError='voice_release_unconfirmed';break;
        }
        if(r.standbyStoppedConfirmed&&standbyCanWarm(r))r.voice.prewarmSynthesis?.();
        if(backoff&&!signal.aborted){
          try{await relayRetryDelay(retry,undefined,{signal});}catch{break;}
          retry=Math.min(retry*2,5000);
          continue;
        }
        if(r.mode==='relay'&&!connected&&!signal.aborted){
          await relayRetryDelay(retry,undefined,{signal});
          retry=Math.min(retry*2,2000);
        }
      }
    }catch(error){if(!signal.aborted)lastError=publicConnectCode(error);}
    finally{
      try{await r.voice.cancelPrewarm?.();}catch{lastError||='voice_release_unconfirmed';}
    }
  }
  async function connect(signal,{usbStandby=false}={}){
    const r=current;if(!r)throw fail('voice_not_started');
    if(key(r.preferences)!==key(getPreferences()))throw fail('voice_restart_required');
    const state=r.bridge.status().state;
    const reconnect=state==='recovering';
    if(reconnect&&r.voice.canReconnect?.()!==true)throw fail('voice_release_unconfirmed');
    if(!reconnect&&state!=='idle')throw fail('voice_busy');
    if(r.mode==='usb'&&!r.transport.connection)await connectUsb(r,signal,usbStandby);
    if(r.mode==='relay'&&!r.transport.connection)await connectRelay(r,signal);
    signal.throwIfAborted();
    if(current!==r||r.cancelled)throw fail('voice_cancelled');
    if(key(r.preferences)!==key(getPreferences()))throw fail('voice_restart_required');
    const connection=r.transport.connection;
    if(!connection)throw fail('voice_device_missing');
    deviceIdleConfirmed=false;r.standbyStoppedConfirmed=false;
    if(reconnect){
      // The new authenticated idle hello can authorize a new lease. It cannot
      // certify the old connection's missing Stop receipt.
      if(connection.snapshot().phase!=='idle'||!r.voice.retireDisconnected())throw fail('voice_release_unconfirmed');
      r.bridge=makeBridge(r);
    }
    r.latestLatency=null;
    const bridge=r.bridge;
    r.connectingPeer=connection;
    const cancel=()=>{void bridge.stop('request-cancelled');};
    signal.addEventListener('abort',cancel,{once:true});
    try{
      r.diagnostics?.stage('session-attach-requested');
      signal.throwIfAborted();await bridge.enter(r.preferences.sessionId);signal.throwIfAborted();
      r.diagnostics?.stage('voice-active');
      deviceIdleConfirmed=false;lastError='';return snapshot();
    }catch(error){
      r.diagnostics?.stage('session-attach-ended',{outcome:signal.aborted?'cancelled':publicConnectCode(error)});
      if(error?.code==='voice_caption_required'&&r.transport.connection===connection)
        await connection.close({graceful:usbStandby});
      throw error;
    }finally{r.connectingPeer=undefined;signal.removeEventListener('abort',cancel);}
  }
  async function runEffect(method,agent,target,signal,staleCode){
    const r=current,operationRevision=revision;
    let connection,identity;
    const assertCurrent=()=>{
      signal?.throwIfAborted();
      if(disposed||!r||current!==r||r.cancelled||phase!=='listening'||
          r.bridge?.status().state!=='bridged'||revision!==operationRevision)throw fail('capability_inactive');
      if(!agent?.id)throw fail('capability_session_required');
      if(key(r.preferences)!==key(getPreferences()))throw fail('voice_restart_required');
      const live=r.transport.connection;
      if(!live)throw fail('voice_device_missing');
      if(connection&&(live!==connection||key(live.snapshot())!==identity))throw fail(staleCode);
    };
    assertCurrent();
    connection=r.transport.connection;identity=key(connection.snapshot());
    const capability=['showText','showImage','clearDisplay','storeFrame','showFrame','dropFrame','listFrames'].includes(method)?'display':method==='sendInfrared'?'infrared':method==='readNfc'?'nfc':method==='setVolume'?'volume':method==='setRing'||method==='setRingFrames'?'ring':method==='recordSensors'?'recording':'motion';
    const held=occupants[capability];
    if(held&&held.id!==agent.id)throw busy(`${capability}-busy`,held.id);
    const claim={id:agent.id};occupants[capability]=claim;
    r.diagnostics?.stage('effect-requested',{stage:capability});
    try {
      const result=await connection[method](target,{signal});
      assertCurrent();
      r.diagnostics?.stage('effect-returned',{stage:capability});
      // A session's own motion (and any hold it asked for) pauses the idle look-around.
      if(capability==='motion')motionQuietUntil=performance.now()+30000+(result?.holding?(target?.holdMs??0):0);
      return result;
    } catch(error) {
      r.diagnostics?.stage('effect-failed',{stage:capability,outcome:signal?.aborted?'cancelled':'failed'});
      throw error;
    } finally {if(occupants[capability]===claim)occupants[capability]=null;}
  }
  const ownerVoice=(factories.ownerVoice??createOwnerVoice)({
    directory:typeof profileDirectory==='string'&&isAbsolute(profileDirectory)?join(profileDirectory,'.stackchan-voice'):null});
  // A linked device that is waiting looks around like the factory assistant does,
  // except for a while after a session moved, held or read the head itself.
  let motionQuietUntil=0;
  const idleMotion=(factories.idleMotion??createIdleMotion)({
    waiting:()=>{const r=current;return !disposed&&!!r&&!r.cancelled&&phase==='listening'&&
      r.bridge?.status().attending===false&&!!r.transport.connection&&performance.now()>=motionQuietUntil;},
    move:(target,options)=>current.transport.connection.moveHead(target,options),
    onState:sample=>current?.diagnostics?.stage(sample.event,{code:sample.code}),
  });
  idleMotion.start();
  const service={
    snapshot,
    /** Who took photos and when (newest last, at most 50). */
    photoLog(){return photoLog.map(x=>({...x}));},
    deviceStatus(agent,signal){
      signal?.throwIfAborted();
      if(!agent?.id)throw fail('capability_session_required');
      return snapshot().capabilities;
    },
    async photograph(agent,signal){
      const r=current,operationRevision=revision;
      let connection,identity;
      const assertCurrent=()=>{
        signal?.throwIfAborted();
        if(disposed||!r||current!==r||r.cancelled||phase!=='listening'||
            r.bridge?.status().state!=='bridged'||revision!==operationRevision)throw fail('capability_inactive');
        if(!agent?.id)throw fail('capability_session_required');
        if(key(r.preferences)!==key(getPreferences()))throw fail('voice_restart_required');
        const live=r.transport.connection;
        if(!live)throw fail('voice_device_missing');
        if(connection&&(live!==connection||key(live.snapshot())!==identity))throw fail('camera_session_changed');
      };
      assertCurrent();
      const attachments=ctx.get('attachments');
      if(!attachments?.saveImage)throw fail('camera_attachments_unavailable');
      if(cameraPending)throw busy('camera-busy',cameraAgent);
      connection=r.transport.connection;identity=key(connection.snapshot());
      cameraPending=true;cameraOwner=r;cameraAgent=agent.id;cameraOperation='capturing';cameraError='';
      const entry={session:agent.id,at:Date.now(),outcome:'pending'};photoLog.push(entry);if(photoLog.length>50)photoLog.shift();
      r.diagnostics?.stage('camera-requested');
      try{
        const picture=await connection.captureCamera({signal});
        assertCurrent();
        cameraOperation='importing';
        r.diagnostics?.stage('camera-device-returned');
        const attachment=await saveCameraAttachment(picture,attachments,()=>{
          assertCurrent();
          if(providerIdentity(ctx.get('attachments'))!==providerIdentity(attachments))throw fail('camera_attachments_unavailable');
        });
        assertCurrent();
        if(providerIdentity(ctx.get('attachments'))!==providerIdentity(attachments))throw fail('camera_attachments_unavailable');
        cameraOperation='saved';entry.outcome='saved';
        r.diagnostics?.stage('camera-saved');
        return {version:1,attachment};
      }catch(error){
        cameraOperation='failed';
        const code=error?.code;
        cameraError=signal?.aborted||['capability_inactive','camera_session_changed','voice_restart_required','stopped'].includes(code)?'cancelled':
          ['camera_image_invalid','camera_attachment_failed','camera_attachments_unavailable'].includes(code)?code:
          ['disabled','unavailable','memory','open','capture','invalid','timeout','close','cancelled','busy','unsupported'].some(x=>code===`camera-${x}`)?code.slice(7):'unknown';
        entry.outcome=cameraError;
        r.diagnostics?.stage('camera-failed',{outcome:cameraError});
        throw error;
      }finally{cameraPending=false;cameraAgent='';}
    },
    moveHead(agent,target,signal){return runEffect('moveHead',agent,target,signal,'motion_session_changed');},
    moveFrames(agent,request,signal){return runEffect('moveFrames',agent,request,signal,'motion_session_changed');},
    setTorque(agent,request,signal){return runEffect('setTorque',agent,request,signal,'motion_session_changed');},
    readServos(agent,signal){return runEffect('readServos',agent,{signal},signal,'motion_session_changed');},
    streamSetpoints(agent,request,signal){return runEffect('streamSetpoints',agent,request,signal,'motion_session_changed');},
    rotateYaw(agent,request,signal){return runEffect('rotateYaw',agent,request,signal,'motion_session_changed');},
    recordSensors(agent,request,signal){return runEffect('recordSensors',agent,request,signal,'recording_session_changed');},
    /** DSH speaking first on a connected device. Replies to voice are spoken by the bridge itself. */
    async say(agent,text,signal){
      signal?.throwIfAborted();
      const r=current;
      if(disposed||!r||r.cancelled||phase!=='listening'||r.bridge?.status().state!=='bridged')throw fail('capability_inactive');
      if(!agent?.id)throw fail('capability_session_required');
      if(key(r.preferences)!==key(getPreferences()))throw fail('voice_restart_required');
      const result=await r.bridge.say(text);
      signal?.throwIfAborted();
      if(result.failed)throw fail('speech_failed');
      return {version:1,status:result.spoken?'spoken':result.captioned?'captioned':result.interrupted?'interrupted':'dropped'};
    },
    /** Play tones or a 16-bit WAV through the speaker, queued like speech. */
    async playSound(agent,{tones,wavPath,volume=1},signal){
      signal?.throwIfAborted();
      const r=current;
      if(disposed||!r||r.cancelled||phase!=='listening'||r.bridge?.status().state!=='bridged')throw fail('capability_inactive');
      if(!agent?.id)throw fail('capability_session_required');
      if((tones===undefined)===(wavPath===undefined))throw fail('sound-invalid');
      let pcm;
      try{
        if(tones!==undefined)pcm=tonesToPcm(tones.map(t=>({...t,volume:(t.volume??0.5)*volume})));
        else{
          if(typeof wavPath!=='string'||!isAbsolute(wavPath))throw fail('sound-invalid');
          pcm=wavToPcm(await readFile(wavPath),volume);
        }
      }catch(error){throw error?.code==='sound-invalid'?error:fail('sound-unreadable');}
      const result=await r.bridge.say('',{pcm:withSilentTail(pcm)});
      signal?.throwIfAborted();
      if(result.failed)throw fail('speech_failed');
      return {version:1,status:result.spoken?'played':result.captioned?'not-played-text-mode':result.interrupted?'interrupted':'dropped',
        durationMs:Math.round(pcm.length/2/24)};
    },
    /** Record the two raw microphone channels (before echo cancellation) into a private WAV. */
    async recordAudio(agent,{durationMs},signal){
      signal?.throwIfAborted();
      const r=current;
      if(disposed||!r||r.cancelled||phase!=='listening'||r.bridge?.status().state!=='bridged')throw fail('capability_inactive');
      if(!agent?.id)throw fail('capability_session_required');
      if(!Number.isInteger(durationMs)||durationMs<100||durationMs>SOUND.maxRecordMs)throw fail('sound-invalid');
      if(typeof profileDirectory!=='string'||!isAbsolute(profileDirectory)||!r.voice?.tapInput)throw fail('sound-unavailable');
      const chunks=[];let bytes=0;const limit=Math.ceil(durationMs*24)*2*2;
      const untap=r.voice.tapInput(pcm=>{if(bytes<limit){chunks.push(Buffer.from(pcm));bytes+=pcm.length;}});
      try{await delay(durationMs,undefined,{signal});}finally{untap();}
      const pcm=Buffer.concat(chunks).subarray(0,limit);
      if(!pcm.length)throw fail('sound-no-input');
      const directory=join(profileDirectory,'.stackchan-recordings');
      await mkdir(directory,{recursive:true,mode:0o700});await chmod(directory,0o700);
      const path=join(directory,`recording-${new Date().toISOString().replace(/[:.]/g,'-')}.wav`);
      await writeFile(path,pcmToWav(pcm),{mode:0o600,flag:'wx'});
      return {version:1,path,durationMs:Math.round(pcm.length/4/24),sampleRate:24000,channels:2,...levels(pcm)};
    },
    showText(agent,request,signal){return runEffect('showText',agent,request,signal,'display_session_changed');},
    async showImage(agent,{path,x=0,y=0,durationMs=10000,maxWidth=320,maxHeight=240},signal){
      if(typeof path!=='string'||!isAbsolute(path))throw fail('display-invalid');
      const image=await loadImageRgb565(path,{maxWidth:Math.min(maxWidth,320-x),maxHeight:Math.min(maxHeight,240-y)});
      return runEffect('showImage',agent,{...image,x,y,durationMs},signal,'display_session_changed');
    },
    clearDisplay(agent,signal){return runEffect('clearDisplay',agent,{signal},signal,'display_session_changed');},
    // Frame bank (wiki/head-coupled-view.md): pictures stored ahead, shown by number.
    async storeFrame(agent,{slot,path,x=0,y=0,maxWidth=320,maxHeight=240},signal){
      if(typeof path!=='string'||!isAbsolute(path))throw fail('display-invalid');
      if(!Number.isInteger(x)||!Number.isInteger(y)||x<0||y<0||x>319||y>239)throw fail('display-invalid');
      const image=await loadImageRgb565(path,{maxWidth:Math.min(maxWidth,320-x),maxHeight:Math.min(maxHeight,240-y)});
      const tag=frameTag({...image,x,y});
      const held=await runEffect('listFrames',agent,{signal},signal,'display_session_changed');
      const same=held.frames.find(f=>f.slot===slot&&f.tag===tag);
      if(same)return {version:1,status:'already',slot,width:same.width,height:same.height,x,y,tag};
      return runEffect('storeFrame',agent,{slot,...image,x,y,tag},signal,'display_session_changed');
    },
    showFrame(agent,request,signal){return runEffect('showFrame',agent,request,signal,'display_session_changed');},
    dropFrame(agent,request,signal){return runEffect('dropFrame',agent,request,signal,'display_session_changed');},
    listFrames(agent,signal){return runEffect('listFrames',agent,{signal},signal,'display_session_changed');},
    sendInfrared(agent,code,signal){
      if(current?.preferences?.infraredSend!==true)throw fail('ir-disabled');
      return runEffect('sendInfrared',agent,code,signal,'ir_session_changed');
    },
    readNfc(agent,request,signal){return runEffect('readNfc',agent,request,signal,'nfc_session_changed');},
    setVolume(agent,volume,signal){return runEffect('setVolume',agent,volume,signal,'volume_session_changed');},
    setRing(agent,effect,signal){return runEffect('setRing',agent,effect,signal,'ring_session_changed');},
    setRingFrames(agent,effect,signal){return runEffect('setRingFrames',agent,effect,signal,'ring_session_changed');},
    async expression(agent,expression,signal){
      signal?.throwIfAborted();
      const r=current;
      if(disposed||!r||r.cancelled||phase!=='listening'||r.bridge?.status().state!=='bridged')throw fail('capability_inactive');
      if(!agent?.id)throw fail('capability_session_required');
      if(key(r.preferences)!==key(getPreferences()))throw fail('voice_restart_required');
      const connection=r.transport.connection;
      if(!connection)throw fail('voice_device_missing');
      return connection.setExpression(expression,{signal});
    },
    async environment(action,signal){
      if(!['inspect','verify'].includes(action))throw fail('voice_action_invalid');
      return runOffline((environment,combined)=>environment[action](combined),signal,'voice_environment_failed');
    },
    preview(request,signal){
      return runOffline((environment,combined)=>environment.preview(request,combined),signal,'voice_preview_failed');
    },
    async execute(action,signal){
      if(disposed)throw fail('voice_disposed');
      if(action==='snapshot')return snapshot();
      if(action==='shutdown')return shutdown();
      if(action==='stop'){
        const r=current;if(!r?.bridge)throw fail('voice_not_started');
        r.diagnostics?.stage('settings-stop-requested');
        ++revision;job?.abort.abort();
        // Does not stop the listener or relinquish its identity lock.
        const standby=r.standby;
        const peer=r.transport?.connection;
        standby?.abort.abort();
        const interrupted=r.outboundConnecting?job?.promise:null;
        const [result,prewarmClosed]=await Promise.all([
          r.bridge.stop('settings-stop'),
          Promise.resolve(r.voice.cancelPrewarm?.()).then(()=>true,()=>false),
        ]);
        const idle=result.state==='idle'&&!!peer&&peer===r.transport?.connection&&peer.snapshot().phase==='idle';
        await interrupted?.catch(()=>{});
        await standby?.done;
        deviceIdleConfirmed=idle||r.standbyStoppedConfirmed===true;
        r.standbyStoppedConfirmed=!!standby&&deviceIdleConfirmed;
        if(result.state!=='idle'||!prewarmClosed){lastError='voice_release_unconfirmed';throw fail(lastError);}
        lastError='';return snapshot();
      }
      if(action==='owner-voice-enroll'){
        // Samples come from the connected device's microphone, one utterance each.
        if(phase!=='listening'||current?.bridge?.status().state!=='bridged')throw fail('owner_voice_needs_connection');
        ownerVoice.begin();return snapshot();
      }
      if(action==='owner-voice-cancel'){ownerVoice.cancel();return snapshot();}
      if(action==='owner-voice-forget'){await ownerVoice.forget();return snapshot();}
      const inspecting=action==='check-installation';
      const preparing=['prepare-environment','repair-environment'].includes(action)||inspecting;
      const standbyMode=['arm-lan','arm-relay','arm-usb'].includes(action)?action.slice(4):undefined;
      if(!['start','connect'].includes(action)&&!standbyMode&&!preparing)throw fail('voice_action_invalid');
      if(job||current?.standby)throw fail('voice_busy');
      if(standbyMode)return armStandby(standbyMode,signal);
      if((action==='start'||preparing)&&(current||phase!=='stopped'))throw fail('voice_busy');
      if(preparing&&custom)throw fail('voice_installation_custom');
      const abort=new AbortController();const combined=signal?AbortSignal.any([signal,abort.signal]):abort.signal;
      const op={abort,revision:++revision};job=op;
      if(action==='start'){phase='starting';lastError='';deviceIdleConfirmed=false;}
      op.promise=preparing?(inspecting?setup.inspectPrerequisites(combined):setup.prepare({replace:action==='repair-environment',signal:combined})).then(()=>{lastError='';return snapshot();})
        :(action==='start'?start(combined):connect(combined));
      try{return await op.promise;}
      catch(error){
        const code=combined.aborted?'voice_cancelled':action==='connect'?publicConnectCode(error)
          :publicCode(error,preparing?'voice_installation_failed':'voice_start_failed');
        if(op.revision===revision)lastError=code;
        if(!current&&phase==='starting')phase='stopped';
        throw fail(code);
      }finally{if(job===op)job=null;}
    },
    async dispose(){disposed=true;try{await idleMotion.dispose();await shutdown();}finally{await setup.dispose();}},
  };
  return service;
}
