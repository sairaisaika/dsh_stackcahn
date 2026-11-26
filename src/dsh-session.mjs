import { randomUUID } from 'node:crypto';
import { BridgeError } from './bridge.mjs';

const maximumPreviewLength = 96;
function hasPendingInput(inbox) {
  return !!inbox?.['next-turn']?.length ||
    inbox?.['next-step']?.some(message => message?.source?.kind === 'user') === true;
}

async function waitForInputSlot(controller, sessionId, signal, blockedInboxCursor) {
  if (typeof controller.observeState !== 'function') {
    throw new BridgeError('dsh-api-unavailable', 'Missing sessionController.observeState');
  }
  for await (const state of controller.observeState({ sessionId }, signal)) {
    signal.throwIfAborted();
    if (!state.running && !state.queue?.some(item => item.placement !== 'context') &&
        (blockedInboxCursor === undefined || state.cursor > blockedInboxCursor)) return;
  }
  signal.throwIfAborted();
  throw new BridgeError('dsh-disconnected', 'DSH state stream ended while waiting for the selected session');
}

function speechPrefix(text) {
  const boundary = /[。！？!?][”’」』"']*|\.(?=\s)/u.exec(text.slice(0, maximumPreviewLength));
  return boundary ? text.slice(0, boundary.index + boundary[0].length) : '';
}

/** Binds through the sequenced DSH 0.2.2-rc.3 Session Controller surface. */
export function createDshSessionAdapter({ controller, getAgent = () => undefined }) {
  for (const method of ['projections', 'follow', 'prompt']) {
    if (typeof controller?.[method] !== 'function') throw new BridgeError('dsh-api-unavailable', `Missing sessionController.${method}`);
  }
  return {
    async bind(sessionId, { signal }) {
      signal.throwIfAborted();
      const snapshot = await controller.projections({ sessionId }, signal);
      if (!snapshot) throw new BridgeError('session-not-found', 'The selected DSH session does not exist');
      if (snapshot.kind !== 'sequenced') throw new BridgeError('session-migration-required', 'Open the selected session in DSH before connecting');
      signal.throwIfAborted();
      return {
        sessionId,
        // Only return references. Never copy a persona, memory store or transcript.
        workspace: snapshot.values?.workingDirectory ?? null,
        preset: snapshot.values?.agentPreset ?? null,
        /**
         * Follows the session and hands over the final public reply of every turn
         * that voice itself did not start (desktop, Telegram, scheduled tasks...).
         * Resolves when the stream ends or the signal aborts; never prompts or cancels.
         */
        async watch({ onReply, signal: watchSignal }) {
          watchSignal.throwIfAborted();
          const iterator = controller.follow({ address: { kind: 'session', sessionId }, maxMessages: 1 }, watchSignal)[Symbol.asyncIterator]();
          try {
            const opening = await iterator.next();
            if (opening.done || opening.value.type !== 'snapshot') return;
            let turn = null, voiceTurn = false, reply = '';
            for (;;) {
              const next = await iterator.next();
              if (next.done || watchSignal.aborted) return;
              const frame = next.value;
              if (frame.type !== 'event') continue;
              const event = frame.event;
              if (event.type === 'turn/start') { turn = event.data.turn; voiceTurn = false; reply = ''; }
              else if (event.type === 'user/message' && String(event.data.source?.rpcId ?? '').startsWith('stackchan-')) voiceTurn = true;
              else if (event.type === 'assistant/message' && event.data.turn === turn) {
                const content = event.data.message?.content ?? [];
                const publicReply = !event.data.interrupted && !content.some(block => block.type === 'tool-call');
                reply = publicReply ? content.filter(block => block.type === 'text').map(block => block.text).join('') : '';
              } else if (event.type === 'turn/end' && event.data.turn === turn) {
                const reason = event.data.reason?.kind ?? event.data.reason;
                if (!voiceTurn && reason === 'completed' && reply.trim()) {
                  try { await onReply(reply); } catch {}
                }
                turn = null; voiceTurn = false; reply = '';
              }
            }
          } finally { await iterator.return?.(); }
        },
        async ask(text, { signal: turnSignal, mark, onSpeechPreview, onProgress }) {
          turnSignal.throwIfAborted();
          const abort = new AbortController();
          const readSignal = AbortSignal.any([turnSignal, abort.signal]);
          const request = { address: { kind: 'session', sessionId }, maxMessages: 50,
            ...(onSpeechPreview || onProgress ? { assistantStream: true } : {}) };
          const requestId = `stackchan-${randomUUID()}`;
          const running = () => getAgent(sessionId)?.status === 'running';
          let iterator, first;
          try {
            for (;;) {
              readSignal.throwIfAborted();
              if (running()) await waitForInputSlot(controller, sessionId, readSignal);
              readSignal.throwIfAborted();
              // Keep the same follow once it can admit the prompt, including fast replies.
              iterator = controller.follow(request, readSignal)[Symbol.asyncIterator]();
              const opening = await iterator.next();
              if (opening.done || opening.value.type !== 'snapshot' || opening.value.header?.id !== sessionId) {
                throw new BridgeError('dsh-protocol', 'Expected a snapshot of the selected session');
              }
              first = opening.value;
              const inboxPending = hasPendingInput(first.projections?.values?.inbox);
              if (!inboxPending && !running()) break;
              await iterator.return?.();
              iterator = undefined;
              await waitForInputSlot(controller, sessionId, readSignal, inboxPending ? first.cursor : undefined);
            }
            readSignal.throwIfAborted();
            mark?.('dshPromptSubmitted');
            let onAbort;
            try {
              // Detach voice without waiting for Host admission or cancelling its task.
              await new Promise((resolve, reject) => {
                onAbort = () => reject(readSignal.reason);
                readSignal.addEventListener('abort', onAbort, { once: true });
                readSignal.throwIfAborted();
                Promise.resolve(controller.prompt({ sessionId, requestId, mode: 'queue', content: [{ type: 'text', text }] }, readSignal))
                  .then(resolve, reject);
              });
            } finally { readSignal.removeEventListener('abort', onAbort); }
            let turn = null; let ownedTurn = null; let textResult = ''; let finalMessage;
            let admittedSeq; let activeAttempt; let preview;
            let otherInput = false; let expectedSeq = first.cursor + 1;
            // Live progress of the owned turn for the device face: thinking,
            // tool calls and reply text as they stream. Display only.
            let progressAttempt = null;
            const progress = update => { try { onProgress?.(update); } catch {} };
            const discardPreview = () => {
              if (!preview || preview.discarded) return;
              preview.discarded = true;
              onSpeechPreview(null);
            };
            for (;;) {
              const next = await iterator.next();
              readSignal.throwIfAborted();
              if (next.done) throw new BridgeError('dsh-disconnected', 'DSH follow stream ended before the reply');
              const frame = next.value;
              if ((onSpeechPreview || onProgress) && frame.type === 'assistant-stream') {
                const live = frame.frame;
                if (onProgress) {
                  if (live.type === 'start') {
                    progressAttempt = ownedTurn !== null && live.turn === ownedTurn ? { id: live.attemptId, thinking: '', text: '' } : null;
                  } else if (progressAttempt && live.attemptId === progressAttempt.id && live.type === 'chunk') {
                    const chunk = live.chunk ?? {};
                    const piece = typeof chunk.text === 'string' ? chunk.text : typeof chunk.delta === 'string' ? chunk.delta : '';
                    if (/reason|think/i.test(chunk.type ?? '') && piece) {
                      progressAttempt.thinking = (progressAttempt.thinking + piece).slice(-400);
                      progress({ kind: 'thinking', text: progressAttempt.thinking });
                    } else if (chunk.type === 'tool-call-delta') {
                      const name = chunk.toolName ?? chunk.name;
                      if (typeof name === 'string' && name) progress({ kind: 'tool', name });
                    } else if (chunk.type === 'text-delta' && piece) {
                      progressAttempt.text = (progressAttempt.text + piece).slice(0, 2000);
                      progress({ kind: 'text', text: progressAttempt.text });
                    }
                  } else if (progressAttempt && live.attemptId === progressAttempt.id && live.type === 'end') progressAttempt = null;
                }
                if (!onSpeechPreview) continue;
                if (live.type === 'start') {
                  activeAttempt = !preview && ownedTurn !== null && live.turn === ownedTurn && live.startedAfterSeq >= admittedSeq
                    ? { id: live.attemptId, step: live.step, index: 0, text: '' } : null;
                } else if (activeAttempt && live.attemptId === activeAttempt.id) {
                  if (live.index !== activeAttempt.index) {
                    discardPreview();
                    activeAttempt = null;
                  } else if (live.type === 'end') {
                    if (preview?.attempt === activeAttempt) {
                      if (live.outcome.kind === 'committed' && live.outcome.eventType === 'assistant/message') preview.seq = live.outcome.seq;
                      else discardPreview();
                    }
                    activeAttempt = null;
                  } else if (live.type === 'chunk') {
                    activeAttempt.index++;
                    if (live.chunk.type === 'tool-call-delta') {
                      discardPreview();
                      activeAttempt = null;
                    }
                    if (activeAttempt && !preview && live.chunk.type === 'text-delta' && typeof live.chunk.text === 'string') {
                      activeAttempt.text += live.chunk.text.slice(0, maximumPreviewLength - activeAttempt.text.length);
                      const prefix = speechPrefix(activeAttempt.text);
                      if (prefix && prefix.trim().length > 1) {
                        preview = { attempt: activeAttempt, prefix };
                        onSpeechPreview(prefix);
                      }
                    }
                  }
                }
                continue;
              }
              if (frame.type !== 'event') throw new BridgeError('dsh-protocol', 'Unexpected DSH follow frame');
              const event = frame.event;
              if (event.seq !== expectedSeq++) throw new BridgeError('dsh-protocol', 'DSH event sequence gap');
              if (event.type === 'turn/start') { turn = event.data.turn; otherInput = false; }
              if (event.type === 'user/message' && event.data.source?.kind === 'user') {
                if (event.data.source.rpcId === requestId) {
                  if (turn === null || otherInput) throw new BridgeError('session-concurrent-input', 'Another client shares this turn; voice output is withheld');
                  ownedTurn = turn;
                  admittedSeq = event.seq;
                } else {
                  otherInput = true;
                  if (ownedTurn === turn) throw new BridgeError('session-concurrent-input', 'Another client changed this turn; voice output is withheld');
                }
              }
              if (ownedTurn !== null && event.type === 'assistant/message' && event.data.turn === ownedTurn) {
                const content = event.data.message.content ?? [];
                const publicReply = !event.data.interrupted && !content.some(block => block.type === 'tool-call');
                if (!publicReply && activeAttempt?.step === event.data.step) discardPreview();
                for (const block of content) if (block.type === 'tool-call') { const name = block.toolName ?? block.name; if (typeof name === 'string' && name) progress({ kind: 'tool', name }); }
                textResult = publicReply ? content.filter(block => block.type === 'text').map(block => block.text).join('') : '';
                finalMessage = publicReply ? { seq: event.seq, step: event.data.step } : undefined;
                if (textResult.trim()) mark?.('dshPublicText');
              }
              if (event.type === 'turn/end') {
                if (ownedTurn === event.data.turn) {
                  const reason = event.data.reason?.kind ?? event.data.reason;
                  if (reason !== 'completed') throw new BridgeError('dsh-turn-incomplete', `DSH turn ended: ${reason}`);
                  mark?.('dshTurnCompleted');
                  if (preview && (!finalMessage || finalMessage.seq !== preview.seq || finalMessage.step !== preview.attempt.step || speechPrefix(textResult) !== preview.prefix)) {
                    discardPreview();
                  }
                  return textResult;
                }
                turn = null;
              }
            }
          } finally {
            // Detach voice only. Do not cancel the user's desktop Agent or discard its inbox.
            abort.abort();
            await iterator?.return?.();
          }
        },
      };
    },
  };
}
