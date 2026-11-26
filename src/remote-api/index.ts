import type { Context } from '@deepseek-ai/cordis';
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';

/** authorizeUsb records intent for this owner request; it cannot change Host setup or policy. */
export type PairingRequest = { action: 'snapshot' }
  | { action: 'prepare'; revision: number; deviceId: string; localUrl: string }
  | { action: 'inspect' | 'install' | 'remove'; revision: number; deviceId: string; port: string; authorizeUsb?: boolean };

export interface PairingSnapshot {
  revision: number;
  deviceId: string;
  activePairId: string;
  candidatePairId: string;
  pending: '' | 'install' | 'remove';
  observed: { state: 'empty' | 'paired' | 'revoked' | 'unavailable' | 'corrupt' | 'storage_error'; pairId: string } | null;
  /** Historical identity confirmation never means network connectivity. */
  connected: false;
}

export type PairingOutcome = { ok: true; value: PairingSnapshot } | { ok: false; error: string };
export interface DeviceIdentification { deviceId: string }
interface RelayUsbRequest { revision: number; port: string; authorizeUsb: boolean }
interface RelayMutation extends RelayUsbRequest { expectedState: 'ready' | 'empty' | 'invalid'; expectedRevision: string }
export type RelaySetupRequest = { action: 'relay_check' }
  | (RelayUsbRequest & { action: 'relay_inspect' })
  | (RelayMutation & { action: 'relay_install'; stagedRevision: string })
  | (RelayMutation & { action: 'relay_remove' });
type RelayFileState = 'ready' | 'missing' | 'invalid' | 'pair_mismatch' | 'unavailable';
export interface RelaySetupReport {
  revision: number;
  paired: boolean;
  pairingPending: boolean;
  host: RelayFileState;
  staged: RelayFileState;
  stagedRevision: string;
  device: { state: 'empty' | 'ready' | 'invalid' | 'unavailable' | 'storage_error'; revision: string } | null;
}
export interface EnvironmentReport {
  platform: 'macos' | 'unsupported';
  pythonReady: boolean;
  storage: 'unconfigured' | 'absent' | 'private' | 'invalid' | 'unavailable';
  deviceAccess: boolean;
  managedUsb?: true;
  /** Host interface metadata, never a connection or port probe. */
  localNetwork?: {
    status: 'available' | 'unavailable';
    endpoints: { interfaceName: string; url: string }[];
    truncated: boolean;
  };
  serial: 'available' | 'missing' | 'unavailable' | 'not_checked';
  openssl: 'available' | 'missing' | 'unavailable';
  ports: { path: string; description: string; vid: number; pid: number }[];
  truncated: boolean;
}
export interface PairingHost {
  call(request: PairingRequest, signal?: AbortSignal): Promise<PairingOutcome>;
  identify(port: string, signal?: AbortSignal): Promise<{ ok: true; value: DeviceIdentification } | { ok: false; error: string }>;
  diagnose(signal?: AbortSignal): Promise<{ ok: true; value: EnvironmentReport } | { ok: false; error: string }>;
  prepareRuntime(signal?: AbortSignal): Promise<{ ok: true; value: EnvironmentReport } | { ok: false; error: string }>;
  relay(request: RelaySetupRequest, signal?: AbortSignal): Promise<{ ok: true; value: RelaySetupReport } | { ok: false; error: string }>;
}

declare module '@deepseek-ai/cordis' {
  interface Context { stackchanPairing: PairingHost; stackchanPairingRemote: PairingRemote; }
}
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'stackchan/owner-required': {};
    'stackchan/pairing-failed': { reason: string };
  }
}

/** Device maintenance is owner-only, even if a broad external policy allows it. */
export class PairingRemote extends TypertRemoteService {
  constructor(ctx: Context) { super(ctx, 'stackchanPairingRemote', { namespace: 'stackchanPairing' }); }

  /** Explicit owner setup: isolated per-profile venv, bundled pinned wheel, no hardware permission. */
  @Remote
  async prepareRuntime(signal: AbortSignal): Promise<EnvironmentReport> {
    if (this.ctx.invocation?.peer.principal.kind !== 'owner')
      throw new RemoteError('stackchan/owner-required', 'Only the owner may prepare StackChan runtime.', {});
    signal.throwIfAborted();
    const result = await this.ctx.stackchanPairing.prepareRuntime(signal);
    signal.throwIfAborted();
    if (!result.ok) throw new RemoteError('stackchan/pairing-failed', 'StackChan runtime setup needs attention.', { reason: result.error });
    return result.value;
  }

  /** Explicit read-only inventory. Does not open USB, create storage or verify firmware. */
  @Remote
  async diagnose(signal: AbortSignal): Promise<EnvironmentReport> {
    if (this.ctx.invocation?.peer.principal.kind !== 'owner')
      throw new RemoteError('stackchan/owner-required', 'Only the owner may manage StackChan pairing.', {});
    signal.throwIfAborted();
    const result = await this.ctx.stackchanPairing.diagnose(signal);
    signal.throwIfAborted();
    if (!result.ok) throw new RemoteError('stackchan/pairing-failed', 'StackChan environment check needs attention.', { reason: result.error });
    return result.value;
  }

  /** Read the existing SIONA1 status from one explicitly selected USB port. */
  @Remote
  async identify(port: string, signal: AbortSignal): Promise<DeviceIdentification> {
    if (this.ctx.invocation?.peer.principal.kind !== 'owner')
      throw new RemoteError('stackchan/owner-required', 'Only the owner may identify a StackChan device.', {});
    signal.throwIfAborted();
    const result = await this.ctx.stackchanPairing.identify(port, signal);
    signal.throwIfAborted();
    if (!result.ok) throw new RemoteError('stackchan/pairing-failed', 'StackChan identification needs attention.', { reason: result.error });
    return result.value;
  }

  /** Explicit settings action; snapshot alone never opens a serial device.
   * @param request - one action with the last observed Host revision.
   * @param signal - cancellation propagated to the private helper.
   * @returns redacted persisted identity status, not an online-device assertion.
   */
  @Remote
  async execute(request: PairingRequest, signal: AbortSignal): Promise<PairingSnapshot> {
    if (this.ctx.invocation?.peer.principal.kind !== 'owner')
      throw new RemoteError('stackchan/owner-required', 'Only the owner may manage StackChan pairing.', {});
    signal.throwIfAborted();
    const result = await this.ctx.stackchanPairing.call(request, signal);
    signal.throwIfAborted();
    if (!result.ok) throw new RemoteError('stackchan/pairing-failed', 'StackChan pairing needs attention.', { reason: result.error });
    return result.value;
  }

  /** Profile paths and secrets are supplied by the local Host. */
  @Remote
  async relay(request: RelaySetupRequest, signal: AbortSignal): Promise<RelaySetupReport> {
    if (this.ctx.invocation?.peer.principal.kind !== 'owner')
      throw new RemoteError('stackchan/owner-required', 'Only the owner may configure the StackChan relay.', {});
    signal.throwIfAborted();
    const result = await this.ctx.stackchanPairing.relay(request, signal);
    signal.throwIfAborted();
    if (!result.ok) throw new RemoteError('stackchan/pairing-failed', 'StackChan relay setup needs attention.', { reason: result.error });
    return result.value;
  }
}


type CapabilityId = 'audio' | 'playbackFence' | 'expression' | 'camera' | 'motion' | 'ring';
type VoicePhase = 'stopped' | 'starting' | 'listening' | 'connecting' | 'active' | 'stopping' | 'fault' | 'disposed';
export interface DeviceCapabilityReport {
  version: 1;
  voicePhase: VoicePhase;
  features: Record<CapabilityId, {
    availability: 'supported' | 'unsupported' | 'unknown';
    version?: 1;
    permission: 'allowed' | 'disabled' | 'unknown' | 'not-applicable';
    condition: 'not-available' | 'needs-voice' | 'restart-required' | 'ready' | 'permission-disabled'
      | 'permission-unknown' | 'busy' | 'fault' | 'avatar-page-required' | 'attachment-service-unavailable';
  }>;
  conversation?: {
    replyMode: 'inactive' | 'spoken' | 'caption-only';
    captionChannel: 'unknown' | 'requested' | 'not-requested';
  };
  battery?: {
    version: 1;
    status: 'waiting' | 'stale' | 'unavailable' | 'current';
    percent?: number;
    direction?: 'charging' | 'discharging' | 'idle';
  };
  ambient?: {
    version: 1;
    status: 'waiting' | 'stale' | 'unavailable' | 'current';
    light?: { channel0: number; channel1: number };
    proximityRaw?: number;
  };
  headTouch?: {
    version: 1 | 2;
    status: 'waiting' | 'stale' | 'unavailable' | 'current';
    levels?: [0 | 1 | 2 | 3, 0 | 1 | 2 | 3, 0 | 1 | 2 | 3];
    recentGestures?: {
      sequence: number;
      kind: 'tap' | 'hold' | 'toward_channel_1' | 'toward_channel_3';
      durationMs: number;
      peak: 1 | 2 | 3;
      ageMs: number;
    }[];
  };
  imu?: {
    version: 1;
    status: 'waiting' | 'stale' | 'unavailable' | 'current';
    accelerationMg?: [number, number, number];
    angularVelocityMdps?: [number, number, number];
  };
  notExposed: ('ambientSensors' | 'inertialSensors' | 'batteryAndClock' | 'clock' | 'touchAndButtons' | 'infrared'
    | 'screenTouchAndButtons' | 'magnetometer' | 'nfc' | 'removableStorage' | 'grove' | 'bluetooth' | 'factoryApps' | 'customWake')[];
}

export interface VoiceSnapshot {
  capabilities?: DeviceCapabilityReport;
  /** Owner-voice enrolment and policy. Never carries the voice profile itself. */
  ownerVoice?: {
    available: boolean;
    enrolled: boolean;
    enrolling: boolean;
    collected: number;
    needed: number;
    lastResult: string;
    policy: 'off' | 'wake' | 'always';
  };
  latency?: {
    enabled: boolean;
    latest: {
      asrMs?: number;
      asrQueueMs?: number;
      bridgeQueueMs?: number;
      dshAdmissionMs?: number;
      dshPromptToTurnEndMs?: number;
      ttsFirstPcmMs?: number;
      ttsPreparedBeforeTurnEndMs?: number;
      outputAckMs?: number;
      segmentToFirstOutputAckMs: number;
    } | null;
  };
  ring?: {
    capability: 'available' | 'unsupported' | 'disconnected';
    status: 'unavailable' | 'waiting' | 'current' | 'stale';
    permission: 'unknown' | 'allowed' | 'disabled';
    phase: 'unknown' | 'idle' | 'preparing' | 'lit' | 'clearing' | 'fault';
    error: string;
  };
  motion?: {
    capability: 'available' | 'unsupported' | 'disconnected';
    status: 'unavailable' | 'waiting' | 'current' | 'stale';
    permission: 'unknown' | 'allowed' | 'disabled';
    phase: 'unknown' | 'idle' | 'opening' | 'commanding' | 'moving' | 'releasing' | 'fault';
    error: string;
  };
  camera?: {
    capability: 'available' | 'unsupported' | 'disconnected';
    status: 'unavailable' | 'waiting' | 'current' | 'stale';
    permission: 'unknown' | 'allowed' | 'disabled';
    phase: 'unknown' | 'idle' | 'opening' | 'capturing' | 'closing' | 'transferring' | 'fault';
    busy: boolean;
    error: string;
    attachmentsAvailable: boolean;
    operation: 'idle' | 'capturing' | 'importing' | 'saved' | 'failed' | 'cancelling';
    operationError: string;
  };
  installation: {
    mode: 'managed' | 'custom' | 'unavailable';
    stage: 'idle' | 'checking' | 'prerequisites' | 'python' | 'dependencies' | 'models' | 'audio' | 'whisper' | 'verifying' | 'publishing' | 'ready' | 'failed';
    busy: boolean;
    available: boolean;
    error: string;
    prerequisites: {
      checkedAt: number;
      platform: 'available' | 'unsupported';
      python: 'available' | 'missing' | 'not_checked';
      developerTools: 'available' | 'missing' | 'not_checked';
      ready: boolean;
    } | null;
  };
  phase: VoicePhase;
  connected: boolean;
  transport: 'lan' | 'usb' | 'relay' | null;
  sessionId: string;
  pendingChanges: boolean;
  relayStandby: boolean;
  lanStandby: boolean;
  usbStandby: boolean;
  applied: boolean;
  lastError: string;
  canReconnect: boolean;
  deviceIdleConfirmed: boolean;
}
export interface VoiceEnvironmentReport {
  checkedAt: number;
  checks: { id: 'platform' | 'python' | 'packages' | 'whisper' | 'speechAssets' | 'audioAssets' | 'nativeLibraries' | 'temporaryDirectory';
    status: 'not_checked' | 'unconfigured' | 'missing' | 'invalid' | 'unsupported' | 'available' | 'verified' }[];
  filesVerified: boolean;
  loadTest: 'not_run' | 'passed' | 'failed';
  failedStage: '' | 'audio' | 'synthesis' | 'recognition' | 'cleanup';
  assetBytes: number;
}
export interface VoicePreviewRequest {
  language: 'auto' | 'zh' | 'en';
  voice: '' | 'zf_001' | 'zf_038' | 'af_maple';
  speechRate: number;
}
export interface VoicePreview {
  language: 'zh' | 'en';
  /** Base64 PCM16 mono WAV, at most eight seconds. */
  wav: string;
}
export interface VoiceRuntime {
  environment(action: 'inspect' | 'verify', signal?: AbortSignal): Promise<VoiceEnvironmentReport>;
  preview(request: VoicePreviewRequest, signal?: AbortSignal): Promise<VoicePreview>;
  execute(action: 'snapshot' | 'start' | 'connect' | 'arm-relay' | 'arm-lan' | 'arm-usb' | 'stop' | 'shutdown' | 'prepare-environment' | 'repair-environment' | 'check-installation' | 'owner-voice-enroll' | 'owner-voice-cancel' | 'owner-voice-forget', signal?: AbortSignal): Promise<VoiceSnapshot>;
}
declare module '@deepseek-ai/cordis' {
  interface Context { stackchanVoice: VoiceRuntime; stackchanVoiceRemote: VoiceRemote; }
}
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap { 'stackchan/voice-failed': { reason: string }; }
}
/** Runtime control never accepts identity files, executables or network addresses. */
export class VoiceRemote extends TypertRemoteService {
  constructor(ctx: Context) { super(ctx, 'stackchanVoiceRemote', { namespace: 'stackchanVoice' }); }
  /** Explicit metadata/hash check or offline synthetic model test. No device audio. */
  @Remote
  async environment(action: 'inspect' | 'verify', signal: AbortSignal): Promise<VoiceEnvironmentReport> {
    if (this.ctx.invocation?.peer.principal.kind !== 'owner')
      throw new RemoteError('stackchan/owner-required', 'Only the owner may check StackChan voice.', {});
    signal.throwIfAborted();
    try { return await this.ctx.stackchanVoice.environment(action, signal); }
    catch (error) {
      const reason = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'voice_environment_failed';
      throw new RemoteError('stackchan/voice-failed', 'StackChan voice environment needs attention.', { reason });
    }
  }
  /** Synthesize a fixed local sample using just the selected voice preferences. */
  @Remote
  async preview(language: 'auto' | 'zh' | 'en', voice: '' | 'zf_001' | 'zf_038' | 'af_maple', speechRate: number, signal: AbortSignal): Promise<VoicePreview> {
    if (this.ctx.invocation?.peer.principal.kind !== 'owner')
      throw new RemoteError('stackchan/owner-required', 'Only the owner may preview StackChan voice.', {});
    signal.throwIfAborted();
    try { return await this.ctx.stackchanVoice.preview({ language, voice, speechRate }, signal); }
    catch (error) {
      const reason = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'voice_preview_failed';
      throw new RemoteError('stackchan/voice-failed', 'StackChan voice preview needs attention.', { reason });
    }
  }
  @Remote
  async execute(action: 'snapshot' | 'start' | 'connect' | 'arm-relay' | 'arm-lan' | 'arm-usb' | 'stop' | 'shutdown' | 'prepare-environment' | 'repair-environment' | 'check-installation' | 'owner-voice-enroll' | 'owner-voice-cancel' | 'owner-voice-forget', signal: AbortSignal): Promise<VoiceSnapshot> {
    if (this.ctx.invocation?.peer.principal.kind !== 'owner')
      throw new RemoteError('stackchan/owner-required', 'Only the owner may control StackChan voice.', {});
    signal.throwIfAborted();
    try { return await this.ctx.stackchanVoice.execute(action, signal); }
    catch (error) {
      const reason = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'voice_connect_failed';
      throw new RemoteError('stackchan/voice-failed', 'StackChan voice needs attention.', { reason });
    }
  }
}
