import React from 'react';
import { VoiceController } from './settings-voice-controller.mjs';
import { VoicePanel, VoicePreview, VoiceQuickStatus } from './settings-voice-view.mjs';
import { SettingsController } from './settings-controller.mjs';
import { PairingController } from './settings-pairing-controller.mjs';
import { PairingPanel } from './settings-pairing-view.mjs';
import { RelaySetupPanel } from './settings-relay-view.mjs';
import { usbPortPattern } from './usb-port.mjs';
import remoteInfo from '../lib/typert.remote-client.js';
const h = React.createElement;
export const inject = ['slots', 'configForms', 'remote'];

const tabs = [
  ['connection', '连接与会话'], ['pairing', '设备配对'], ['speech', '本地语音'], ['device', '设备能力'],
];
const rowStyle = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 };

const sessionCheckMessages = {
  verified: '当前所选会话已通过核对。',
  missing: 'DSH 中找不到当前所选会话。',
  'migration-required': '请先在 DSH 中打开当前所选会话，再核对。',
  unavailable: '暂时无法核对当前所选会话，请检查 DSH 连接后重试。',
};

function UsbPortSelection({ pairing, value, disabled, change }) {
  const state = React.useSyncExternalStore(pairing.subscribe, pairing.getSnapshot, pairing.getSnapshot);
  const candidates = (state.environment?.ports ?? []).filter(port =>
    port.vid === 0x303a && port.pid === 0x1001 && usbPortPattern.test(port.path));
  return h('div', { style: { display: 'grid', gap: 6 } },
    h('label', null, 'USB 端口', h('select', {
      value, disabled, onChange: event => change(event.target.value),
    },
    h('option', { value: '' }, '请选择串口'),
    value && !candidates.some(port => port.path === value) && h('option', { value }, `已保存 · ${value}`),
    candidates.map(port => h('option', { key: port.path, value: port.path },
      port.description ? `${port.description} · ${port.path}` : port.path)))),
    h('button', { type: 'button', disabled: disabled || state.busy, onClick: () => pairing.diagnose() },
      state.busy ? '正在检查…' : '查找 USB 端口'),
    state.environment && !candidates.length && h('p', { role: 'status' },
      state.environment.serial === 'available' ? '未找到可选串口，请确认 USB 数据线后重新查找。' : '请先在设备配对中准备插件专用环境，再重新查找。'),
    state.error && h('p', { role: 'alert' }, state.error));
}

export function SettingsPage({ controller, pairing, voice, relayRemote }) {
  const state = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const id = React.useId();
  const [active, setActive] = React.useState('connection');
  if (state.status !== 'ready' || !state.draft) return h('p', { role: 'status' },
    state.status === 'loading' ? '正在读取 StackChan 配置…' : 'StackChan 配置服务不可用，请检查插件是否启用。');
  const draft = state.draft;
  const locked = !state.writable || state.saving;
  function select(field, label, choices) {
    return h('label', { style: { display: 'grid', gap: 6 }, htmlFor: `${id}-${field}` }, label,
      h('select', { id: `${id}-${field}`, value: draft[field], disabled: locked,
        onChange: event => controller.edit(field, event.target.value) },
      choices.map(([value, title]) => h('option', { key: value, value }, title))));
  }
  const sessions = state.sessions.map(row => [row.sessionId,
    `${row.title} · ${row.sessionId.slice(-8)}${row.running ? '（任务进行中）' : ''}${row.migrationRequired ? '（需先在 DSH 打开）' : ''}`]);
  if (draft.sessionId && !sessions.some(([id]) => id === draft.sessionId))
    sessions.unshift([draft.sessionId, `当前所选会话 · ${draft.sessionId.slice(-8)}`]);
  const readingSession = state.sessionsLoading || state.sessionChecking || state.saving;
  const connection = h(React.Fragment, null,
    select('sessionId', '使用已有会话', [['', '请选择会话'], ...sessions]),
    h('div', { style: rowStyle },
      h('button', { type: 'button', disabled: readingSession,
        onClick: () => controller.loadSessions() }, state.sessionsLoading ? '正在读取…' : '刷新会话列表'),
      h('button', { type: 'button', disabled: readingSession || !draft.sessionId,
        onClick: () => controller.checkSession() }, state.sessionChecking ? '正在核对…' : '核对当前会话')),
    state.sessionCheck && h('p', { role: 'status' }, sessionCheckMessages[state.sessionCheck]),
    h('p', null, 'Sion 使用所选会话的人格、记忆和模型。切换后请重新启动语音服务。'),
    select('transport', '连接方式', [['lan', '局域网 Wi-Fi'], ['usb', 'USB 有线'], ['relay', '外出中继']]),
    draft.transport === 'usb' && pairing && h(UsbPortSelection, {
      pairing, value: draft.usbPort, disabled: locked, change: port => controller.edit('usbPort', port),
    }),
    draft.transport === 'relay' && relayRemote && pairing && h(RelaySetupPanel, {
      remote: relayRemote, disabled: locked, renderPort: props => h(UsbPortSelection, { pairing, ...props }),
    }),
    Object.hasOwn(draft, 'autoStandby') && h('label', null,
      h('input', { type: 'checkbox', checked: draft.autoStandby, disabled: locked,
        onChange: e => controller.edit('autoStandby', e.target.checked) }),
      'DSH 启动后自动待命（自动启动语音服务并等待 Sion；断线后自动重连）'),
    voice && h(VoicePanel, { controller: voice, section: 'runtime' }));
  const speech = h(React.Fragment, null,
    select('language', '识别语言', [['auto', '自动'], ['zh', '中文'], ['en', '英语']]),
    select('asrBackend', '本地语音识别', [['unconfigured', '尚未配置'], ['whisper.cpp', 'Whisper.cpp（本地识别）']]),
    Object.hasOwn(draft, 'captionOnly') && h('label', null,
      h('input', { type: 'checkbox', checked: draft.captionOnly, disabled: locked,
        onChange: e => controller.edit('captionOnly', e.target.checked) }),
      '仅字幕（在 Sion 上选择 Text；下次启动语音服务时生效）'),
    Object.hasOwn(draft, 'ownerOnly') && select('ownerOnly', '只认我的声音（需先在语音运行里登记）',
      [['off', '关闭：谁说都算'], ['wake', '只有我能叫醒，叫醒后谁说都听'], ['always', '全程只听我的声音']]),
    Object.hasOwn(draft, 'speakSessionReplies') && h('label', null,
      h('input', { type: 'checkbox', checked: draft.speakSessionReplies, disabled: locked,
        onChange: e => controller.edit('speakSessionReplies', e.target.checked) }),
      '这个会话里别处来的回复也念出来（电脑打字、TG、定时任务；下次启动语音服务时生效）'),
    Object.hasOwn(draft, 'bodyFacts') && select('bodyFacts', '头顶触摸告诉 DSH（只报电容事实）',
      [['context', '附在下一句话里，不打扰她'], ['turn', '马上告诉她（受下面的频率限制）'], ['off', '不主动告诉（她可以自己查）']]),
    Object.hasOwn(draft, 'infraredSend') && h('label', { htmlFor: `${id}-infrared-send` },
      h('input', { id: `${id}-infrared-send`, type: 'checkbox', checked: draft.infraredSend, disabled: locked,
        onChange: e => controller.edit('infraredSend', e.target.checked) }), '允许 DSH 发送红外（可控制房间里的电视、空调等）'),
    Object.hasOwn(draft, 'eventCooldownSec') && h('label', { htmlFor: `${id}-event-cooldown` },
      `身体事件告诉 DSH：同类至少隔 ${draft.eventCooldownSec} 秒（0 = 不告诉）`, h('input', { id: `${id}-event-cooldown`,
      type: 'range', min: 0, max: 600, step: 5, value: draft.eventCooldownSec, disabled: locked,
      onChange: e => controller.edit('eventCooldownSec', Number(e.target.value)) })),
    Object.hasOwn(draft, 'eventsPerHour') && h('label', { htmlFor: `${id}-events-hour` },
      `每小时最多 ${draft.eventsPerHour} 次`, h('input', { id: `${id}-events-hour`,
      type: 'range', min: 0, max: 120, step: 1, value: draft.eventsPerHour, disabled: locked,
      onChange: e => controller.edit('eventsPerHour', Number(e.target.value)) })),
    select('ttsBackend', '本地语音合成', [['unconfigured', '尚未配置'], ['kokoro', 'Kokoro（本地合成）']]),
    select('voice', '音色', [['', '跟随语音语言（中文用 zf_038）'], ['zf_038', '中文 · zf_038（年轻）'], ['zf_001', '中文 · zf_001'], ['af_maple', '英语 · af_maple'],
      ...(['', 'zf_001', 'zf_038', 'af_maple'].includes(draft.voice) ? [] : [[draft.voice, '已保存的音色当前不可用']])]),
    h('label', { htmlFor: `${id}-rate` }, `语速：${draft.speechRate}×`, h('input', { id: `${id}-rate`,
      type: 'range', min: 0.5, max: 2, step: 0.05, value: draft.speechRate, disabled: locked,
      onChange: e => controller.edit('speechRate', Number(e.target.value)) })),
    voice && draft.ttsBackend === 'kokoro' && h(VoicePreview, { controller: voice, disabled: locked,
      language: draft.language, voice: draft.voice, speechRate: draft.speechRate }),
    Object.hasOwn(draft, 'measureLatency') && h('label', null,
      h('input', { type: 'checkbox', checked: draft.measureLatency, disabled: locked,
        onChange: e => controller.edit('measureLatency', e.target.checked) }),
      '测量语音延迟（保存后在下次启动语音服务时生效）'),
    voice && h(VoicePanel, { controller: voice, section: 'environment' }));
  const panels = {
    connection,
    pairing: pairing && h(React.Fragment, null,
      h(PairingPanel, { controller: pairing }), h('p', null, '原厂语音和手机绑定由原助手管理。')),
    speech,
    device: voice && h(VoicePanel, { controller: voice, section: 'device' }),
  };
  function onTabKey(event, index) {
    const target = { ArrowLeft: (index + tabs.length - 1) % tabs.length,
      ArrowRight: (index + 1) % tabs.length, Home: 0, End: tabs.length - 1 }[event.key];
    if (!Number.isInteger(target)) return;
    event.preventDefault();
    const [key] = tabs[target];
    setActive(key);
    event.currentTarget.ownerDocument.getElementById(`${id}-tab-${key}`)?.focus();
  }
  return h('section', { 'aria-label': 'StackChan 设置', style: { display: 'grid', gap: 18, maxWidth: 720, padding: 20 } },
    h('h2', { style: { margin: 0 } }, 'StackChan'),
    h('div', { role: 'tablist', 'aria-label': '设置分类', style: {
      display: 'flex', flexWrap: 'wrap', gap: 4, paddingBottom: 5, borderBottom: '1px solid color-mix(in srgb, currentColor 18%, transparent)',
    } }, tabs.map(([key, label], index) => h('button', {
      key, id: `${id}-tab-${key}`, type: 'button', role: 'tab',
      'aria-selected': active === key, 'aria-controls': `${id}-panel-${key}`, tabIndex: active === key ? 0 : -1,
      onClick: () => setActive(key), onKeyDown: event => onTabKey(event, index),
      style: { color: 'inherit', cursor: 'pointer', padding: '8px 12px', border: 0, borderRadius: 8,
        background: active === key ? 'color-mix(in srgb, currentColor 12%, transparent)' : 'transparent',
        fontWeight: active === key ? 650 : 450 },
    }, label))),
    voice && active !== 'connection' && h(VoiceQuickStatus, { controller: voice }),
    !state.writable && h('p', { role: 'status' }, '当前配置只读。'),
    state.conflict && h('p', { role: 'alert' }, '配置已发生变化；你的草稿仍保留，重新载入会丢弃当前草稿。'),
    state.error && h('p', { role: 'alert' }, state.error),
    state.notice && h('p', { role: 'status' }, state.notice),
    h('div', { style: rowStyle },
      h('button', { type: 'button', disabled: locked || !state.dirty || state.conflict,
        onClick: () => controller.save() }, state.saving ? '正在保存…' : '保存偏好'),
      h('button', { type: 'button', disabled: state.saving, onClick: () => controller.discard() }, '放弃草稿并重新载入')),
    tabs.map(([key]) => h('div', { key, id: `${id}-panel-${key}`, role: 'tabpanel',
      'aria-labelledby': `${id}-tab-${key}`, hidden: key !== active,
      style: { display: active === key ? 'grid' : 'none', gap: 14, minWidth: 0 },
    }, panels[key])));
}

export async function apply(ctx) {
  await ctx.remote.$mount(remoteInfo);
  ctx.inject(['remote.session', 'remote.stackchanPairing', 'remote.stackchanVoice'], child => mountSettings(child));
}

function mountSettings(ctx) {
  const controller = new SettingsController(ctx.configForms.get('stackchan'), ctx.remote.session);
  const pairingRemote = ctx.remote.stackchanPairing;
  const pairing = new PairingController(pairingRemote);
  const voice = new VoiceController(ctx.remote.stackchanVoice);
  ctx.effect(() => () => voice.dispose());
  ctx.effect(() => () => controller.dispose());
  ctx.effect(() => () => pairing.dispose());
  ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'stackchan', order: 65, label: 'StackChan',
  }, () => h(SettingsPage, { controller, pairing, voice, relayRemote: pairingRemote }))));
}
