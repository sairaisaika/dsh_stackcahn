import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {VoiceController} from '../src/settings-voice-controller.mjs';
import {VoicePanel,VoicePreview} from '../src/settings-voice-view.mjs';
const state=(phase='stopped')=>({phase,connected:false,sessionId:'',pendingChanges:false,applied:false,lastError:'',deviceIdleConfirmed:false});
test('voice preview is explicit, uses draft preferences and hides playback when the draft changes',async()=>{
  const calls=[];
  const controller=new VoiceController({
    async preview(language,voice,speechRate){calls.push({language,voice,speechRate});return {ok:true,value:{language:'en',wav:'UklGRg=='}};},
  });
  const draft={language:'auto',voice:'af_maple',speechRate:0.85};
  const html=(props=draft)=>renderToStaticMarkup(React.createElement(VoicePreview,{controller,...props}));
  assert.match(html(),/生成试听/);
  assert.doesNotMatch(html(),/<audio/);
  assert.deepEqual(calls,[]);
  await controller.run('preview',draft);
  assert.deepEqual(calls,[draft]);
  assert.match(html(),/<audio controls="" preload="none".*data:audio\/wav;base64,UklGRg==/);
  assert.doesNotMatch(html(),/autoplay/i);
  assert.doesNotMatch(html({...draft,speechRate:1}),/<audio/);
  controller.dispose();
});
test('cancelling a preview aborts only its request and ignores a late sample',async()=>{
  let resolve,signal;
  const controller=new VoiceController({preview(_language,_voice,_rate,s){signal=s;return new Promise(r=>{resolve=r;});},
    execute(){assert.fail('preview cancellation must not call service shutdown');}});
  const pending=controller.run('preview',{language:'zh',voice:'zf_001',speechRate:1});
  controller.cancelPreview();
  assert.equal(signal.aborted,true);
  resolve({ok:true,value:{language:'zh',wav:'UklGRg=='}});
  await pending;
  assert.equal(controller.getSnapshot().preview,null);
  assert.equal(controller.getSnapshot().busy,false);
  controller.dispose();
});
test('camera panel shows authoritative permission, stale state, import and retention without an automatic capture',async()=>{
  let camera={capability:'available',status:'current',permission:'allowed',phase:'transferring',busy:true,error:'',attachmentsAvailable:true,operation:'importing',operationError:''};
  const calls=[];const controller=new VoiceController({async execute(action){calls.push(action);return {ok:true,value:{...state('active'),camera}};}});
  const html=()=>renderToStaticMarkup(React.createElement(VoicePanel,{controller}));
  assert.match(html(),/相机/);assert.deepEqual(calls,[]);
  await controller.run('snapshot');assert.match(html(),/设备已允许拍照/);assert.match(html(),/正在传送照片/);assert.match(html(),/正在验证并保存图片/);
  assert.match(html(),/可能随所选模型请求发送/);assert.match(html(),/不会删除已保存的照片/);
  camera={...camera,status:'stale',permission:'unknown',phase:'unknown'};await controller.run('snapshot');
  assert.match(html(),/相机实时状态未知/);assert.doesNotMatch(html(),/设备已允许拍照/);
  camera={...camera,status:'current',permission:'disabled',phase:'idle',error:'PRIVATE SECRET',operation:'failed',operationError:'camera_image_invalid'};
  await controller.run('snapshot');assert.match(html(),/设备已禁用拍照/);assert.match(html(),/图片解码或尺寸检查失败/);assert.doesNotMatch(html(),/PRIVATE SECRET/);
  assert.ok(calls.every(x=>x==='snapshot'));controller.dispose();
});
test('motion status shows release failure and expires the last known permission',async()=>{
  let motion={capability:'available',status:'current',permission:'allowed',phase:'fault',error:'release-unconfirmed'};
  const controller=new VoiceController({async execute(){return {ok:true,value:{...state('active'),motion}};}});
  const html=()=>renderToStaticMarkup(React.createElement(VoicePanel,{controller}));
  await controller.run('snapshot');
  assert.match(html(),/设备已允许动作/);
  assert.match(html(),/驱动释放未确认/);
  motion={...motion,status:'stale',permission:'unknown',phase:'unknown',error:''};
  await controller.run('snapshot');
  assert.match(html(),/设备动作许可与状态未知/);
  assert.doesNotMatch(html(),/设备已允许动作|驱动释放未确认/);
  controller.dispose();
});
test('runtime panel is passive, names saved preference semantics and renders actual returned phase',async()=>{
  const calls=[];const controller=new VoiceController({async execute(action){calls.push(action);return {ok:true,value:state('listening')};}});
  let html=renderToStaticMarkup(React.createElement(VoicePanel,{controller}));assert.deepEqual(calls,[]);assert.match(html,/启动语音服务/);assert.match(html,/保存偏好不会开始录音/);
  await controller.run('start');html=renderToStaticMarkup(React.createElement(VoicePanel,{controller}));assert.match(html,/尚未接通会话/);assert.match(html,/尚无已认证/);controller.dispose();
});
test('LAN standby exposes the explicit arm, device start and Mac revoke controls',async()=>{
  let value={...state('listening'),transport:'lan',lanStandby:false};
  const controller=new VoiceController({async execute(){return {ok:true,value};}});
  const html=()=>renderToStaticMarkup(React.createElement(VoicePanel,{controller}));
  await controller.run('snapshot');
  assert.match(html(),/<button type="button">开启局域网待命<\/button>/);
  value={...value,lanStandby:true};await controller.run('snapshot');
  assert.match(html(),/局域网待命中，在 Sion 点 Start/);
  assert.match(html(),/<button type="button">停止并关闭局域网待命<\/button>/);
  assert.match(html(),/<button type="button" disabled="">接通所选会话<\/button>/);
  controller.dispose();
});
test('USB standby shows the device entry, suppresses manual connect and allows revocation',async()=>{
  let value={...state('listening'),transport:'usb',usbStandby:false};
  const controller=new VoiceController({async execute(){return {ok:true,value};}});
  const html=()=>renderToStaticMarkup(React.createElement(VoicePanel,{controller}));
  await controller.run('snapshot');
  assert.match(html(),/<button type="button">开启 USB 待命<\/button>/);
  value={...value,usbStandby:true};await controller.run('snapshot');
  assert.match(html(),/USB 待命中，在 Sion 点 USB/);
  assert.match(html(),/<button type="button">停止并关闭 USB 待命<\/button>/);
  assert.match(html(),/<button type="button" disabled="">接通所选会话<\/button>/);
  controller.dispose();
});
test('relay permits explicit dial before authentication and distinguishes waiting from authenticated',async()=>{
  let value={...state('listening'),transport:'relay'};
  const controller=new VoiceController({async execute(){return {ok:true,value};}});
  const html=()=>renderToStaticMarkup(React.createElement(VoicePanel,{controller}));
  await controller.run('snapshot');
  assert.match(html(),/<button type="button">接通所选会话<\/button>/);
  value={...value,phase:'connecting'};await controller.run('snapshot');
  assert.match(html(),/正在等待 Sion 接入中继/);
  value={...value,phase:'active',connected:true};await controller.run('snapshot');
  assert.match(html(),/外出中继连接已认证/);
  value={...value,phase:'fault',connected:false,canReconnect:false};await controller.run('snapshot');
  assert.match(html(),/<button type="button" disabled="">接通所选会话<\/button>/);
  value={...value,canReconnect:true};await controller.run('snapshot');
  assert.match(html(),/<button type="button">重新接通所选会话<\/button>/);
  assert.match(html(),/旧连接的设备释放未确认/);
  controller.dispose();
});
test('latency panel shows only the last completed sample when enabled, including zero-ms acknowledgements',async()=>{
  let latency={enabled:false,latest:null};
  const controller=new VoiceController({async execute(){return {ok:true,value:{...state('active'),transport:'usb',latency}};}});
  const html=()=>renderToStaticMarkup(React.createElement(VoicePanel,{controller}));
  await controller.run('snapshot');assert.doesNotMatch(html(),/最近一次完整播报|各阶段耗时/);
  latency={enabled:true,latest:null};await controller.run('snapshot');assert.match(html(),/这里会显示各阶段耗时/);
  latency={enabled:true,latest:{asrMs:320,dshAdmissionMs:1200,outputAckMs:0,segmentToFirstOutputAckMs:1900,sessionId:'PRIVATE'}};
  await controller.run('snapshot');
  assert.match(html(),/最近一次完整播报 · USB/);
  assert.match(html(),/等待提交 DSH<\/th><td>1200 ms/);
  assert.match(html(),/设备首帧确认<\/th><td>0 ms/);
  assert.doesNotMatch(html(),/PRIVATE|undefined ms/);
  controller.dispose();
});
test('shutdown preempts pending UI operation and late responses cannot restore stale active display',async()=>{
  let resolve;let signal;const controller=new VoiceController({execute(action,s){if(action==='start'){signal=s;return new Promise(r=>{resolve=r;});}return Promise.resolve({ok:true,value:state()});}});
  const first=controller.run('start');await controller.run('shutdown');assert.ok(signal.aborted);
  resolve({ok:true,value:state('active')});await first;assert.equal(controller.getSnapshot().snapshot.phase,'stopped');controller.dispose();
});
test('runtime UI shows only fixed error text and disposal ignores late private errors',async()=>{
  const controller=new VoiceController({async execute(){return {ok:false,error:{code:'stackchan/voice-failed',message:'PRIVATE KEY',details:{reason:'voice_unconfigured'}}};}});
  await controller.run('start');assert.match(controller.getSnapshot().error,/尚未配置/);assert.doesNotMatch(controller.getSnapshot().error,/PRIVATE/);controller.dispose();
});

test('mounted status watcher only reads and disposing it cancels its in-flight snapshot',async()=>{
  let signal;let finish;const calls=[];const controller=new VoiceController({execute(action,s){calls.push(action);signal=s;return new Promise(resolve=>{finish=resolve;});}});
  const stop=controller.watch();assert.deepEqual(calls,['snapshot']);stop();controller.dispose();assert.equal(signal.aborted,true);
  finish({ok:true,value:state('active')});await Promise.resolve();assert.equal(controller.getSnapshot().snapshot,null);
});

test('environment checks are explicit, distinguish metadata from inference and ignore cancelled late success',async()=>{
  const calls=[];let complete;
  const report={checkedAt:1,checks:[{id:'python',status:'missing'}],filesVerified:false,loadTest:'not_run',failedStage:'',assetBytes:558924578};
  const controller=new VoiceController({async execute(){return {ok:true,value:state()};},environment(action){calls.push(action);if(action==='verify')return new Promise(resolve=>{complete=resolve;});return Promise.resolve({ok:true,value:report});}});
  let html=renderToStaticMarkup(React.createElement(VoicePanel,{controller}));assert.deepEqual(calls,[]);assert.match(html,/检查语音环境/);
  await controller.run('inspect-environment');html=renderToStaticMarkup(React.createElement(VoicePanel,{controller}));assert.match(html,/缺少文件或依赖/);assert.match(html,/环境尚未完整/);
  const pending=controller.run('test-environment');await controller.run('shutdown');complete({ok:true,value:{...report,filesVerified:true,loadTest:'passed'}});await pending;
  assert.equal(controller.getSnapshot().environment,null);controller.dispose();
});

test('background runtime polling does not erase an environment check error',async()=>{
  const controller=new VoiceController({async environment(){return {ok:false,error:{code:'stackchan/voice-failed',details:{reason:'voice_environment_failed'}}};},async execute(){return {ok:true,value:state()};}});
  await controller.run('inspect-environment');assert.match(controller.getSnapshot().environmentError,/检查未完成/);
  await controller.run('snapshot');assert.match(controller.getSnapshot().environmentError,/检查未完成/);controller.dispose();
});

test('installation progress can refresh while action is pending and old polls cannot overwrite completion',async()=>{
  let finishInstall,finishPoll;let installSignal;
  const snapshot=(stage,busy)=>({...state(),installation:{mode:'managed',stage,busy,available:stage==='ready',error:''}});
  const controller=new VoiceController({execute(action,signal){
    if(action==='prepare-environment'){installSignal=signal;return new Promise(r=>{finishInstall=r;});}
    return new Promise(r=>{finishPoll=r;});
  }});
  const install=controller.run('prepare-environment');const poll=controller.run('snapshot');
  finishPoll({ok:true,value:snapshot('models',true)});await poll;
  assert.equal(installSignal.aborted,false);assert.equal(controller.getSnapshot().busy,true);
  let html=renderToStaticMarkup(React.createElement(VoicePanel,{controller}));assert.match(html,/下载并校验语音模型/);assert.match(html,/取消安装并等待退出/);
  const stale=controller.run('snapshot');finishInstall({ok:true,value:snapshot('ready',false)});await install;
  finishPoll({ok:true,value:snapshot('models',true)});await stale;
  assert.equal(controller.getSnapshot().snapshot.installation.stage,'ready');assert.equal(controller.getSnapshot().busy,false);
  controller.dispose();
});

test('repair cancellation ignores late success and custom environments expose no managed install controls',async()=>{
  let complete,signal;
  const custom={...state(),installation:{mode:'custom',stage:'idle',busy:false,available:false,error:''}};
  const controller=new VoiceController({execute(action,s){if(action==='repair-environment'){signal=s;return new Promise(r=>{complete=r;});}return Promise.resolve({ok:true,value:custom});}});
  const work=controller.run('repair-environment');await controller.run('shutdown');assert.ok(signal.aborted);
  complete({ok:true,value:{...state(),installation:{mode:'managed',stage:'ready',busy:false,available:true,error:''}}});await work;
  const html=renderToStaticMarkup(React.createElement(VoicePanel,{controller}));assert.match(html,/Host 自定义语音环境/);assert.doesNotMatch(html,/>重新构建并修复<|>准备语音环境</);
  controller.dispose();
});

test('installation failure does not invent a device resource-release warning',async()=>{
  const controller=new VoiceController({async execute(){return {ok:true,value:{...state(),lastError:'voice_installation_failed',installation:{mode:'managed',stage:'failed',busy:false,available:true,error:'voice_installation_failed'}}};}});
  await controller.run('snapshot');const html=renderToStaticMarkup(React.createElement(VoicePanel,{controller}));
  assert.match(html,/本次准备未完成/);assert.match(html,/已观察到通过发布校验/);assert.doesNotMatch(html,/设备资源是否释放仍未确认/);controller.dispose();
});

test('installation guidance shows missing conditions and never equates prerequisites with model readiness',async()=>{
 const prerequisites={checkedAt:1,platform:'available',python:'missing',developerTools:'missing',ready:false};let current={...prerequisites};const calls=[];
 const controller=new VoiceController({async execute(action){calls.push(action);return {ok:true,value:{...state(),installation:{mode:'managed',stage:'idle',busy:false,available:false,error:'',prerequisites:current}}};}});
 let html=renderToStaticMarkup(React.createElement(VoicePanel,{controller}));assert.deepEqual(calls,[]);assert.match(html,/检查安装条件/);
 await controller.run('check-installation');html=renderToStaticMarkup(React.createElement(VoicePanel,{controller}));
 assert.match(html,/安装条件未齐备/);assert.match(html,/<details open="">/);assert.match(html,/xcode-select --install/);assert.match(html,/brew install python@3.11/);assert.match(html,/https:\/\/developer.apple.com/);
 current={...prerequisites,python:'available',developerTools:'available',ready:true};await controller.run('check-installation');html=renderToStaticMarkup(React.createElement(VoicePanel,{controller}));
 assert.match(html,/模型尚未因此安装或验证/);assert.doesNotMatch(html,/本地环境自检通过/);assert.deepEqual(calls,['check-installation','check-installation']);controller.dispose();
});

test('ring settings show current or stale hardware status without opening the ring',async()=>{
  let ring={capability:'available',status:'current',permission:'allowed',phase:'fault',error:'release-unconfirmed'};
  const actions=[];
  const controller=new VoiceController({async execute(action){
    actions.push(action);
    return {ok:true,value:{...state('active'),ring}};
  }});
  const html=()=>renderToStaticMarkup(React.createElement(VoicePanel,{controller}));
  assert.match(html(),/灯环/);
  assert.deepEqual(actions,[]);
  await controller.run('snapshot');
  assert.match(html(),/设备已允许灯效/);
  assert.match(html(),/灯环关闭未确认/);
  ring={...ring,status:'stale'};
  await controller.run('snapshot');
  assert.match(html(),/灯环许可与状态未知/);
  assert.doesNotMatch(html(),/设备已允许灯效|灯环关闭未确认/);
  assert.deepEqual(actions,['snapshot','snapshot']);
  controller.dispose();
});

test('device capability panel renders the passive report and lists unavailable interfaces',async()=>{
  let report={version:1,voicePhase:'listening',features:{
    audio:{availability:'supported',version:1,condition:'needs-voice'},
    expression:{availability:'unsupported'},
    ring:{availability:'unknown'},
  },notExposed:['infrared','nfc']};
  const actions=[];
  const controller=new VoiceController({async execute(action){
    actions.push(action);
    return {ok:true,value:{...state('listening'),capabilities:report}};
  }});
  const html=()=>renderToStaticMarkup(React.createElement(VoicePanel,{controller}));
  assert.doesNotMatch(html(),/设备能力与限制/);
  assert.deepEqual(actions,[]);
  await controller.run('snapshot');
  assert.match(html(),/v1 · 等待接通所选会话/);
  assert.match(html(),/本固件未声明支持/);
  assert.match(html(),/尚未取得设备能力/);
  assert.match(html(),/红外、NFC/);
  assert.doesNotMatch(html(),/当前回复方式|Sion 电量/);
  report={...report,conversation:{replyMode:'caption-only',captionChannel:'requested'}};
  await controller.run('snapshot');
  assert.match(html(),/当前回复方式.*仅字幕/);
  assert.match(html(),/当前连接已请求字幕/);
  report={...report,battery:{version:1,status:'current',percent:0,direction:'discharging'}};
  await controller.run('snapshot');
  assert.match(html(),/<dt>Sion 电量<\/dt><dd>0% · 电池供电<\/dd>/);
  report={...report,battery:{version:1,status:'stale'}};
  await controller.run('snapshot');
  assert.match(html(),/<dt>Sion 电量<\/dt><dd>暂时无法读取<\/dd>/);
  assert.doesNotMatch(html(),/0% · 电池供电/);
  report={...report,ambient:{version:1,status:'current',proximityRaw:0}};
  await controller.run('snapshot');
  assert.match(html(),/<dt>光线（原始值）<\/dt><dd>暂时无法读取<\/dd>/);
  assert.match(html(),/<dt>近接（原始值）<\/dt><dd>0<\/dd>/);
  report={...report,ambient:{version:1,status:'current',light:{channel0:12,channel1:3},proximityRaw:45}};
  await controller.run('snapshot');
  assert.match(html(),/CH0 12 · CH1 3/);
  assert.match(html(),/<dt>近接（原始值）<\/dt><dd>45<\/dd>/);
  assert.deepEqual(actions,Array(6).fill('snapshot'));
  controller.dispose();
});
