const messages = {
  host_unconfigured: '配对服务尚未配置。请先完成插件安装设置。',
  device_access_disabled: '此配置档当前不允许 USB 操作。请先准备专用环境；安装方已禁用时需按其配置启用。',
  managed_usb_port_unavailable: '此端口当前没有匹配的 Espressif USB Serial/JTAG 设备。请重新连接并查找 USB 端口。',
  revision_conflict: '配对状态已在其他窗口改变。请刷新本地状态。',
  reconcile_required: '上次写入结果未确认。请检查设备并核对结果，暂时不要再次写入。',
  identity_conflict: '设备配对身份与本机记录不同。已保留凭据，请先核对设备。',
  host_busy: '另一个配对操作正在进行，请稍后刷新状态。',
  wrong_device: '设备编号与已绑定设备不一致。',
  invalid_port: '请选择或填写有效的 Mac USB 串口。',
  device_state_unavailable: '无法确认设备状态。请检查连接和设备上的 DSH.AGENT。',
  private_storage_required: '私有配对目录的权限或类型不正确，操作已停止。',
  private_storage_invalid: '本机配对记录不可用，操作已停止，未创建替代身份。',
  invalid_local_url: '请填写 Mac 局域网内的 WSS 地址，或勾选暂不配置局域网。',
  optional_lan_not_supported: '这台设备的 DSH.AGENT 版本需要局域网地址。请填写地址后重新准备配对身份。',
  environment_unavailable: '无法完成环境检查。请检查插件安装中选择的 Python 是否可运行，再重试检查。',
  runtime_profile_required: '需要在 DSH 配置档中使用此安装功能。',
  runtime_python_required: '未找到 Python 3.10 或更新版本。请先安装 Python，再准备插件环境。',
  runtime_storage_invalid: '插件运行环境记录或目录权限不正确。已停止，未替换现有环境。',
  runtime_package_invalid: '随插件附带的依赖校验失败。请检查插件安装包。',
  runtime_setup_failed: '环境准备未确认完成。请重新检查环境；未自动重试或清除已有文件。',
  runtime_custom_installation: '当前使用自定义配对目录。请维护该安装环境；自动准备不会覆盖它。',
};

export class PairingController {
  #remote; #closed = false; #request; #listeners = new Set();
  #state = { snapshot: null, environment: null, busy: false, error: '', notice: '', confirmed: false,
    deviceId: '', identifiedPort: '', port: '', localUrl: '', withoutLan: false };
  constructor(remote) { this.#remote = remote; }
  getSnapshot = () => this.#state;
  subscribe = listener => { this.#listeners.add(listener); return () => this.#listeners.delete(listener); };
  #publish(patch) {
    if (this.#closed) return;
    this.#state = { ...this.#state, ...patch };
    for (const fn of this.#listeners) fn();
  }
  edit(field, value) {
    if (this.#closed || this.#state.busy || !['deviceId', 'port', 'localUrl', 'withoutLan', 'confirmed'].includes(field)) return;
    const patch = { [field]: value, error: '', notice: '' };
    if (field !== 'confirmed') patch.confirmed = false;
    if (field === 'deviceId') patch.identifiedPort = '';
    if (field === 'port' && this.#state.identifiedPort && this.#state.identifiedPort !== value)
      Object.assign(patch, { identifiedPort: '', deviceId: '' });
    this.#publish(patch);
  }
  choosePort(path) {
    if (this.#closed || this.#state.busy || !this.#state.environment?.ports.some(p => p.path === path)) return;
    this.edit('port', path);
  }
  chooseLocalUrl(url) {
    if (this.#closed || this.#state.busy || !this.#state.environment?.localNetwork?.endpoints.some(endpoint => endpoint.url === url)) return;
    this.edit('localUrl', url);
  }
  async diagnose(prepareRuntime = false) {
    if (this.#closed || this.#state.busy) return;
    const abort = new AbortController(); this.#request = abort;
    this.#publish({ busy: true, environment: null, error: '', notice: '', confirmed: false });
    try {
      const result = prepareRuntime ? await this.#remote.prepareRuntime(abort.signal) : await this.#remote.diagnose(abort.signal);
      if (this.#closed) return;
      if (result.ok) this.#publish({ environment: result.value,
        notice: prepareRuntime ? '插件专用环境已准备。设备访问配置未改变；尚未配对或接通语音。'
          : '环境检查完成。USB 和网络选项来自 Mac 的接口信息；设备身份与连通性待检查。' });
      else this.#publish({ error: result.error.code === 'stackchan/owner-required' || result.error.code === 'remote-access/denied'
        ? '只有 DSH 所有者可以查看配对环境和端口。'
        : messages[result.error.details?.reason] || messages.environment_unavailable });
    } finally {
      this.#request = null;
      this.#publish({ busy: false });
    }
  }
  async run(action) {
    if (this.#closed || this.#state.busy) return;
    const s = this.#state;
    if (action === 'identify' && (s.snapshot?.deviceId || !s.port)) return;
    let request = { action };
    if (action !== 'snapshot' && action !== 'identify') {
      if (!s.snapshot) { this.#publish({ error: '请先刷新本地配对状态。' }); return; }
      if (!/^[0-9a-f]{12}$/.test(s.deviceId)) { this.#publish({ error: '请输入 12 位设备编号（小写十六进制）。' }); return; }
      if (s.snapshot.pending && action !== 'inspect') { this.#publish({ error: messages.reconcile_required }); return; }
      if (['install', 'remove'].includes(action) && !s.confirmed) {
        this.#publish({ error: '请先在设备上允许 USB 配对，并勾选确认。' }); return;
      }
      request = { action, revision: s.snapshot.revision, deviceId: s.deviceId };
      if (action === 'prepare') {
        if (!s.withoutLan && !s.localUrl.trim()) {
          this.#publish({ error: messages.invalid_local_url });
          return;
        }
        request.localUrl = s.withoutLan ? '' : s.localUrl;
      }
      else Object.assign(request, { port: s.port, authorizeUsb: true });
    }
    const abort = new AbortController(); this.#request = abort;
    this.#publish({ busy: true, error: '', notice: '',
      ...(action === 'identify' && s.identifiedPort ? { identifiedPort: '', deviceId: '' } : {}) });
    try {
      const result = action === 'identify' ? await this.#remote.identify(s.port, abort.signal)
        : await this.#remote.execute(request, abort.signal);
      if (this.#closed) return;
      if (result.ok) {
        if (action === 'identify') {
          this.#publish({ deviceId: result.value.deviceId, identifiedPort: s.port,
            notice: '已从设备读取编号并填入草稿。请核对后准备配对身份。' });
          return;
        }
        this.#publish({ snapshot: result.value, deviceId: result.value.deviceId || s.deviceId,
          identifiedPort: result.value.deviceId ? '' : s.identifiedPort,
          notice: action === 'prepare' ? '本机配对身份已准备，尚未写入设备。'
            : action === 'snapshot' ? '本地记录已刷新；不代表设备在线。'
            : action === 'install' ? '设备已确认安装本插件的配对身份。'
              : action === 'remove' ? '设备已确认撤销本插件的配对身份。'
                : '设备身份检查已完成；语音连接尚未接通。' });
      } else {
        const error = result.error;
        this.#publish({ error: error.code === 'stackchan/owner-required' || error.code === 'remote-access/denied'
          ? '只有 DSH 所有者可以管理设备配对。'
          : messages[error.details?.reason] || (action === 'identify' ? messages.device_state_unavailable
            : '操作结果未确认。先刷新本地记录，再检查设备核对结果；不要重复写入。'),
          // An interrupted mutation may have advanced the journal. Do not reuse revision.
          snapshot: ['install', 'remove', 'prepare'].includes(action) ? null : s.snapshot });
      }
    } finally {
      this.#request = null;
      this.#publish({ busy: false, confirmed: false });
    }
  }
  dispose() { this.#closed = true; this.#request?.abort(); this.#listeners.clear(); }
}
