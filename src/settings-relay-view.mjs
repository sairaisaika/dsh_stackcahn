import React from 'react';

const h = React.createElement;
const fileState = {
  ready: '已读到对应当前配对的配置', missing: '缺少文件', invalid: '文件格式、归属或权限有误',
  pair_mismatch: '文件与当前配对不符', unavailable: '当前配置档无法读取',
};
const deviceState = {
  empty: '尚未配置', ready: '已保存', invalid: '需要更新配置', unavailable: '配置不可用', storage_error: '设备存储错误',
};
const messages = {
  host_busy: '请先关闭语音服务，等其他设备操作结束后重新检查。',
  host_unconfigured: '请先在设备配对中准备插件专用环境。',
  reconcile_required: '请先核对设备的独立配对结果。',
  revision_conflict: '本机配对已变化。请重新检查本机配置，再检查设备。',
  active_identity_required: '请先完成独立 DSH 配对。',
  device_access_disabled: '当前安装未允许 USB 设备操作。',
  managed_usb_port_unavailable: '串口已变化。请重新查找 USB 端口。',
  relay_bundle_changed: '设备配置文件已变化。请重新检查本机配置和设备。',
  relay_not_supported: '设备固件需要支持 Relay 配置（v35 或更新版）。',
  relay_state_changed: '设备配置已变化。请重新检查设备，再决定是否写入。',
  physical_window_required: '设备授权已关闭或过期。请检查设备，再在 Pairing 页点 Allow USB。',
  wrong_device: '这个串口上的设备与已配对的 Sion 不同。',
  identity_conflict: '设备的独立配对与本机记录不同。请先核对配对。',
};

export function RelaySetupPanel({ remote, disabled, renderPort }) {
  const [report, setReport] = React.useState(null);
  const [port, setPort] = React.useState('');
  const [confirmed, setConfirmed] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState(null);
  const request = React.useRef(null);
  React.useEffect(() => () => { request.current?.abort(); request.current = null; }, []);

  const paired = report?.paired && !report.pairingPending;
  const inspected = ['ready', 'empty', 'invalid'].includes(report?.device?.state);
  const mutationAllowed = !disabled && !busy && paired && !!port && inspected && confirmed;
  const canInstall = mutationAllowed && report.staged === 'ready' && report.stagedRevision !== report.device.revision;
  const canRemove = mutationAllowed && report.device.state !== 'empty';

  function changePort(value) {
    setPort(value);
    setConfirmed(false);
    setReport(old => old ? { ...old, device: null } : null);
    setMessage(null);
  }

  async function run(action) {
    if (request.current || disabled) return;
    const mutation = action === 'relay_install' || action === 'relay_remove';
    if (action === 'relay_install' && !canInstall || action === 'relay_remove' && !canRemove) return;
    if (action === 'relay_inspect' && (!paired || !port)) return;
    const payload = { action };
    if (action !== 'relay_check') Object.assign(payload, { revision: report.revision, port, authorizeUsb: true });
    if (mutation) Object.assign(payload, { expectedState: report.device.state, expectedRevision: report.device.revision });
    if (action === 'relay_install') payload.stagedRevision = report.stagedRevision;
    const current = new AbortController();
    request.current = current;
    setBusy(true);
    setMessage(null);
    setConfirmed(false);
    try {
      const result = await remote.relay(payload, current.signal);
      if (request.current !== current) return;
      if (result.ok) {
        setReport(result.value);
        if (mutation) setMessage({ text: action === 'relay_remove' ? '设备已确认撤销外出配置。' : '设备已读回确认本次外出配置。' });
        return;
      }
      const reason = result.error.details?.reason;
      const denied = ['stackchan/owner-required', 'remote-access/denied'].includes(result.error.code);
      setReport(old => action === 'relay_check' || reason === 'revision_conflict' ? null : old ? { ...old, device: null } : null);
      setMessage({ error: true, text: denied ? '只有 DSH 所有者可以管理外出配置。'
        : messages[reason] ?? (mutation ? '写入结果未确认。请先检查设备。' : '检查未完成。请核对 USB 连接和本机配置。') });
    } finally {
      if (request.current === current) {
        request.current = null;
        setBusy(false);
      }
    }
  }

  const button = (action, label, enabled) => h('button', {
    type: 'button', disabled: disabled || busy || !enabled, onClick: () => run(action),
  }, label);
  return h('fieldset', { style: { display: 'grid', gap: 8 } },
    h('legend', null, '外出中继配置'),
    h('p', null, '在本机当前 DSH 配置档准备 .stackchan-relay.json 和 .stackchan-relay-device.json（权限 0600）。关闭语音服务后检查。'),
    button('relay_check', '检查本机中继配置', true),
    report && h('div', { role: 'status' },
      h('div', null, `Mac 配置：${fileState[report.host]}`),
      h('div', null, `待写入设备的配置：${fileState[report.staged]}`),
      !paired && h('div', null, report.pairingPending ? '请先核对独立配对结果。' : '请先完成独立 DSH 配对。')),
    paired && renderPort({ value: port, disabled: disabled || busy, change: changePort }),
    paired && button('relay_inspect', '检查设备外出配置', !!port),
    report?.device && h('p', { role: 'status' }, `设备状态：${deviceState[report.device.state]}` +
      (report.device.state === 'ready' && report.device.revision && report.device.revision === report.stagedRevision ? '，与待写入文件版本相同。' : '。')),
    inspected && h('label', null, h('input', { type: 'checkbox', checked: confirmed, disabled: disabled || busy,
      onChange: event => setConfirmed(event.target.checked) }), '我已在 Sion 的 Pairing 页面点 Allow USB'),
    inspected && h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
      button('relay_install', '写入设备外出配置', canInstall), button('relay_remove', '撤销设备外出配置', canRemove)),
    busy && h('p', { role: 'status' }, '正在核对…'),
    message && h('p', { role: message.error ? 'alert' : 'status' }, message.text));
}
