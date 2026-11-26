import React from 'react';
import {voiceErrorMessage} from './settings-voice-controller.mjs';
import speechAssets from '../vendor/voice/assets.json' with {type:'json'};
import audioAssets from '../vendor/audio/assets.json' with {type:'json'};
import aecAssets from '../vendor/audio/aec-v12.json' with {type:'json'};
import installerAssets from '../vendor/voice/installer-assets.json' with {type:'json'};
const h=React.createElement;
const downloadMB=Math.ceil([...speechAssets.files,...audioAssets.files,...aecAssets.files,...installerAssets.files].reduce((sum,file)=>sum+file.bytes,0)/1000000);
const stages={idle:'尚未检查托管安装',checking:'正在检查安装条件',prerequisites:'检查安装前置条件',python:'创建专用 Python 环境',dependencies:'安装固定版本依赖',models:'下载并校验语音模型',audio:'构建输入音频组件',whisper:'构建 Whisper 识别程序',verifying:'运行离线模型自检',publishing:'发布活动环境',ready:'本地环境自检通过',failed:'本次准备未完成'};
const labels={stopped:'语音服务未运行',starting:'正在启动服务',listening:'服务已启动，尚未接通会话',connecting:'正在绑定会话并准备音频',active:'连续语音已接通',stopping:'正在等待资源释放',fault:'需要恢复或检查设备',disposed:'插件已停用'};
const connectionLabels={usb:'USB',relay:'外出中继',lan:'局域网'};
const checkLabels={platform:'Mac 平台',python:'独立 Python 3.11',packages:'固定依赖版本',whisper:'Whisper 程序',speechAssets:'识别与合成模型',audioAssets:'回声消除与分句资产',nativeLibraries:'音频原生库',temporaryDirectory:'临时工作目录'};
const statuses={not_checked:'尚未检查',unconfigured:'尚未配置',missing:'缺少文件或依赖',invalid:'校验失败或版本不匹配',unsupported:'当前版本或平台不支持',available:'可用',verified:'校验通过'};
const cameraPhases={unknown:'设备状态未知',idle:'相机当前空闲',opening:'正在打开相机',capturing:'正在拍照',closing:'正在关闭相机',transferring:'正在传送照片',fault:'相机释放失败'};
const cameraOperations={idle:'尚未请求照片',capturing:'正在等待设备照片',importing:'正在验证并保存图片',saved:'上次照片已交给 DSH',failed:'上次照片未能交给 DSH',cancelling:'旧图片结果已作废，等待当前处理结束'};
const cameraErrors={disabled:'设备未允许拍照',unavailable:'相机服务不可用',memory:'设备相机内存不足',open:'相机打开失败',capture:'采集失败',invalid:'设备图片无效',timeout:'拍照或传输超时',close:'相机释放未确认',cancelled:'照片请求已取消',busy:'上一张照片仍在处理',unsupported:'设备未提供拍照能力',camera_image_invalid:'图片解码或尺寸检查失败',camera_attachment_failed:'DSH 图片保存失败',camera_attachments_unavailable:'DSH 附件服务不可用',unknown:'本次照片结果未确认'};
function CameraPanel({camera,unreachable}){
  const current=camera?.status==='current'&&!unreachable;
  return h('section',{'aria-label':'相机',style:{display:'grid',gap:6}},
    h('h3',null,'相机'),
    h('p',{role:'status'},!camera||camera.capability==='disconnected'?'尚无已认证的相机连接':camera.capability==='unsupported'?'设备未提供拍照能力':
      !current?'相机实时状态未知；可能是旧固件、报告尚未到达或已经过期':camera.permission==='allowed'?'设备已允许拍照':'设备已禁用拍照'),
    h('p',null,current?cameraPhases[camera.phase]:'设备状态未知'),
    camera&&h('p',{role:'status'},unreachable?'无法读取当前处理状态':cameraOperations[camera.operation]),
    current&&camera.error&&h('p',{role:'alert'},'设备：'+(cameraErrors[camera.error]??cameraErrors.unknown)),
    !unreachable&&camera?.operationError&&h('p',{role:'alert'},'上次处理：'+(cameraErrors[camera.operationError]??cameraErrors.unknown)),
    camera&&!camera.attachmentsAvailable&&h('p',null,'DSH 附件服务尚不可用，拍照工具会在采集前拒绝。'),
    h('p',null,'在 Sion 的 Settings → Camera 中允许或禁用拍照。允许不自动拍照；接通后由所选会话按原工具权限请求。停止对话会取消未提交的照片结果。'),
    h('p',null,'照片会作为附件保存在 DSH 中，并可能随所选模型请求发送给该模型服务。停止或禁用相机不会删除已保存的照片；保存途中取消也可能留下未被会话引用的图片。请按 DSH 的数据管理方式处理保留记录。文字模型不能直接看图，插件不会自动更换模型。'));
}
const motionPhases={idle:'动作空闲',opening:'正在准备舵机',commanding:'正在发送动作指令',moving:'正在移动',releasing:'正在释放驱动',fault:'驱动释放未确认'};
const motionErrors={open:'舵机初始化失败',command:'舵机指令失败',feedback:'位置反馈无效',stall:'检测到舵机阻塞',timeout:'动作超时','release-unconfirmed':'请检查设备上的驱动释放状态。'};
function MotionPanel({motion,unreachable}){
  const current=motion?.status==='current'&&!unreachable;
  return h('section',{'aria-label':'动作',style:{display:'grid',gap:6}},
    h('h3',null,'动作'),
    h('p',{role:'status'},unreachable?'无法读取设备动作状态':
      !motion||motion.capability==='disconnected'?'尚无已认证的设备连接':
      motion.capability==='unsupported'?'设备未提供动作能力':
      !current?'设备动作许可与状态未知':motion.permission==='allowed'?'设备已允许动作':'设备已禁用动作'),
    current&&h('p',null,motionPhases[motion.phase]),
    current&&motion.error&&h('p',{role:'alert'},motionErrors[motion.error]),
    h('p',null,'在 Sion 的 Settings → Motion 中允许或禁用动作。接通后，所选会话可按 DSH 工具权限请求转头。'));
}
const ringPhases={idle:'灯环空闲',preparing:'正在准备灯环',lit:'灯效运行中',clearing:'正在关闭灯环',fault:'灯环关闭未确认'};
const ringErrors={open:'灯环初始化失败',write:'灯效写入失败','release-unconfirmed':'请检查设备上的灯环关闭状态。'};
function RingPanel({ring,unreachable}){
  const current=ring?.status==='current'&&!unreachable;
  return h('section',{'aria-label':'灯环',style:{display:'grid',gap:6}},
    h('h3',null,'灯环'),
    h('p',{role:'status'},unreachable?'无法读取灯环状态':
      !ring||ring.capability==='disconnected'?'尚无已认证的设备连接':
      ring.capability==='unsupported'?'设备未提供灯环能力':
      !current?'灯环许可与状态未知':ring.permission==='allowed'?'设备已允许灯效':'设备已禁用灯效'),
    current&&h('p',null,ringPhases[ring.phase]),
    current&&ring.error&&h('p',{role:'alert'},ringErrors[ring.error]),
    h('p',null,'在 Sion 的 Settings → Ring 中允许或禁用灯效。接通后，所选会话可按 DSH 工具权限请求有限时长的灯效。'));
}
const capabilityNames={audio:'麦克风输入',playbackFence:'播放排空确认',expression:'屏幕表情',camera:'拍照',motion:'转头',ring:'灯环'};
const capabilityConditions={
  'not-available':'不可用','needs-voice':'等待接通所选会话','restart-required':'偏好已修改，需重启语音服务',
  ready:'当前条件满足','permission-disabled':'设备许可关闭','permission-unknown':'设备许可或状态未知',
  busy:'设备正在处理','fault':'设备报告故障','avatar-page-required':'需要设备显示 Avatar 页',
  'attachment-service-unavailable':'DSH 附件服务不可用',
};
const replyModes={inactive:'未接通对话',spoken:'语音播报', 'caption-only':'仅字幕'};
const captionChannels={unknown:'尚未取得设备状态',requested:'当前连接已请求字幕','not-requested':'当前连接未请求字幕'};
const batteryDirections={charging:'充电中',discharging:'电池供电',idle:'未检测到充放电'};
const notExposedNames={
  ambientSensors:'光线与距离',inertialSensors:'惯性传感器',magnetometer:'磁力计',batteryAndClock:'电量和时钟',clock:'时钟',
  touchAndButtons:'触摸和实体按键',screenTouchAndButtons:'屏幕触摸和实体按键',infrared:'红外',nfc:'NFC',removableStorage:'microSD',
  grove:'Grove 扩展口',bluetooth:'蓝牙',factoryApps:'原厂应用',customWake:'自定义唤醒',
};
function DeviceCapabilitiesPanel({report,unreachable}){
  if(!report&&!unreachable)return null;
  const conversation=report?.conversation;
  const battery=report?.battery;
  const ambient=report?.ambient;
  const headTouch=report?.headTouch;
  const latestGesture=headTouch?.recentGestures?.at(-1);
  const imu=report?.imu;
  return h('details',null,h('summary',null,'设备能力与限制'),
    unreachable?h('p',{role:'status'},'暂时无法读取设备能力'):
      h(React.Fragment,null,
        conversation&&h('dl',null,
          h('dt',null,'当前回复方式'),h('dd',null,replyModes[conversation.replyMode]),
          h('dt',null,'设备字幕'),h('dd',null,captionChannels[conversation.captionChannel])),
        battery&&h('dl',null,h('dt',null,'Sion 电量'),h('dd',null,battery.status==='current'?
          `${battery.percent}% · ${batteryDirections[battery.direction]}`:'暂时无法读取')),
        ambient&&h('dl',null,
          h('dt',null,'光线（原始值）'),h('dd',null,ambient.status==='current'&&ambient.light?
            `CH0 ${ambient.light.channel0} · CH1 ${ambient.light.channel1}`:'暂时无法读取'),
          h('dt',null,'近接（原始值）'),h('dd',null,ambient.status==='current'&&ambient.proximityRaw!==undefined?
            String(ambient.proximityRaw):'暂时无法读取')),
        headTouch&&h('dl',null,h('dt',null,'头顶触摸（通道 1–3）'),
          h('dd',null,headTouch.status==='current'&&headTouch.levels?headTouch.levels.join(' · '):'暂时无法读取'),
          headTouch.version===2&&h('dt',null,'最近一次摸头'),
          headTouch.version===2&&h('dd',null,latestGesture?
            `${touchGestureNames[latestGesture.kind]} · ${latestGesture.durationMs} ms · 感应 ${latestGesture.peak}/3`:'未检测到近期手势')),
        imu&&h('dl',null,
          h('dt',null,'加速度（X、Y、Z，mg）'),h('dd',null,imu.accelerationMg?.join(' · ')??'暂时无法读取'),
          h('dt',null,'角速度（X、Y、Z，°/s）'),h('dd',null,imu.angularVelocityMdps?.map(value=>(value/1000).toFixed(2)).join(' · ')??'暂时无法读取')),
        h('dl',null,Object.entries(capabilityNames).flatMap(([id,label])=>{
          const feature=report.features[id];
          const text=feature?.availability==='supported'?
            `v${feature.version} · ${capabilityConditions[feature.condition]??'状态未知'}`:
            feature?.availability==='unsupported'?'本固件未声明支持':'尚未取得设备能力';
          return [h('dt',{key:id},label),h('dd',{key:`${id}-status`},text)];
        })),
        h('p',null,'本插件暂未提供 '+report.notExposed.map(id=>notExposedNames[id]).filter(Boolean).join('、'))));
}
const touchGestureNames={
  tap:'轻点',hold:'长按',toward_channel_1:'滑向通道 1',toward_channel_3:'滑向通道 3',
};
const latencyLabels={
  asrQueueMs:'等待识别',asrMs:'Whisper 识别',bridgeQueueMs:'语音桥排队',dshAdmissionMs:'等待提交 DSH',
  dshPromptToTurnEndMs:'DSH 回合执行',ttsFirstPcmMs:'最终播报首块',outputAckMs:'设备首帧确认',
  ttsPreparedBeforeTurnEndMs:'首句提前合成',segmentToFirstOutputAckMs:'分句完成到首帧确认',
};
function LatencyPanel({latency,transport,unreachable}){
  if(!latency?.enabled)return null;
  const latest=latency.latest;
  return h('section',{'aria-label':'语音延迟'},
    h('h3',null,'语音延迟'),
    unreachable?h('p',{role:'status'},'暂时无法读取语音延迟。'):
      latest?h('table',null,h('caption',null,`最近一次完整播报 · ${connectionLabels[transport]}`),
        h('tbody',null,...Object.entries(latencyLabels).filter(([field])=>Number.isFinite(latest[field])).map(([field,label])=>
          h('tr',{key:field},h('th',{scope:'row',style:{textAlign:'left',paddingRight:16}},label),
            h('td',null,`${latest[field]} ms`))))):
      h('p',{role:'status'},'接通后完成一次播报，这里会显示各阶段耗时。'),
    h('p',null,'计时从 Mac 完成分句开始，到设备确认收到首个音频帧。'));
}
export function VoicePreview({controller,language,voice,speechRate,disabled}){
  const state=React.useSyncExternalStore(controller.subscribe,controller.getSnapshot,controller.getSnapshot);
  const request={language,voice,speechRate};
  const sample=state.preview?.preferences===JSON.stringify(request)?state.preview.sample:null;
  const preparing=state.busy&&state.action==='preview';
  const stopped=!state.snapshot||state.snapshot.phase==='stopped';
  return h('div',{style:{display:'grid',gap:6}},
    h('button',{type:'button',disabled:disabled||state.busy||!stopped||!['','zf_001','zf_038','af_maple'].includes(voice),
      onClick:()=>controller.run('preview',request)},'生成试听'),
    preparing&&h('p',{role:'status'},'正在生成试听…'),
    preparing&&h('button',{type:'button',onClick:()=>controller.cancelPreview()},'取消试听'),
    state.previewError&&h('p',{role:'alert'},state.previewError),
    sample&&!disabled&&stopped&&h('audio',{controls:true,preload:'none',disableRemotePlayback:true,
      'aria-label':sample.language==='zh'?'播放中文音色试听':'播放英语音色试听',src:`data:audio/wav;base64,${sample.wav}`}),
    h('p',null,stopped?'试听使用当前的语言、音色和语速。生成后可在此播放。':'关闭语音服务后可试听。'));
}

export function VoiceQuickStatus({controller}){
  const state=React.useSyncExternalStore(controller.subscribe,controller.getSnapshot,controller.getSnapshot);
  const s=state.snapshot;
  const standby=s?.relayStandby||s?.lanStandby||s?.usbStandby;
  const canStop=standby||['active','connecting','fault'].includes(s?.phase)||
    ['connect','arm-relay','arm-lan','arm-usb'].includes(state.action);
  if (!s&&!state.error) return null;
  return h('div',{style:{display:'flex',alignItems:'center',justifyContent:'space-between',flexWrap:'wrap',gap:10}},
    h('span',{role:'status'},state.error||
      (standby&&s?.phase==='listening'?`${connectionLabels[s.transport]}待命中`:labels[s?.phase])),
    canStop&&h('button',{type:'button',onClick:()=>controller.run('stop')},standby?'停止待命':'停止对话'));
}

/** Plain-language state of the owner-voice profile. The profile itself never reaches the page. */
export function ownerVoiceText(voice){
  if(!voice.available)return '声纹模型不可用：本机语音环境里没有找到说话人识别模型。';
  if(voice.enrolling)return `正在登记：请对着 Sion 说「小D在吗」，已记录 ${voice.collected}/${voice.needed} 句。登记期间说的话不会交给 DSH。`;
  const result={enrolled:'登记完成。',inconsistent:'登记没有成功：这几句听起来不像同一个人，请在安静时重试。',
    incomplete:'登记没有完成。',cancelled:'已取消登记。',forgotten:'已删除声纹。','enrolled-unsaved':'登记完成，但没能保存，重启后需要重新登记。'}[voice.lastResult]??'';
  const policy={off:'目前谁说都算。',wake:'目前只有你能叫醒它。',always:'目前全程只听你的声音。'}[voice.policy]??'';
  return `${result}${voice.enrolled?'已登记你的声音。':'还没有登记你的声音；接通 Sion 后可以登记。'}${voice.enrolled||voice.policy==='off'?policy:'已要求只认你的声音但尚未登记，所以现在语音叫不醒它，只能点脸或长按头顶。'}`;
}

export function VoicePanel({controller,section='all'}){
  const environment=section==='all'||section==='environment';
  const runtime=section==='all'||section==='runtime';
  const device=section==='all'||section==='device';
  React.useEffect(()=>runtime?controller.watch():undefined,[controller,runtime]);
  const state=React.useSyncExternalStore(controller.subscribe,controller.getSnapshot,controller.getSnapshot);
  const s=state.snapshot;
  const report=state.environment;
  const installation=s?.installation;
  const prerequisites=installation?.prerequisites;
  const checking=installation?.stage==='checking'||state.busy&&state.action==='check-installation';
  const installing=!!installation?.busy||state.busy&&['prepare-environment','repair-environment','check-installation'].includes(state.action);
  const stopped=!s||s.phase==='stopped';
  const standby=s?.relayStandby||s?.lanStandby||s?.usbStandby;
  const waiting=s?.lanStandby?'局域网待命中，在 Sion 点 Start':s?.usbStandby?'USB 待命中，在 Sion 点 USB':'外出待命中，在 Sion 点 Relay';
  const stopLabel=s?.lanStandby?'停止并关闭局域网待命':s?.usbStandby?'停止并关闭 USB 待命':s?.relayStandby?'停止并关闭外出待命':'停止对话';
  const canArm=!state.busy&&!standby&&!s?.connected&&(s?.phase==='listening'||s?.canReconnect)&&!s?.pendingChanges;
  const button=(action,label,disabled=false)=>h('button',{type:'button',disabled,onClick:()=>controller.run(action)},label);
  return h('section',{'aria-label':section==='environment'?'本地语音环境':section==='device'?'设备能力与限制':'语音运行',style:{display:'grid',gap:10}},
    environment&&h(React.Fragment,null,
    h('h3',null,'本地语音环境'),
    h('p',null,'首次使用请准备本地语音环境。下载和构建完成后自动进行离线自检，通过后才启用该环境；安装不会启动语音服务。随后请在会话与语音偏好中选择已有会话、Whisper.cpp 和 Kokoro，并保存。'),
    h('p',null,'固定模型及源码约 '+downloadMB+' MB，另需 CMake、Python 依赖和编译空间。下载来源为 Hugging Face、GitHub、Xiph 和 PyPI；下载后语音推理在 Mac 本地运行。'),
    installation?.mode!=='custom'&&h(React.Fragment,null,
      button('check-installation','检查安装条件',state.busy||installation?.busy||!stopped||installation?.mode==='unavailable'),
      h('p',null,'只检查这台 Mac、Python 3.11 和现有开发工具；不下载模型、不打开系统安装器。'),
      prerequisites&&h(React.Fragment,null,
        h('table',null,h('caption',null,'最近一次安装条件检查'),h('tbody',null,
          ...[['platform','Apple 芯片 Mac'],['python','Apple 芯片版 Python 3.11'],['developerTools','Apple 命令行开发工具']].map(([id,label])=>h('tr',{key:id},h('th',{scope:'row',style:{textAlign:'left',paddingRight:16}},label),h('td',null,statuses[prerequisites[id]]))))),
        h('p',{role:'status'},prerequisites.ready?'安装前置条件已具备，可以准备语音环境；模型尚未因此安装或验证。':'安装条件未齐备，请按下面的指引处理后重新检查。'),
        prerequisites.platform==='unsupported'&&h('p',null,'请在 Apple 芯片 Mac 上运行原生版本的 DSH；当前不支持 Intel 或 Rosetta 运行环境。')),
      h('details',{open:!!prerequisites&&!prerequisites.ready},h('summary',null,'首次安装指引'),
        h('ol',null,
          h('li',null,'安装 Apple 命令行开发工具：在 Mac 终端运行 ',h('code',null,'xcode-select --install'),'，完成系统弹出的安装流程。已安装完整 Xcode 且工具可用时无需另装。 ',h('a',{href:'https://developer.apple.com/documentation/xcode/installing-the-command-line-tools/',target:'_blank',rel:'noopener noreferrer'},'Apple 安装说明')),
          h('li',null,'安装 Apple 芯片版 Python 3.11：已有 Homebrew 时，在终端运行 ',h('code',null,'brew install python@3.11'),'。尚无 Homebrew 时，先按其官方说明安装并完成终端配置。 ',h('a',{href:'https://docs.brew.sh/Installation',target:'_blank',rel:'noopener noreferrer'},'Homebrew 安装说明'),' · ',h('a',{href:'https://formulae.brew.sh/formula/python@3.11',target:'_blank',rel:'noopener noreferrer'},'Python 3.11 安装说明')),
          h('li',null,'返回此页重新“检查安装条件”。通过后点击“准备语音环境”，等待下载、构建和离线自检完成。'),
          h('li',null,'选择已有 DSH 会话、Whisper.cpp 和 Kokoro，保存偏好后继续配对和连接。')),
        h('p',null,'这些系统工具由你在终端或官方安装器中安装。插件不会代为执行上述安装命令；请保留 Python 基础解释器，专用语音环境依赖它。'))),
    h('details',null,h('summary',null,'安装条件、许可与修复说明'),
      h('p',null,'目前支持 Apple 芯片 Mac，需已有 Python 3.11 和 Apple 命令行开发工具。安装只写当前 DSH 配置档的专用目录，不修改系统 Python。'),
      h('p',null,'Whisper / GGML 使用 MIT，Kokoro / LocalVQE 使用 Apache-2.0，SpeexDSP 使用 BSD；语音依赖也包含 GPL 组件，完整说明随插件和依赖保留。'),
      h('p',null,'准备会复查并复用当前版本的活动环境。首次准备新版本和重新构建都会先建立独立环境，自检通过后才启用。旧环境和失败候选保留，暂不自动清理。'),
      h('p',null,'安装日志保存在当前配置档 .stackchan-voice 下各候选目录的 installation.log；基础解释器仍需保留，环境依赖它运行。')),
    installation?.mode==='custom'?h('p',null,'当前使用 Host 自定义语音环境；自动准备和修复不会覆盖它。'):
      h('div',{style:{display:'flex',gap:8,flexWrap:'wrap'}},
        button('prepare-environment','准备语音环境',state.busy||installing||!stopped||installation?.mode==='unavailable'),
        button('repair-environment','重新构建并修复',state.busy||installing||!stopped||installation?.mode==='unavailable')),
    installation?.mode==='unavailable'&&h('p',{role:'alert'},'宿主尚未提供配置档目录，无法自动安装。'),
    installation?.mode==='managed'&&h('p',{role:'status'},stages[installation.stage]),
    installation?.available&&h('p',null,'已观察到通过发布校验的活动环境。启动服务前会重新检查，不代表设备已经接通。'),
    installation?.error&&h('p',{role:'alert'},voiceErrorMessage(installation.error)),
    installing&&button('shutdown',checking?'取消条件检查':'取消安装并等待退出',state.action==='shutdown'),
    h('p',null,'检查环境和离线自检不会下载。自检使用固定合成样本，不录音、不播放、不发送到 DSH 会话。'),
    h('div',{style:{display:'flex',gap:8,flexWrap:'wrap'}},
      button('inspect-environment','检查语音环境',state.busy||installing||!stopped),
      button('test-environment','运行离线自检',state.busy||installing||!stopped)),
    ['inspect-environment','test-environment'].includes(state.action)&&state.busy&&h(React.Fragment,null,
      h('p',{role:'status'},'正在检查，请稍候。取消后会等待本地进程退出。'),button('shutdown','取消检查')),
    state.environmentError&&h('p',{role:'alert'},state.environmentError),
    report&&h(React.Fragment,null,
      h('table',null,h('caption',null,'本次环境检查结果'),h('tbody',null,...report.checks.map(item=>h('tr',{key:item.id},h('th',{scope:'row',style:{textAlign:'left',paddingRight:16}},checkLabels[item.id]),h('td',null,statuses[item.status]))))),
      h('p',{role:'status'},report.loadTest==='passed'?'离线模型加载与合成识别自检通过；尚未验证设备和真实语音。':report.loadTest==='failed'?'离线自检未通过，请检查模型与运行环境。':report.filesVerified?'文件与依赖检查通过，尚未运行模型加载自检。':'环境尚未完整；缺失项准备后请重新检查。'),
      h('p',null,'固定语音与输入资产约 '+Math.ceil(report.assetBytes/1000000)+' MB，不含构建工具与依赖。'))),
    runtime&&h(React.Fragment,null,
    h('h3',null,'语音运行'),h('p',{role:'status'},standby&&s.phase==='listening'
      ?waiting:s?.transport==='relay'&&s.phase==='connecting'&&!s.connected
        ?'正在等待 Sion 接入中继':s?labels[s.phase]:'尚未读取运行状态'),
    h('p',null,s?.transport==='usb'
      ?s.connected?'USB 设备已认证。':'给 v48 的 DSH.AGENT 开启 USB 待命后，在 Sion 点 USB 即可接通。也可以先在 Sion 点 USB，再回这里手动接通。'
      :s?.transport==='relay'?'启用外出待命后，保持 Mac 和语音服务运行。外出时在 Sion 上点 Relay 即可接入。'
      :'用 Wi-Fi 时，请启动语音服务。开启局域网待命后，在 Sion 的 DSH.AGENT 点 Start 就能接通。'),
    s&&h('p',null,s.connected?`${connectionLabels[s.transport]}连接已认证。`:'尚无已认证的设备连接。'),
    s?.pendingChanges&&h('p',{role:'status'},'已保存的偏好与运行中的配置不同；关闭并重新启动服务后应用。'),
    s?.canReconnect&&h('p',{role:'status'},'连接中断，旧连接的设备释放未确认。在 Sion 上重新连接后，可以继续所选会话。'),
    s?.phase==='stopped'&&['voice_release_unconfirmed','identity_release_unconfirmed','voice_identity_lost'].includes(s.lastError)&&!s.deviceIdleConfirmed&&h('p',{role:'alert'},'服务已关闭，但设备资源是否释放仍未确认。'),
    state.error&&h('p',{role:'alert'},state.error),
    !state.error&&s?.lastError&&h('p',{role:'alert'},voiceErrorMessage(s.lastError)),
    h('div',{style:{display:'flex',gap:8,flexWrap:'wrap'}},
      button('snapshot','刷新运行状态',state.busy),
      button('start','启动语音服务',state.busy||installing||!stopped),
      button('connect',s?.canReconnect?'重新接通所选会话':'接通所选会话',state.busy||standby||
        !(s?.phase==='listening'||s?.canReconnect)||(!s.connected&&s.transport!=='usb'&&s.transport!=='relay')||s.pendingChanges),
      s?.transport==='lan'&&button('arm-lan','开启局域网待命',!canArm),
      s?.transport==='usb'&&button('arm-usb','开启 USB 待命',!canArm),
      s?.transport==='relay'&&button('arm-relay','开启外出待命',!canArm),
      button('stop',stopLabel,!standby&&
        !['active','connecting','fault'].includes(s?.phase)&&!['connect','arm-relay','arm-lan','arm-usb'].includes(state.action)),
      button('shutdown','关闭语音服务',s?.phase==='stopped'&&!state.busy)),
    h('p',null,'停止对话会保留服务，等待再次接通；关闭服务会释放配对身份锁。保存偏好不会开始录音。'),
    s?.ownerVoice&&h('div',{style:{display:'grid',gap:6}},
      h('h4',null,'我的声音'),
      h('p',null,ownerVoiceText(s.ownerVoice)),
      h('div',{style:{display:'flex',gap:8,flexWrap:'wrap'}},
        s.ownerVoice.enrolling?button('owner-voice-cancel','取消登记')
          :button('owner-voice-enroll',s.ownerVoice.enrolled?'重新登记我的声音':'登记我的声音',state.busy||!s.ownerVoice.available||s.phase!=='active'),
        s.ownerVoice.enrolled&&!s.ownerVoice.enrolling&&button('owner-voice-forget','删除我的声纹',state.busy))),
    h(LatencyPanel,{latency:s?.latency,transport:s?.transport,unreachable:!!state.error})),
    device&&h(React.Fragment,null,
    h(DeviceCapabilitiesPanel,{report:s?.capabilities,unreachable:!!state.error}),
    h(CameraPanel,{camera:s?.camera,unreachable:!!state.error}),
    h(MotionPanel,{motion:s?.motion,unreachable:!!state.error}),
    h(RingPanel,{ring:s?.ring,unreachable:!!state.error})));
}
