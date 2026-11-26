import { usbPortPattern } from './usb-port.mjs';

/** Browser domain controller. Only the native ConfigForm writes configuration;
 * Remote Session reads use the existing authenticated DSH carrier. */
export class SettingsController {
  #form; #session; #unsubscribe; #listeners = new Set(); #closed = false;
  #request = null; #generation = 0; #busy = false;
  #state = { status: 'loading', writable: false, draft: null, revision: undefined,
    dirty: false, conflict: false, saving: false, sessionsLoading: false,
    sessionChecking: false, sessionCheck: null, sessions: [], notice: '', error: '' };
  constructor(form, session) {
    this.#form = form; this.#session = session;
    this.#unsubscribe = form.subscribe(() => this.#refresh());
    this.#refresh();
  }
  getSnapshot = () => this.#state;
  subscribe = listener => { this.#listeners.add(listener); return () => this.#listeners.delete(listener); };
  #publish(patch) {
    if (this.#closed) return;
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.#listeners) listener();
  }
  #refresh() {
    const accepted = this.#form.getSnapshot();
    const patch = { status: accepted.status, writable: accepted.writable };
    if (accepted.status === 'ready' && accepted.value?.preferences) {
      if (!this.#state.dirty && !this.#busy) {
        const draft = structuredClone(accepted.value.preferences);
        Object.assign(patch, { draft, revision: accepted.revision, conflict: false });
        if (draft.sessionId !== this.#state.draft?.sessionId) patch.sessionCheck = null;
      }
      else if (accepted.revision !== this.#state.revision) patch.conflict = true;
    }
    this.#publish(patch);
  }
  edit(field, value) {
    if (this.#closed || this.#busy || !this.#state.draft || !this.#state.writable) return;
    if (!Object.hasOwn(this.#state.draft, field)) throw new TypeError('Unknown preference');
    const patch = { draft: { ...this.#state.draft, [field]: value }, dirty: true, notice: '', error: '' };
    if (patch.draft.sessionId !== this.#state.draft.sessionId) patch.sessionCheck = null;
    this.#publish(patch);
  }
  discard() {
    if (this.#busy || this.#closed) return;
    this.#publish({ dirty: false, conflict: false, notice: '', error: '' }); this.#refresh();
  }
  async loadSessions() {
    if (this.#closed || this.#request) return;
    const request = new AbortController(); this.#request = request;
    const generation = ++this.#generation;
    this.#publish({ sessionsLoading: true, error: '' });
    try {
      const response = await this.#session.list({}, request.signal);
      if (this.#closed || generation !== this.#generation) return;
      if (!response?.ok || !Array.isArray(response.value?.items)) throw new Error('unavailable');
      const sessions = response.value.items.filter(row => !row.parentSessionId && row.origin !== 'subagent')
        .map(row => ({ sessionId: row.sessionId,
          title: row.projections?.values?.title || '未命名会话', running: row.running === true,
          migrationRequired: row.formatStatus === 'migration-required' }));
      this.#publish({ sessions });
    } catch {
      if (!request.signal.aborted) this.#publish({ error: '无法读取会话列表，请检查 DSH 连接后重试。' });
    } finally {
      if (generation === this.#generation) { this.#request = null; this.#publish({ sessionsLoading: false }); }
    }
  }
  async #readSession(sessionId, signal) {
    const result = await this.#session.projections({ sessionId }, signal);
    signal.throwIfAborted();
    if (!result?.ok) return 'unavailable';
    if (result.value === null) return 'missing';
    if (result.value?.kind === 'sequenced') return 'verified';
    if (result.value?.kind === 'migration-required') return 'migration-required';
    return 'unavailable';
  }
  async checkSession() {
    const { status, draft } = this.#state;
    const sessionId = draft?.sessionId;
    if (this.#closed || this.#request || status !== 'ready' || !sessionId) return;
    const request = new AbortController(); this.#request = request;
    const generation = ++this.#generation;
    this.#publish({ sessionChecking: true, sessionCheck: null, error: '' });
    let result = 'unavailable';
    try {
      result = await this.#readSession(sessionId, request.signal);
    } catch {
      // Keep transport errors private and distinct from an absent session.
    } finally {
      if (generation === this.#generation) {
        this.#request = null;
        this.#publish({ sessionChecking: false,
          sessionCheck: this.#state.draft?.sessionId === sessionId ? result : null });
      }
    }
  }
  async save() {
    const state = this.#state;
    if (this.#closed || this.#busy || !state.dirty || state.status !== 'ready' || !state.writable) return false;
    if (state.conflict) { this.#publish({ error: '配置已在其他窗口改变。请先重新载入，再编辑保存。' }); return false; }
    if (state.draft?.transport === 'usb' && !usbPortPattern.test(state.draft.usbPort ?? '')) {
      this.#publish({ error: '请先选择 Sion 的 USB 串口，再保存有线配置。' }); return false;
    }
    // Cancel the outstanding settings read. The saved draft is fixed.
    this.#request?.abort(); const request = new AbortController(); this.#request = request;
    const generation = ++this.#generation; this.#busy = true;
    const draft = structuredClone(state.draft);
    this.#publish({ saving: true, sessionsLoading: false, sessionChecking: false, sessionCheck: null, error: '', notice: '' });
    try {
      if (draft.sessionId) {
        const result = await this.#readSession(draft.sessionId, request.signal);
        const error = result === 'migration-required' ? '请先在 DSH 中打开所选会话，再保存。'
          : '所选会话不可用；配置未保存。';
        this.#publish({ sessionCheck: result, error: result === 'verified' ? '' : error });
        if (result !== 'verified') return false;
      }
      request.signal.throwIfAborted();
      const accepted = await this.#form.mutate([{ op: 'set', path: ['preferences'], value: draft }], state.revision);
      if (this.#closed || generation !== this.#generation) return false;
      if (!accepted) { this.#publish({ conflict: true, error: '保存被拒绝，草稿已保留。请重新载入配置后重试。' }); return false; }
      this.#publish({ dirty: false, conflict: false, notice: '配置已保存；保存不会启动录音。运行中的服务需关闭并重新启动后应用新偏好。' });
      return true;
    } catch {
      if (!request.signal.aborted) this.#publish({ error: '保存失败，草稿已保留。请检查连接后重试。' });
      return false;
    } finally {
      if (generation === this.#generation) {
        this.#busy = false; this.#request = null; this.#publish({ saving: false }); this.#refresh();
      }
    }
  }
  dispose() {
    this.#closed = true; ++this.#generation; this.#request?.abort();
    this.#unsubscribe(); this.#listeners.clear();
  }
}

