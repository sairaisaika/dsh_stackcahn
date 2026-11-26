import { performance } from 'node:perf_hooks';

/** Voice ownership only: never supplies a system prompt or substitutes a session. */
export class BridgeError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
export const requiredVoiceCapabilities = Object.freeze([
  'continuousTranscripts', 'speakText', 'interruptPlayback',
  'restoreOriginal', 'preservesOriginalAssistant',
]);
export const independentVoiceCapabilities = Object.freeze([
  'continuousTranscripts', 'speakText', 'interruptPlayback', 'releaseToIdle',
]);
export function isStop(text) {
  return /^(停止|待机|去待机|回去待机|退出deepseek|回到原助手|stop|standby)$/u.test(
    text.normalize('NFKC').trim().toLowerCase().replace(/[\s。！!，,.？?]+$/u, ''),
  );
}
// Ends the current reply only. The connection keeps listening.
// v66: people rarely say the bare phrase. They repeat it, put a filler or the
// wake name in front, or add a particle: 「好了好了别说了」「小D停一下吧」.
// Soft words also answer questions (「准备好了吗」「好了」), so they count only
// while a reply is actually playing or being prepared.
const hushStrong = String.raw`别说了|不要说了|不用说了|别讲了|不要讲了|别念了|安静(?:一下|点)?|闭嘴|打住|停一下|停下(?:来)?|停停|停|quiet|be quiet|hush|shut up|stop talking|ok stop`;
const hushSoft = String.raw`等一下|等等|算了|好了|行了|够了|可以了|never mind|enough`;
const hushFiller = String.raw`(?:好了|好的|好|行|嗯|啊|哎|诶|欸|喂|唉|ok|okay|你|先|快)`;
const hushPattern = words => new RegExp(String.raw`^(?:${hushFiller}[\s,，、]*)*(?:(?:${words})(?:吧|啦|呀|啊|了|哦|嘛)?[\s,，、!！.。]*){1,4}$`, 'u');
const hushAny = hushPattern(`${hushStrong}|${hushSoft}`), hushOnlyStrong = hushPattern(hushStrong);
/** True for a short utterance that only asks the current reply to stop.
 * strip removes a leading wake name first, when the caller has one.
 * soft=false leaves out words that could also be an answer. */
export function isHush(text, strip, { soft = true } = {}) {
  let value = String(text).normalize('NFKC').trim().toLowerCase().replace(/[\s。！!，,.？?~…]+$/u, '');
  const addressed = strip?.(value);
  if (addressed) value = addressed.rest.toLowerCase();
  return value.length > 0 && value.length <= 24 && (soft ? hushAny : hushOnlyStrong).test(value);
}
const edge = String.raw`[\s,，。.!！?？、~…:：]`;
// Wake names come from configuration so nothing personal is compiled in. Each
// entry is plain text plus two optional shapes for recognition variants:
// [abc] = any one of these characters, (ab|cd) = any one of these spellings.
// Recognition often writes homophones or traditional characters, so list them.
export const defaultWakeNames = Object.freeze(['stackchan', 'stack chan']);
const wakeGreeting = String.raw`(?:嘿|喂|嗨|你好|hi|hey|hello)?`;
// 「在吗」 and the spellings recognition gives it, or just a pause after the name.
const wakeTail = String.raw`(?:${edge}*(?:你)?(?:在|再|带|帶|待)(?:吗|嗎|嘛|么|麼|麽|不在|没有?|沒有?|不|(?=${edge}|$))|(?=${edge}|$))${edge}*`;
function wakeNameSource(name) {
  let out = '', depth = 0, inClass = false;
  for (const ch of String(name).normalize('NFKC').trim()) {
    // Recognition may put spaces anywhere inside a name (「小 D」), so every unit
    // is followed by optional whitespace.
    if (inClass) { if (ch === ']') { inClass = false; out += String.raw`]\s*`; } else out += /[\\\]^-]/u.test(ch) ? `\\${ch}` : ch; continue; }
    if (ch === '[') { inClass = true; out += '['; }
    else if (ch === '(') { depth++; out += '(?:'; }
    else if (ch === ')' && depth) { depth--; out += ')'; }
    else if (ch === '|' && depth) out += '|';
    else if (/\s/u.test(ch)) continue;
    else out += ch.replace(/[.*+?^${}()|[\]\\/]/gu, '\\$&') + String.raw`\s*`;
  }
  if (inClass || depth) throw new BridgeError('wake_name_invalid', `Unbalanced wake name: ${name}`);
  return out;
}
/** Builds a matcher for the configured wake names. Invalid entries are rejected. */
export function createWakeMatcher(names = defaultWakeNames) {
  const list = (Array.isArray(names) ? names : []).map(String).filter(name => name.trim());
  if (!list.length) return () => null;
  const pattern = new RegExp(String.raw`^${edge}*${wakeGreeting}${edge}*(?:${list.map(wakeNameSource).join('|')})` + wakeTail, 'iu');
  return text => {
    const normalized = String(text).normalize('NFKC').trim();
    const match = pattern.exec(normalized);
    return match ? { rest: normalized.slice(match[0].length).trim() } : null;
  };
}
const defaultWakeMatcher = createWakeMatcher();
/** The wake phrase (a configured name, optionally followed by 「在吗」) at the start
 * of an utterance. Returns what was said after it (possibly empty), or null. */
export function matchWake(text, matcher = defaultWakeMatcher) { return matcher(text); }
// What the body can report to DSH. Plain descriptions; how to react is DSH's call.
const bodyEvents = Object.freeze({ stroke: '（摸了摸你的头）' });
// What the head strip did, in sensor terms. Never what it means: the owner may
// tell DSH what a gesture is to them (v66: 「对我来说是在摸头」).
const touchShapes = Object.freeze({
  tap: '短触', hold: '持续接触',
  toward_channel_3: '从通道1滑向通道3', toward_channel_1: '从通道3滑向通道1',
});
const clock = at => [at.getHours(), at.getMinutes(), at.getSeconds()].map(n => String(n).padStart(2, '0')).join(':');
/** One head-touch report as a factual line, or null for anything unknown. */
export function describeTouch({ kind, durationMs, peak } = {}, at = new Date()) {
  const shape = touchShapes[kind];
  if (!shape || !Number.isFinite(durationMs) || durationMs < 0 || ![1, 2, 3].includes(peak)) return null;
  return `${clock(at)} 头顶电容（三通道，强度0–3）：${shape}，${(Math.round(durationMs / 100) / 10).toFixed(1)}秒，峰值强度${peak}`;
}
export const bodyFactModes = Object.freeze(['off', 'context', 'turn']);
function deadline(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new BridgeError('timeout', 'Operation timed out')), ms); }),
  ]).finally(() => clearTimeout(timer));
}
async function playbackDeadline(lease, text, options, ms) {
  let timer;
  let onProgress;
  const stalled = new Promise((_, reject) => {
    onProgress = () => {
      clearTimeout(timer);
      timer = setTimeout(() => reject(new BridgeError('timeout', 'Playback made no progress')), ms);
    };
    onProgress();
  });
  try {
    return await Promise.race([lease.speak(text, { ...options, onProgress: () => onProgress?.() }), stalled]);
  } finally {
    clearTimeout(timer);
    onProgress = undefined;
  }
}
export class VoiceBridge {
  constructor({ voice, dsh, exitTarget = 'original', timeoutMs = 10000, turnTimeoutMs = 180000, maxQueued = 4,
    idleReleaseMs = 0, eventCooldownMs = 0, eventsPerHour = 12, ownerOnly = 'off', touchActions = false,
    speakEarly = false, speakSessionReplies = false, wakeNames = defaultWakeNames, bodyFacts = 'context',
    onLatency, onReleased, onStage }) {
    if (!bodyFactModes.includes(bodyFacts)) throw new BridgeError('invalid-body-facts', 'Unknown body fact mode');
    // Head-touch facts for DSH. 'context': kept and handed over with the next
    // thing said to her, without starting a turn. 'turn': told at once, within
    // the event budget below. 'off': only stackchan_device_status shows them.
    this.bodyFacts = bodyFacts; this.facts = []; this.factsDropped = 0;
    if (!['off', 'wake', 'always'].includes(ownerOnly)) throw new BridgeError('invalid-owner-policy', 'Unknown owner-voice policy');
    // 'wake': only the enrolled owner can call a waiting device. 'always': other
    // voices are ignored throughout. An utterance that could not be judged counts as not the owner.
    this.ownerOnly = ownerOnly;
    // Head-strip gestures act on the conversation only when enabled. Off until the
    // v62 false reports are understood: they hushed every reply and invented strokes.
    this.touchActions = touchActions;
    // Start speaking the reply's first sentence while DSH is still writing the rest.
    this.speakEarly = speakEarly;
    // Read aloud replies in the bound session that voice did not ask for (opt-in).
    this.speakSessionReplies = speakSessionReplies;
    this.matchWake = createWakeMatcher(wakeNames);
    if (!['original', 'device-idle'].includes(exitTarget)) throw new BridgeError('invalid-exit-target', 'Unknown voice release target');
    this.exitTarget = exitTarget;
    this.idleState = exitTarget === 'original' ? 'original' : 'idle';
    this.voice = voice; this.dsh = dsh;
    this.onLatency = onLatency;
    this.onReleased = onReleased;
    this.onStage = onStage;
    this.timeoutMs = timeoutMs; this.turnTimeoutMs = turnTimeoutMs; this.maxQueued = maxQueued;
    this.idleReleaseMs = idleReleaseMs; this.idleTimer = null;
    // Things the body notices are told to DSH sparingly: each kind at most once
    // per cooldown, and all kinds together at most eventsPerHour.
    this.eventCooldownMs = eventCooldownMs; this.eventsPerHour = eventsPerHour;
    this.toldAt = new Map(); this.toldTimes = []; this.told = 0;
    this.state = this.idleState; this.generation = 0; this.queue = Promise.resolve();
    this.pending = 0; this.seen = new Set(); this.lastError = null;
    this.lease = null; this.acquisition = null; this.stopping = null;
    this.turn = null; this.lastTurnError = null; this.turnEndedAt = -Infinity;
    // A linked-standby device stays connected while nobody addresses it. Only
    // an awake bridge passes speech to DSH.
    this.linked = false; this.awake = true; this.wakeEpoch = 0;
  }
  indicate(lease, state) { try { lease?.indicate?.(state); } catch {} }
  /** From waiting to attending: the wake phrase, a tap or hold, or DSH speaking first. */
  wake(source, { acknowledge = false } = {}) {
    if (!this.linked || this.awake || this.state !== 'bridged') return false;
    this.awake = true;
    this.stage('wake', { source });
    this.indicate(this.lease, 'listening');
    if (acknowledge) {
      const lease = this.lease, signal = this.abort.signal;
      Promise.resolve().then(() => lease.notice?.('wake', { signal })).catch(() => {});
    }
    return true;
  }
  /** Back to waiting without giving up the link. Drops the reply in progress and anything queued. */
  async sleep(source) {
    if (!this.linked || !this.awake || this.state !== 'bridged') return { ignored: true };
    this.awake = false; ++this.wakeEpoch;
    this.stage('sleep', { source });
    const turn = this.turn, lease = this.lease;
    if (turn) { turn.hushed = true; turn.abort.abort(new BridgeError('asleep', 'Returned to standby')); }
    try { await deadline(Promise.resolve(lease.interrupt?.()), this.timeoutMs); } catch {}
    if (!this.awake) this.indicate(lease, 'standby');
    return { asleep: true };
  }
  /** A tap on the device face toggles between waiting and attending; the face
   * Stop button ('sleep') only ever returns to waiting, keeping the link.
   * While a reply is playing or being prepared, a tap only silences it. */
  attention(intent = 'toggle') {
    if (!this.linked || this.state !== 'bridged') return;
    if (intent === 'sleep') { void this.sleep('stop-button'); return; }
    // v66: a tap while she was talking meant 「别说了」, not 「去待机」.
    if (this.awake && this.turn && !this.turn.hushed) { void this.hush('tap'); return; }
    if (this.awake) void this.sleep('attention'); else this.wake('attention', { acknowledge: true });
  }
  /** Something the body noticed, handed to DSH as one input so it can respond in
   * its own voice. Returns false when the budget says not to bother it now. */
  tell(kind) {
    const text = bodyEvents[kind];
    if (!text || this.state !== 'bridged' || !(this.eventCooldownMs > 0)) return false;
    const now = performance.now();
    if (now - (this.toldAt.get(kind) ?? -Infinity) < this.eventCooldownMs) return false;
    this.toldTimes = this.toldTimes.filter(at => now - at < 3600000);
    if (this.toldTimes.length >= this.eventsPerHour) return false;
    this.toldAt.set(kind, now); this.toldTimes.push(now);
    this.wake('event');
    this.stage('event-told', { source: kind });
    void this.receive({ id: `event-${this.generation}-${++this.told}`, text, final: true, commandEligible: false, trusted: true });
    return true;
  }
  /** Records a head-touch fact for DSH according to bodyFacts. */
  noteTouch(gesture) {
    if (this.bodyFacts === 'off' || this.state !== 'bridged') return;
    const fact = describeTouch(gesture);
    if (!fact) return;
    if (this.bodyFacts === 'turn') { this.tellFact(fact); return; }
    this.facts.push(fact);
    if (this.facts.length > 8) { this.facts.shift(); this.factsDropped++; }
    this.stage('body-fact-kept');
  }
  /** Pending facts as a block that goes before the next spoken text, then forgotten. */
  takeFacts() {
    if (!this.facts.length) return '';
    const dropped = this.factsDropped ? `（更早还有 ${this.factsDropped} 条未列出）\n` : '';
    const block = `［身体传感，非主人原话］\n${dropped}${this.facts.join('\n')}\n［以下是主人说的话］\n`;
    this.facts = []; this.factsDropped = 0;
    return block;
  }
  /** Starts a turn with one fact, inside the same budget as other body events. */
  tellFact(fact) {
    if (this.state !== 'bridged' || !(this.eventCooldownMs > 0)) return false;
    const now = performance.now();
    if (now - (this.toldAt.get('touch') ?? -Infinity) < this.eventCooldownMs) return false;
    this.toldTimes = this.toldTimes.filter(at => now - at < 3600000);
    if (this.toldTimes.length >= this.eventsPerHour) return false;
    this.toldAt.set('touch', now); this.toldTimes.push(now);
    this.wake('event');
    this.stage('event-told', { source: 'touch' });
    void this.receive({ id: `event-${this.generation}-${++this.told}`, text: `［身体传感］${fact}`, final: true, commandEligible: false, trusted: true, fact: true });
    return true;
  }
  /** Head touch strip. A hold wakes, a tap silences the current reply, a stroke is told to DSH. */
  gesture(gesture = {}) {
    this.noteTouch(gesture);
    const { kind } = gesture;
    if (this.state !== 'bridged' || !this.touchActions) return;
    if (kind === 'hold') this.wake('touch', { acknowledge: true });
    else if (kind === 'tap') { if (this.turn) void this.hush(); }
    else if (kind === 'toward_channel_1' || kind === 'toward_channel_3') this.tell('stroke');
  }
  /** DSH speaking first. Wakes a waiting device, then listens for an answer like any reply. */
  say(text, { pcm } = {}) {
    if (this.state !== 'bridged') return Promise.reject(new BridgeError('voice-not-connected', 'The device is not connected'));
    if (pcm !== undefined && !(Buffer.isBuffer(pcm) && pcm.length > 0 && pcm.length % 2 === 0))
      return Promise.reject(new BridgeError('invalid-speech', 'Invalid sound'));
    if (pcm === undefined && (typeof text !== 'string' || !text.trim())) return Promise.reject(new BridgeError('invalid-speech', 'Nothing to say'));
    this.wake('agent');
    const gen = this.generation, epoch = this.wakeEpoch, lease = this.lease, signal = this.abort.signal;
    // Said from inside the voice turn that is still waiting on DSH: queueing
    // behind that turn would wait for itself. Play now, in order with the
    // turn's own early speech; the final reply waits for this to finish.
    const host = this.turn;
    if (host?.asking && !host.hushed) {
      if (!pcm) try { lease.caption?.('assistant', text); } catch {}
      if (lease.captionOnly) return Promise.resolve({ spoken: false, captioned: true });
      const inline = host.speaking.then(() => {
        if (signal.aborted || gen !== this.generation || host.abort.signal.aborted) return { ignored: true };
        this.stage('agent-speech-inline');
        return playbackDeadline(lease, text, { signal: AbortSignal.any([signal, host.abort.signal]), pcm }, this.turnTimeoutMs)
          .then(() => ({ spoken: true }));
      }).catch(error => (host.hushed ? { interrupted: true } : { failed: error.code ?? 'speech-failed' }));
      host.speaking = inline.then(() => undefined);
      return inline;
    }
    const turn = { abort: new AbortController(), lease, hushed: false };
    this.pending++;
    const run = this.queue.then(async () => {
      if (signal.aborted || gen !== this.generation || epoch !== this.wakeEpoch) return { ignored: true };
      this.turn = turn;
      if (!pcm) try { lease.caption?.('assistant', text); } catch {}
      if (lease.captionOnly) return { spoken: false, captioned: true };
      this.stage(pcm ? 'agent-sound-requested' : 'agent-speech-requested');
      await playbackDeadline(lease, text, { signal: AbortSignal.any([signal, turn.abort.signal]), pcm }, this.turnTimeoutMs);
      return { spoken: true };
    }).catch(error => (turn.hushed ? { interrupted: true } : { failed: error.code ?? 'speech-failed' })).finally(() => {
      if (this.turn === turn) { this.turn = null; this.turnEndedAt = performance.now(); }
      if (gen === this.generation) this.pending--;
    });
    this.queue = run.then(() => undefined);
    return run;
  }
  stage(name, fields) {
    try { this.onStage?.(name, fields); } catch {}
  }
  /** Abandon the reply in progress without leaving the handoff. DSH keeps its own turn. */
  async hush(source = 'voice') {
    const turn = this.turn;
    if (!turn || turn.hushed) return { ignored: true };
    turn.hushed = true;
    this.stage('spoken-hush', { source });
    turn.abort.abort(new BridgeError('hushed', 'Reply dismissed by voice'));
    try { await deadline(Promise.resolve(turn.lease.interrupt?.()), this.timeoutMs); } catch {}
    return { interrupted: true };
  }
  /** A linked device goes back to waiting once the room has been quiet for
   * idleReleaseMs. A turn in flight or anyone talking counts as activity. */
  watchIdle(gen, lease) {
    if (!(this.idleReleaseMs > 0) || !this.linked) return;
    let quietSince = performance.now();
    const check = () => {
      if (gen !== this.generation || this.state !== 'bridged') return;
      const now = performance.now();
      let heard = 0;
      try { heard = lease.lastSpeechAtMs?.() ?? 0; } catch {}
      // A device that is merely waiting has nothing to time out.
      if (this.pending > 0 || this.turn || !this.awake) quietSince = now;
      else if (heard > quietSince) quietSince = heard;
      let remaining = this.idleReleaseMs - (now - quietSince);
      if (remaining <= 0) {
        // The link stays; the device just stops being attended to.
        void this.sleep('idle');
        quietSince = now; remaining = this.idleReleaseMs;
      }
      this.idleTimer = setTimeout(check, Math.min(remaining, 1000));
      this.idleTimer.unref?.();
    };
    this.idleTimer = setTimeout(check, Math.min(this.idleReleaseMs, 1000));
    this.idleTimer.unref?.();
  }
  status() {
    return { state: this.state, generation: this.generation, sessionId: this.sessionId ?? null,
      voiceMode: this.voice.mode, exitTarget: this.exitTarget, pending: this.pending, lastError: this.lastError,
      lastTurnError: this.lastTurnError, ...(this.linked ? { attending: this.awake } : {}) };
  }
  async enter(sessionId) {
    if (this.state !== this.idleState) throw new BridgeError('busy', 'Exit or recover the current handoff first');
    if (typeof sessionId !== 'string' || !sessionId.trim()) throw new BridgeError('session-required', 'Choose an existing DSH session');
    const required = this.exitTarget === 'original' ? requiredVoiceCapabilities : independentVoiceCapabilities;
    const missing = required.filter(k => this.voice.capabilities?.[k] !== true);
    if (missing.length) throw new BridgeError('unsupported-voice', `Voice adapter lacks: ${missing.join(', ')}`);
    this.state = 'connecting'; this.lastError = null; this.lastTurnError = null;
    const gen = ++this.generation;
    this.abort = new AbortController();
    const signal = this.abort.signal;
    this.sessionId = sessionId;
    this.seen = new Set(); this.facts = []; this.factsDropped = 0;
    // A fresh queue never waits for a detached old DSH request.
    this.queue = Promise.resolve(); this.pending = 0;
    this.acquisition = (async () => {
      this.binding = await this.dsh.bind(sessionId, { signal });
      signal.throwIfAborted();
      const lease = await this.voice.acquire({
        signal,
        exitTarget: this.exitTarget,
        onTranscript: event => this.receive(event, gen),
        onAttention: intent => { if (gen === this.generation) this.attention(intent); },
        onGesture: gesture => { if (gen === this.generation) this.gesture(gesture); },
        onDisconnect: error => {
          if (gen === this.generation) {
            this.lastError = error?.code ?? 'voice-disconnected';
            void this.stop('voice-disconnected');
          }
        },
      });
      // Always retain a late lease so stop/recovery can release it.
      this.lease = lease;
      signal.throwIfAborted();
      // Retain rollback ownership before a real adapter enables hardware.
      await lease.activate?.();
      signal.throwIfAborted();
      if (this.generation !== gen) throw new BridgeError('stale', 'Handoff was superseded');
    })();
    try {
      await deadline(this.acquisition, this.timeoutMs);
      if (gen !== this.generation) throw new BridgeError('stale', 'Handoff was stopped');
      this.state = 'bridged';
      this.linked = this.lease.standbyMode === 2; this.awake = !this.linked;
      if (this.linked) this.indicate(this.lease, 'standby');
      this.watchIdle(gen, this.lease);
      this.watchSession(gen, signal);
      return this.status();
    } catch (error) {
      this.lastError = error.code ?? 'connect-failed';
      await this.stop('connect-failed');
      throw error;
    }
  }
  watchSession(gen, signal) {
    const binding = this.binding;
    if (!this.speakSessionReplies || typeof binding?.watch !== 'function') return;
    this.stage('session-watch-started');
    binding.watch({ signal, onReply: text => {
      if (gen !== this.generation || this.state !== 'bridged') return;
      this.stage('session-reply-spoken');
      return this.say(text);
    } }).catch(() => {}).finally(() => { if (gen === this.generation) this.stage('session-watch-ended'); });
  }
  receive(event, gen = this.generation) {
    if (gen !== this.generation || this.state !== 'bridged') return Promise.resolve({ ignored: true });
    if (typeof event?.id !== 'string' || !event.id || typeof event.text !== 'string' || event.final !== true) {
      return Promise.resolve({ ignored: true });
    }
    const stranger = this.ownerOnly !== 'off' && event.trusted !== true && event.owner !== true;
    if (this.linked && !this.awake) {
      // Waiting: only the wake phrase gets through, and it is never sent to DSH itself.
      const addressed = this.matchWake(event.text);
      if (!addressed) { this.stage('wake-unmatched'); return Promise.resolve({ ignored: true }); }
      if (stranger) { this.stage('wake-refused'); return Promise.resolve({ ignored: true, refused: 'not-owner' }); }
      this.wake('phrase', { acknowledge: !addressed.rest });
      if (!addressed.rest) return Promise.resolve({ woke: true });
      event = { ...event, text: addressed.rest };
    }
    else if (stranger && this.ownerOnly === 'always') return Promise.resolve({ ignored: true, refused: 'not-owner' });
    // Stop bypasses both the ordinary queue and deduplication.
    if (event.commandEligible !== false && isStop(event.text)) {
      this.stage('spoken-stop');
      // A linked device goes back to waiting; any other is released.
      return this.linked ? this.sleep('voice-stop') : this.stop('voice-stop');
    }
    // A hush acts on the reply in progress, or on one that has only just ended
    // (the words often land after the last sentence). Otherwise it is ordinary
    // speech for DSH; nothing is swallowed while she is quiet.
    if (event.commandEligible !== false) {
      if (this.turn && !this.turn.hushed && isHush(event.text, this.matchWake)) return this.hush();
      if (!this.turn && performance.now() - this.turnEndedAt < 3000 && isHush(event.text, this.matchWake, { soft: false })) {
        this.stage('spoken-hush-late'); return Promise.resolve({ ignored: true });
      }
    }
    if (!event.text.trim() || this.seen.has(event.id)) return Promise.resolve({ ignored: true });
    // Bounded deduplication; adapters must never replay older accepted turns.
    if (this.seen.size >= 1024) this.seen.delete(this.seen.values().next().value);
    // Speech that arrives while an earlier turn is still running joins the next
    // turn that has not started yet, so DSH hears one message instead of a pile.
    const waiting = this.waiting;
    if (waiting && waiting.gen === gen && waiting.epoch === this.wakeEpoch) {
      this.seen.add(event.id); waiting.texts.push(event.text); this.stage('voice-merged');
      return waiting.run.then(result => ({ ...result, merged: true }));
    }
    if (this.pending >= this.maxQueued) return Promise.resolve({ rejected: 'queue-full' });
    this.seen.add(event.id);
    this.pending++;
    const entry = { gen, epoch: this.wakeEpoch, texts: [event.text], run: null };
    const binding = this.binding; const lease = this.lease; const signal = this.abort.signal;
    const epoch = this.wakeEpoch;
    const timing = this.onLatency && event.timing;
    const marks = timing ? Object.create(null) : null;
    const mark = marks ? name => { marks[name] ??= performance.now(); } : undefined;
    let faultSource = 'session';
    const turnAbort = new AbortController();
    const turn = { abort: turnAbort, lease, hushed: false, asking: false, speaking: Promise.resolve() };
    const run = this.queue.then(async () => {
      if (this.waiting === entry) this.waiting = null;
      if (signal.aborted || gen !== this.generation || epoch !== this.wakeEpoch) return { ignored: true };
      const spoken = entry.texts.join('\n');
      // Facts ride along with real speech only; a fact-only turn already carries its own.
      const prompt = event.fact ? spoken : this.takeFacts() + spoken;
      this.turn = turn;
      const turnSignal = AbortSignal.any([signal, turnAbort.signal]);
      let prepared;
      let previewDiscarded = false;
      let discardPreview;
      let stopProgress = () => {};
      // The first sentence, already playing while DSH finishes the turn.
      let early = null;
      const indicate = state => { try { lease.indicate?.(state); } catch {} };
      try {
        const options = { signal: turnSignal, ...(mark ? { mark } : {}) };
        const onSpeechPreview = !lease.captionOnly && lease.prepareSpeech ? prefix => {
          if (prefix === null) {
            // Already said aloud (typically "let me check" before a tool call):
            // the final reply is then spoken whole rather than spliced.
            if (early) { early.superseded = true; return; }
            previewDiscarded = true;
            discardPreview = prepared?.discard({ keepWorker: true });
            discardPreview?.catch(() => {});
          } else if (!prepared && !previewDiscarded && !turnSignal.aborted) {
            prepared = lease.prepareSpeech(prefix, options);
            if (this.speakEarly && prepared) {
              this.stage('playback-early');
              early = { prefix, superseded: false,
                done: playbackDeadline(lease, prefix, { ...options, prepared }, this.turnTimeoutMs) };
              early.done.catch(() => {});  // Awaited after the turn; a failure surfaces there.
              turn.speaking = turn.speaking.then(() => early.done).catch(() => {});
            }
          }
        } : undefined;
        // Captions never become a prerequisite for an accepted voice turn.
        const caption = (speaker, text) => {
          try { return lease.caption?.(speaker, text); } catch { return false; }
        };
        const userCaption = caption('user', spoken);
        // What DSH is doing right now, for faces that show a status line.
        // Throttled: only the latest update is sent, at most every 300 ms.
        let pendingProgress = null, progressTimer = null, lastProgressAt = 0;
        // First update of each kind per turn reaches the local log, so a silent face can be told apart from a silent stream.
        const progressSeen = new Set();
        const flushProgress = () => {
          progressTimer = null;
          if (!pendingProgress || turnSignal.aborted) return;
          const [speaker, text] = pendingProgress; pendingProgress = null;
          lastProgressAt = Date.now();
          if (caption(speaker, text) !== true && !progressSeen.has('rejected')) { progressSeen.add('rejected'); this.stage('progress-caption-rejected'); }
        };
        const onProgress = update => {
          if (turnSignal.aborted) return;
          if (update.kind === 'thinking') pendingProgress = ['status', `思考中：${update.text.replace(/\s+/gu, ' ').trim().slice(-90)}`];
          else if (update.kind === 'tool') pendingProgress = ['status', `正在用 ${update.name}…`];
          else if (update.kind === 'text') pendingProgress = ['assistant', update.text];
          else return;
          if (!progressSeen.has(update.kind)) { progressSeen.add(update.kind); this.stage(`progress-${update.kind}`); }
          if (progressTimer) return;
          progressTimer = setTimeout(flushProgress, Math.max(0, 300 - (Date.now() - lastProgressAt)));
          progressTimer.unref?.();
        };
        stopProgress = () => { pendingProgress = null; if (progressTimer) clearTimeout(progressTimer); progressTimer = null; };
        const showProgress = lease.captionStatus === true;
        if (showProgress) caption('status', '思考中…');
        indicate('waiting');
        mark?.('dshStarted');
        this.stage('dsh-turn-requested');
        turn.asking = true;
        let text;
        try { text = await deadline(binding.ask(prompt, { requestId: event.id, ...options, onSpeechPreview, ...(showProgress ? { onProgress } : {}) }), this.turnTimeoutMs); }
        finally { turn.asking = false; stopProgress(); }
        if (signal.aborted || gen !== this.generation) return { ignored: true };
        this.stage('dsh-turn-returned');
        if (typeof text !== 'string') throw new BridgeError('invalid-response', 'DSH did not return text');
        if (discardPreview) await deadline(discardPreview, this.turnTimeoutMs);
        turnSignal.throwIfAborted();
        if (!text.trim()) return { delivered: true };
        const answerCaption = userCaption !== false && caption('assistant', text);
        if (lease.captionOnly) {
          if (userCaption !== true || answerCaption !== true)
            throw new BridgeError('voice_caption_delivery_failed', 'Could not queue the reply as a device caption');
          this.stage('caption-sent');
          return { delivered: true };
        }
        mark?.('ttsStarted');
        faultSource = 'playback';
        let remaining = text;
        if (early) {
          await early.done;
          turnSignal.throwIfAborted();
          if (!early.superseded && text.startsWith(early.prefix)) remaining = text.slice(early.prefix.length);
        }
        await turn.speaking;  // Anything said inline during the turn finishes first.
        turnSignal.throwIfAborted();
        this.stage('playback-requested');
        if (remaining.trim())
          await playbackDeadline(lease, remaining, { ...options, prepared: early || previewDiscarded ? undefined : prepared }, this.turnTimeoutMs);
        if (!signal.aborted && gen === this.generation) this.stage('playback-drained');
        if (marks?.outputAcknowledged !== undefined && !signal.aborted && gen === this.generation) {
          const { segmentReadyAtMs, asrStartedAtMs, asrEndedAtMs } = timing;
          if (Number.isFinite(segmentReadyAtMs) && Number.isFinite(asrStartedAtMs) && Number.isFinite(asrEndedAtMs)) {
            const sample = {
              asrQueueMs: asrStartedAtMs - segmentReadyAtMs,
              asrMs: asrEndedAtMs - asrStartedAtMs,
              bridgeQueueMs: marks.dshStarted - asrEndedAtMs,
              dshMs: marks.ttsStarted - marks.dshStarted,
              ttsFirstPcmMs: marks.ttsFirstPcm - marks.ttsStarted,
              outputBufferMs: marks.outputSubmitted - marks.ttsFirstPcm,
              outputAckMs: marks.outputAcknowledged - marks.outputSubmitted,
              segmentToFirstOutputAckMs: marks.outputAcknowledged - segmentReadyAtMs,
            };
            if (marks.dshPromptSubmitted !== undefined) {
              sample.dshAdmissionMs = marks.dshPromptSubmitted - marks.dshStarted;
              if (marks.dshPublicText !== undefined)
                sample.dshPromptToPublicTextMs = marks.dshPublicText - marks.dshPromptSubmitted;
              if (marks.dshTurnCompleted !== undefined)
                sample.dshPromptToTurnEndMs = marks.dshTurnCompleted - marks.dshPromptSubmitted;
            }
            if (marks.dshTurnCompleted !== undefined && marks.dshPublicText !== undefined)
              sample.dshPublicTextToTurnEndMs = marks.dshTurnCompleted - marks.dshPublicText;
            if (marks.dshTurnCompleted !== undefined)
              sample.dshTurnEndToOutputAckMs = marks.outputAcknowledged - marks.dshTurnCompleted;
            if (marks.ttsPreviewUsed !== undefined && marks.ttsPreviewReady < marks.dshTurnCompleted)
              sample.ttsPreparedBeforeTurnEndMs = marks.dshTurnCompleted - marks.ttsPreviewReady;
            try { Promise.resolve(this.onLatency(sample)).catch(() => {}); } catch {}
          }
        }
        this.lastTurnError = null;
        return { delivered: true };
      } finally {
        if (!signal.aborted && gen === this.generation) indicate(this.linked && !this.awake ? 'standby' : 'listening');
        turnAbort.abort();
        (discardPreview ?? prepared?.discard())?.catch(() => {});
      }
    }).catch(async error => {
      const code = error.code ?? 'turn-failed';
      if (gen !== this.generation || signal.aborted) return { failed: code };
      if (turn.hushed) return { interrupted: true };
      this.stage('turn-failed', { source: faultSource, code });
      // One bad turn is not a reason to hang up. Leave only when the audio path
      // itself cannot be returned to a clean listening state.
      let usable = lease.status ? lease.status().phase === 'active' : true;
      if (usable && faultSource === 'playback') {
        try { await deadline(Promise.resolve(lease.interrupt?.()), this.timeoutMs); }
        catch { usable = false; }
      }
      if (!usable || gen !== this.generation || signal.aborted) {
        if (gen === this.generation && !signal.aborted) {
          this.lastError = code;
          try { lease.reportFault?.(faultSource, error); } catch {}
          await this.stop('turn-failed');
        }
        return { failed: code };
      }
      this.lastTurnError = code;
      try { await deadline(Promise.resolve(lease.notice?.('turn-failed', { signal })), this.timeoutMs); } catch {}
      return { failed: code, recovered: true };
    }).finally(() => {
      if (this.turn === turn) { this.turn = null; this.turnEndedAt = performance.now(); }
      if (gen === this.generation) this.pending--;
    });
    entry.run = run; this.waiting = entry;
    this.queue = run.then(() => undefined);
    return run;
  }
  stop(reason = 'user-stop') {
    if (this.stopping) return this.stopping;
    if (this.state === this.idleState) return Promise.resolve(this.status());
    this.state = 'releasing'; ++this.generation; this.pending = 0; this.turn = null;
    this.linked = false; this.awake = true;
    clearTimeout(this.idleTimer); this.idleTimer = null;
    this.abort?.abort(new BridgeError('stopped', reason));
    this.stopping = this.release().finally(() => { this.stopping = null; }).then(result => {
      this.onReleased?.(result);
      return result;
    });
    return this.stopping;
  }
  async release() {
    try {
      // A cancelled connect must settle before we can claim ownership was returned.
      await deadline(this.acquisition?.catch(() => {}), this.timeoutMs);
      if (this.lease) {
        let interruptError;
        try { await deadline(this.lease.interrupt(), this.timeoutMs); }
        catch (error) { interruptError = error; }
        // Still try to return ownership when playback interruption fails.
        const result = await deadline(this.lease.release({ target: this.exitTarget }), this.timeoutMs);
        if (this.exitTarget === 'original' && result?.originalReady !== true)
          throw new BridgeError('restore-unconfirmed', 'Original assistant has not acknowledged recovery');
        if (this.exitTarget === 'device-idle' && result?.deviceIdle !== true)
          throw new BridgeError('idle-unconfirmed', 'Device has not acknowledged stopped resources');
        if (interruptError) throw interruptError;
      }
      this.lease = null; this.binding = null; this.acquisition = null;
      this.state = this.idleState;
    } catch (error) {
      this.lastError = error.code ?? 'release-failed'; this.state = 'recovering';
    }
    return this.status();
  }
}
