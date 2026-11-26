import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { LocalAudioFrontend } from './local-audio.mjs';
import { WhisperBackend, KokoroBackend } from './local-speech.mjs';
import { independentVoiceCapabilities } from './bridge.mjs';
import { speakable } from './speech-text.mjs';

const fault = code => Object.assign(new Error(code), { code });
const validPcm = pcm => Buffer.isBuffer(pcm) && pcm.length > 0 && pcm.length % 2 === 0 && pcm.length <= 24000;
const synthesisStartupMs = 25000;
// Operational cues only. Persona and replies stay with the bound DSH session.
const notices = Object.freeze({
  'turn-failed': { zh: '这一轮没有成功，请再说一次。', en: 'That did not go through. Please say it again.' },
  // Spoken when the wake phrase arrives with nothing after it, like the factory chime.
  wake: { zh: '我在。', en: 'I am here.' },
});

// Voice-activity probability above which a frame counts as someone talking.
const speechProbability = 0.5;
function* speechSections(text, limit) {
  let offset = 0;
  while (text.length - offset > limit) {
    const window = text.slice(offset, offset + limit);
    let end = window.length;
    // Keep sentence endings when possible, otherwise break between words.
    const latterHalf = window.slice(Math.floor(limit / 2));
    const boundary = [...latterHalf.matchAll(/[。！？!?；;\n]|\.(?=\s)/gu)].at(-1)
      ?? [...latterHalf.matchAll(/\s/gu)].at(-1);
    if (boundary) end = Math.floor(limit / 2) + boundary.index + boundary[0].length;
    else if (/[\uD800-\uDBFF]$/.test(window)) end--;
    yield text.slice(offset, offset + end);
    offset += end;
  }
  if (offset < text.length) yield text.slice(offset);
}

/** Passive composition. Caller owns authenticated listener/profile and explicitly
 * selects its connection. No device discovery, model download or session policy. */
export function createLocalVoice({ getConnection, audio, recognition, synthesis,
  language = 'auto', voice, speechRate = 1, maxQueuedSegments = 2,
  measureLatency = false, captionOnly = false, transcriptFilter = text => text, keepSynthesisWarm = () => false, onActiveFault, voiceDiagnostics, speaker,
  factories = {} } = {}) {
  if (typeof getConnection !== 'function' || !['auto', 'zh', 'en'].includes(language) ||
      !Number.isFinite(speechRate) || speechRate < 0.5 || speechRate > 2 ||
      !Number.isInteger(maxQueuedSegments) || maxQueuedSegments < 1 || maxQueuedSegments > 4)
    throw fault('voice-config-invalid');
  let owner = null, lastFailure = null, standbySpeech = null;
  const make = {
    audio: () => new LocalAudioFrontend(audio),
    recognition: () => new WhisperBackend(recognition),
    synthesis: () => new KokoroBackend(synthesis), ...factories,
  };
  function warmSynthesis(speech) {
    speech.failed = false;
    const signal = AbortSignal.any([speech.abort.signal, AbortSignal.timeout(synthesisStartupMs)]);
    speech.ready = Promise.resolve().then(() => {
      signal.throwIfAborted();
      return speech.worker.warmup?.({ signal });
    });
    speech.ready.catch(() => { speech.failed = true; });
  }

  function startSynthesis() {
    const speech = { worker: make.synthesis(), abort: new AbortController() };
    warmSynthesis(speech);
    return speech;
  }

  async function closeSynthesis(speech) {
    if (!speech) return;
    speech.abort.abort();
    try { await speech.worker.dispose(); }
    finally { await speech.ready.catch(() => {}); }
  }

  function cancelPrewarm() {
    const speech = standbySpeech;
    if (speech) {
      speech.closing ??= closeSynthesis(speech).finally(() => { standbySpeech = null; });
      return speech.closing;
    }
  }

  // Raw microphone taps (sound recording). Each receives the device PCM
  // exactly as it arrived, before echo cancellation or recognition.
  const inputTaps = new Set();
  return {
    tapInput(callback) { inputTaps.add(callback); return () => inputTaps.delete(callback); },
    mode: 'local-independent',
    prewarmSynthesis() {
      if (!captionOnly && !owner && !standbySpeech) standbySpeech = startSynthesis();
    },
    cancelPrewarm,
    capabilities: Object.freeze(Object.fromEntries(independentVoiceCapabilities.map(k => [k, true]))),
    status() { return owner?.status() ?? { phase: 'idle', queuedSegments: 0, failure: lastFailure }; },
    canReconnect() { return owner?.disconnectedAndClean() === true; },
    retireDisconnected() {
      if (!owner?.disconnectedAndClean()) return false;
      owner = null;
      return true;
    },
    async acquire({ signal, exitTarget, onTranscript, onDisconnect, onAttention, onGesture }) {
      signal?.throwIfAborted();
      if (owner || standbySpeech?.closing) throw fault('voice-busy');
      if (exitTarget !== 'device-idle' || typeof onTranscript !== 'function' || typeof onDisconnect !== 'function')
        throw fault('voice-contract-invalid');
      const connection = getConnection();
      if (connection?.snapshot().phase !== 'idle') throw fault('voice-device-not-ready');
      if (captionOnly && !connection.captionRequested) throw fault('voice_caption_required');
      if (!captionOnly && !connection.playbackSupported) throw fault('voice-playback-unsupported');
      lastFailure = null;
      const lifetime = new AbortController();
      const id = randomUUID();
      const queue = [];
      let phase = 'reserved', activated, releasing, inputTask, asrTask, playing, preparedSpeech, immediate;
      let speech = standbySpeech;
      standbySpeech = null;
      let frontend, asr, failure, utterance = 0;
      let synthesisReady, synthesisStartupError;
      let lastDeviceIdle = null, localCleanupComplete = false;
      let activeSince, firstInputReceived = false, faultReported = false;
      let inputGeneration = 0;
      const currentInput = generation => generation === (connection.inputGeneration ?? 0);
      const running = () => phase === 'active' && !lifetime.signal.aborted;
      // Match the Kokoro worker's default so splitting a reply does not change its voice.
      const speechLanguage = text => language === 'auto' ? (/[\u3400-\u9fff]/u.test(text) ? 'zh' : 'en') : language;
      function reportFault(source, error) {
        if (!running() || faultReported || !onActiveFault) return;
        faultReported = true;
        const sample = { source, code: error?.code, protocolCode: error?.protocolCode,
          firstInputReceived, activeMs: performance.now() - activeSince };
        try { Promise.resolve(onActiveFault(sample)).catch(() => {}); } catch {}
      }
      const notify = (error, source) => {
        if (phase === 'releasing' || phase === 'released' || failure) return;
        failure = lastFailure = error?.code ?? 'voice-failed';
        reportFault(source, error);
        // Never await the consumer: it may release this lease and join our task.
        try { Promise.resolve(onDisconnect({ code: failure })).catch(() => {}); } catch {}
        void lease.release().catch(() => {});
      };
      const dispatch = event => {
        try { Promise.resolve(onTranscript(event)).catch(error => notify(error, 'session')); }
        catch (error) { notify(error, 'session'); }
      };
      function recognize() {
        if (asrTask || !running() || !queue.length) return;
        asrTask = (async () => {
          while (running() && queue.length) {
            const { segment, segmentReadyAtMs, generation } = queue.shift();
            if (!currentInput(generation)) continue;
            // Whose voice, before what was said. An enrolment sample is not a turn.
            let voice;
            if (speaker) { try { voice = speaker(segment.pcm); } catch { voice = { owner: undefined }; } }
            if (voice?.enrolling) { voiceDiagnostics?.stage('owner-voice-sample'); continue; }
            const asrStartedAtMs = measureLatency ? performance.now() : undefined;
            voiceDiagnostics?.stage('recognition-requested');
            let result = await asr.transcribe(segment.pcm, {
              sampleRate: segment.sampleRate, language, signal: lifetime.signal,
            });
            // Short Chinese utterances are sometimes detected as another language
            // (v63: "Пляша"). Only Chinese and English are spoken here: try again as Chinese.
            if (language === 'auto' && result?.text?.trim() && typeof result.language === 'string' &&
                !['zh', 'en'].includes(result.language) && running() && currentInput(generation)) {
              voiceDiagnostics?.stage('recognition-language-retry', { detected: result.language });
              result = await asr.transcribe(segment.pcm, { sampleRate: segment.sampleRate, language: 'zh', signal: lifetime.signal });
            }
            const asrEndedAtMs = measureLatency ? performance.now() : undefined;
            if (!running()) return; // A late recognizer cannot revive a released lease.
            if (!currentInput(generation)) continue;
            if (typeof result?.text !== 'string') throw fault('voice-transcript-invalid');
            result = { ...result, text: transcriptFilter(result.text) };
            voiceDiagnostics?.stage('recognition-returned', { outcome: result.text.trim() ? 'utterance' : 'empty' });
            if (result.text.trim()) dispatch({ id: `${id}:${utterance++}`, text: result.text, final: true,
              // A 20 s slice is not a whole command; neither is its continuation.
              commandEligible: segment.reason === 'silence' && !segment.continuation,
              ...(voice ? { owner: voice.owner } : {}),
              ...(measureLatency ? { timing: { segmentReadyAtMs, asrStartedAtMs, asrEndedAtMs } } : {}),
            });
          }
        })().catch(error => notify(error, 'recognition')).finally(() => { asrTask = null; recognize(); });
      }
      let lastSpeechAtMs = 0;
      // Device-originated requests reach the bridge only while this lease is live.
      connection.onAttention = intent => { if (running()) try { onAttention?.(intent); } catch {} };
      connection.onHeadTouchGesture = gesture => { if (running()) try { onGesture?.(gesture); } catch {} };
      async function capture() {
        const signal = lifetime.signal;
        const batchSize = typeof frontend.processBatch === 'function' ? 4 : 1;
        while (running()) {
          let batch;
          try {
            batch = connection.readInputBatch
              ? await connection.readInputBatch({ signal, limit: batchSize })
              : { frames: [await connection.readInput({ signal })], generation: 0 };
          }
          catch (error) { notify(error, 'transport'); return; }
          if (!running()) return;
          firstInputReceived = true;
          const { frames, generation } = batch;
          for (const tap of inputTaps) for (const frame of frames) { try { tap(frame.pcm); } catch {} }
          if (!currentInput(generation)) continue;
          if (generation !== inputGeneration) {
            queue.length = 0;
            voiceDiagnostics?.stage('frontend-reset-started');
            await frontend.reset({ signal });
            voiceDiagnostics?.stage('frontend-reset-complete');
            inputGeneration = generation;
            if (!running() || !currentInput(generation)) continue;
          }
          const startedAt = voiceDiagnostics && performance.now();
          voiceDiagnostics?.frontendStart(frames.length);
          let results;
          try {
            results = frames.length === 1 ? [await frontend.process(frames[0].pcm, { signal })]
              : await frontend.processBatch(frames.map(frame => frame.pcm), { signal });
          } finally {
            voiceDiagnostics?.frontendDone(frames.length, performance.now() - startedAt);
          }
          if (!running() || !currentInput(generation)) continue;
          for (const { segment, probability } of results) {
            if (typeof probability === 'number' && probability >= speechProbability) lastSpeechAtMs = performance.now();
            if (!segment) continue;
            // Recognition briefly behind: keep the newest speech, not the link.
            if (queue.length >= maxQueuedSegments) {
              queue.shift();
              voiceDiagnostics?.stage('recognition-segment-dropped');
            }
            queue.push({ segment, generation, segmentReadyAtMs: measureLatency ? performance.now() : undefined });
            recognize();
          }
        }
      }
      async function* synthesize(text, options) {
        const { signal } = options;
        signal.throwIfAborted();
        if (synthesisReady) {
          let abort;
          try {
            const cancelled = new Promise((_, reject) => {
              abort = () => reject(signal.reason);
              signal.addEventListener('abort', abort, { once: true });
            });
            await Promise.race([synthesisReady, cancelled]);
          } finally {
            signal.removeEventListener('abort', abort);
          }
        }
        signal.throwIfAborted();
        if (synthesisStartupError) throw synthesisStartupError;
        // Markup, code and links are captioned but never read aloud.
        const spoken = speakable(text, options?.language);
        if (!spoken) return;
        yield* speech.worker.synthesize(spoken, options);
      }
      async function* speechChunks(text, prepared, signal, mark) {
        const abort = () => { void prepared.discard(); };
        const replyLanguage = speechLanguage(text);
        const sectionLimit = replyLanguage === 'zh' ? 120 : 240;
        let selectedLanguage = language;
        if (prepared) {
          signal.addEventListener('abort', abort, { once: true });
          try {
            signal.throwIfAborted();
            const first = text.startsWith(prepared.text) && replyLanguage === prepared.language ? await prepared.first : null;
            signal.throwIfAborted();
            if (first) {
              mark?.('ttsPreviewUsed');
              yield first;
              yield* prepared.iterator;
              selectedLanguage = prepared.language;
              text = text.slice(prepared.text.length);
            }
          } finally {
            signal.removeEventListener('abort', abort);
            await prepared.discard({ keepWorker: !signal.aborted });
          }
        }
        if (text.length > sectionLimit) selectedLanguage = replyLanguage;
        for (const section of speechSections(text, sectionLimit)) {
          signal.throwIfAborted();
          if (section.trim()) yield* synthesize(section, { language: selectedLanguage, voice, speechRate, signal });
        }
      }
      const abort = () => { void lease.release().catch(() => {}); };
      const disconnected = error => notify(error, 'transport');
      const lease = {
        captionOnly,
        // 2: the device stays linked while waiting; the bridge gates on the wake phrase.
        standbyMode: connection.standbyMode === 2 ? 2 : 0,
        /** performance.now() of the latest frame that sounded like speech, 0 before any. */
        lastSpeechAtMs: () => lastSpeechAtMs,
        reportFault,
        status() { return { phase, queuedSegments: queue.length, failure: failure ?? null }; },
        disconnectedAndClean() {
          return phase === 'fault' && localCleanupComplete && connection.snapshot().phase === 'closed';
        },
        get captionStatus() { return connection.captionStatus === true; },
        caption(speaker, text) {
          return running() && connection.sendCaption?.(speaker, text, { required: captionOnly && speaker !== 'status' });
        },
        indicate(state) {
          if (running()) connection.setVoiceIndicator?.(state);
        },
        async notice(kind, { signal: noticeSignal } = {}) {
          const text = notices[kind]?.[language === 'en' ? 'en' : 'zh'];
          if (!text || !running()) return false;
          try { connection.sendCaption?.('assistant', text, { required: false }); } catch {}
          if (captionOnly || playing) return true;
          // A cue that cannot be spoken is dropped. It never becomes a new fault.
          try { await lease.speak(text, { signal: noticeSignal }); } catch { return false; }
          return true;
        },
        activate() {
          if (activated || phase !== 'reserved') return Promise.reject(fault('voice-already-activated'));
          phase = 'starting';
          activated = (async () => {
            let activationStage = 'local-audio';
            try {
              lifetime.signal.throwIfAborted();
              // Retain each owner before the next constructor/operation may fail.
              frontend = make.audio(); asr = make.recognition();
              if (!captionOnly) {
                if (!speech) speech = startSynthesis();
                else if (speech.failed) warmSynthesis(speech);
                // The first lease can adopt the ready or still-loading worker.
                synthesisReady = speech.ready;
                synthesisReady.then(() => { synthesisReady = undefined; }, error => {
                  synthesisStartupError = error;
                  if (running()) notify(error, 'synthesis');
                });
              }
              const options = { signal: lifetime.signal };
              voiceDiagnostics?.stage('local-input-preparing');
              await Promise.all([frontend.start(options), asr.warmup?.(options)]);
              voiceDiagnostics?.stage('local-input-ready');
              lifetime.signal.throwIfAborted();
              if (synthesisStartupError) throw synthesisStartupError;
              activationStage = 'device-audio';
              voiceDiagnostics?.stage('device-start-requested');
              await connection.start(options);
              lifetime.signal.throwIfAborted();
              activationStage = 'local-audio';
              if (synthesisStartupError) throw synthesisStartupError;
            } catch (error) {
              voiceDiagnostics?.stage('activation-failed', { stage: activationStage });
              if (failure && connection.snapshot().phase === 'closed') activationStage = 'device-link';
              else if (lifetime.signal.aborted) throw error;
              throw Object.assign(new Error('Voice audio startup failed', { cause: error }), { code: error?.code, activationStage });
            }
            activeSince = performance.now();
            phase = 'active';
            // A linked-standby device starts out waiting, not listening.
            try { lease.indicate(lease.standbyMode === 2 ? 'standby' : 'listening'); } catch {}
            // Bridge must complete enter() before receiving any transcript.
            immediate = setImmediate(() => {
              immediate = null;
              if (running()) inputTask = capture().catch(error => notify(error, 'audio-input'));
            });
          })();
          return activated;
        },
        prepareSpeech(text, { signal, mark }) {
          if (captionOnly || !running() || playing || preparedSpeech || signal.aborted) return;
          const controller = new AbortController();
          const combined = AbortSignal.any([lifetime.signal, controller.signal, signal]);
          const selectedLanguage = speechLanguage(text);
          // Read ahead by at most one validated chunk. Nothing touches the device here.
          const iterator = synthesize(text, { language: selectedLanguage, voice, speechRate, signal: combined });
          const first = iterator.next().then(({ done, value }) => {
            if (done || !validPcm(value) || combined.aborted) return null;
            mark?.('ttsPreviewReady');
            return value;
          }).catch(() => null);
          const prepared = { text, iterator, first, language: selectedLanguage };
          let disposal;
          prepared.discard = ({ keepWorker = false } = {}) => {
            // A preview still waiting on shared warmup has not used the model.
            if (!keepWorker || synthesisReady) controller.abort();
            return disposal ??= (async () => {
              const ready = await first;
              try {
                // A replacement may keep the initialized worker. Discard its remaining output
                // one chunk at a time, with no device writes or extra PCM buffer.
                if (ready && keepWorker && !combined.aborted) {
                  while (!(await iterator.next()).done) combined.throwIfAborted();
                }
              } catch {} finally {
                try { await iterator.return?.(); } catch {}
                if (preparedSpeech === prepared) preparedSpeech = null;
              }
            })();
          };
          preparedSpeech = prepared;
          return prepared;
        },
        speak(text, { signal: turnSignal, mark, prepared, onProgress, pcm } = {}) {
          if (!running()) return Promise.reject(fault('voice-not-active'));
          if (captionOnly) return Promise.reject(fault('voice-playback-disabled'));
          if (playing) return Promise.reject(fault('voice-playback-busy'));
          const controller = new AbortController();
          const combined = AbortSignal.any([lifetime.signal, controller.signal, ...(turnSignal ? [turnSignal] : [])]);
          const operation = { controller, draining: false };
          playing = operation;
          operation.promise = (async () => {
            let tail = Buffer.alloc(0);
            const pending = [];
            let firstPcm = true;
            let firstFrame = true;
            const send = async frame => {
              combined.throwIfAborted();
              const measure = mark && firstFrame;
              firstFrame = false;
              if (measure) mark('outputSubmitted');
              let accepted = connection.sendOutput(frame);
              if (measure || onProgress) accepted = accepted.then(() => {
                if (measure) mark('outputAcknowledged');
                onProgress?.();
              });
              accepted.catch(() => {}); // May fail before its window slot is awaited.
              pending.push(accepted);
              if (pending.length >= 8) await pending.shift();
            };
            const matching = prepared && prepared === preparedSpeech ? prepared : undefined;
            // A sound plays its own PCM through the same window and fences as speech.
            for await (const chunk of pcm ? [pcm] : speechChunks(text, matching, combined, mark)) {
              combined.throwIfAborted();
              if (!validPcm(chunk)) throw fault('voice-playback-pcm-invalid');
              if (mark && firstPcm) mark('ttsFirstPcm');
              firstPcm = false;
              const pcm = Buffer.concat([tail, chunk]);
              let offset = 0;
              for (; offset + 480 <= pcm.length; offset += 480) await send(pcm.subarray(offset, offset + 480));
              tail = Buffer.from(pcm.subarray(offset));
            }
            if (tail.length) { const frame = Buffer.alloc(480); tail.copy(frame); await send(frame); }
            await Promise.all(pending);
            combined.throwIfAborted();
            operation.draining = true;
            // Abort of a transport fence closes the socket. Full Stop below
            // supersedes it while preserving the resources_stopped receipt.
            await connection.drainOutput();
            combined.throwIfAborted();
          })().finally(() => { if (playing === operation) playing = null; });
          return operation.promise;
        },
        async interrupt() {
          // VoiceBridge aborts the entire lease before invoking interrupt.
          if (signal?.aborted || lifetime.signal.aborted || releasing) return lease.release();
          if (!running()) throw fault('voice-not-active');
          if (captionOnly) return;
          if (playing?.draining) throw fault('voice-playback-draining');
          const current = playing;
          current?.controller.abort();
          await connection.interruptOutput();
          await current?.promise.catch(() => {});
        },
        release({ target = 'device-idle' } = {}) {
          if (target !== 'device-idle') return Promise.reject(fault('voice-release-target'));
          if (releasing) return releasing;
          const idleSynthesis = speech && phase === 'active' && !failure && !playing && !preparedSpeech &&
            !synthesisReady && !speech.failed && keepSynthesisWarm();
          phase = 'releasing';
          lifetime.abort(); queue.length = 0; clearImmediate(immediate);
          releasing = (async () => {
            // Start local teardown now; do not wait behind inference or playback.
            const local = Promise.allSettled([
              ...[frontend, asr].map(worker => Promise.resolve().then(() => worker?.dispose())),
              idleSynthesis ? undefined : closeSynthesis(speech),
              Promise.resolve().then(() => preparedSpeech?.discard()),
            ]);
            await activated?.catch(() => {});
            let remoteError;
            try {
              const state = connection.snapshot().phase;
              if (state === 'active') lastDeviceIdle = await connection.stop();
              else if (state === 'idle') lastDeviceIdle = { deviceIdle: true };
              else throw fault('voice-idle-unconfirmed');
              if (lastDeviceIdle?.deviceIdle !== true) throw fault('voice-idle-unconfirmed');
            } catch (error) { remoteError = error; }
            const settled = await local;
            await Promise.allSettled([inputTask, asrTask, playing?.promise, synthesisReady]);
            connection.off('disconnect', disconnected);
            signal?.removeEventListener('abort', abort);
            let localError = settled.find(x => x.status === 'rejected');
            if (idleSynthesis) {
              // Recheck after Stop. The owner can revoke standby during release.
              if (!remoteError && !localError && keepSynthesisWarm()) {
                standbySpeech = speech;
                speech = null;
              } else {
                try { await closeSynthesis(speech); }
                catch (reason) { localError ??= { reason }; }
              }
            }
            localCleanupComplete = !localError;
            if (remoteError || localError) {
              voiceDiagnostics?.stage('lease-released', { outcome: remoteError ? 'device-unconfirmed' : 'local-cleanup-failed' });
              phase = 'fault'; failure = remoteError?.code ?? localError?.reason?.code ?? 'voice-release-failed';
              throw remoteError ?? localError.reason;
            }
            phase = 'released';
            voiceDiagnostics?.stage('lease-released', { outcome: 'idle-confirmed' });
            if (owner === lease) owner = null;
            return lastDeviceIdle;
          })();
          // Cancellation is often initiated by an event before bridge awaits it.
          releasing.catch(() => {});
          return releasing;
        },
      };
      owner = lease;
      connection.on('disconnect', disconnected);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      return lease;
    },
    async dispose() {
      if (owner) await owner.release();
      else await cancelPrewarm();
    },
  };
}
