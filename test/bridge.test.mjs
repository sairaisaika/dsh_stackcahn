import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceBridge, requiredVoiceCapabilities, independentVoiceCapabilities, isStop, isHush, describeTouch, matchWake, createWakeMatcher } from '../src/bridge.mjs';
// A configured name with recognition variants, as a local config would list it.
const testWakeNames = ['[小晓曉肖有](d|dee|di|弟|迪|地|第|的|滴|帝|狄|蒂|笛|底|递|遞|低|嘀)'];
const testWake = createWakeMatcher(testWakeNames);
import { factoryMcpVoice } from '../src/factory-voice.mjs';
import { createDshSessionAdapter } from '../src/dsh-session.mjs';
const tick = () => new Promise(r => setImmediate(r));
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function fixture(overrides = {}) {
  const calls = []; const spoken = []; let handlers;
  const lease = { async speak(text) { spoken.push(text); }, async interrupt() { calls.push('interrupt'); }, async release() { calls.push('release'); return { originalReady: true }; }, ...overrides.lease };
  const voice = { mode: 'simulation', capabilities: Object.fromEntries(requiredVoiceCapabilities.map(k => [k, true])), async acquire(h) { handlers = h; calls.push('acquire'); return lease; }, ...overrides.voice };
  const dsh = { async bind(id) { calls.push(['bind', id]); return { async ask(text) { calls.push(['ask', text]); return `reply:${text}`; }, ...overrides.binding }; } };
  const bridge = new VoiceBridge({ voice, dsh, timeoutMs: 100, wakeNames: testWakeNames, ...overrides.options });
  const say = (text, id = text) => bridge.receive({ id, text, final: true });
  return { bridge, voice, dsh, lease, calls, spoken, say, handlers: () => handlers };
}
test('one connection keeps routing successive utterances to the selected binding', async () => {
  const f = fixture(); await f.bridge.enter('chosen-session');
  await f.say('one'); await f.say('two');
  assert.deepEqual(f.calls.filter(Array.isArray), [['bind','chosen-session'],['ask','one'],['ask','two']]);
  assert.deepEqual(f.spoken, ['reply:one','reply:two']);
  assert.equal(f.bridge.status().state, 'bridged'); await f.bridge.stop();
});
test('exact stop bypasses the model and returns only after original readiness acknowledgment', async () => {
  const f = fixture(); await f.bridge.enter('chosen');
  await f.say('停止！'); assert.equal(f.bridge.status().state, 'original');
  assert.deepEqual(f.calls, [['bind','chosen'],'acquire','interrupt','release']);
  assert.equal(isStop('不要停止'), false); assert.equal(isStop('如何停止？'), false);
  // 「待机」 sends a device in wake standby back to waiting, like the factory assistant.
  assert.equal(isStop('待机。'), true); assert.equal(isStop('去待机'), true); assert.equal(isStop('Standby'), true);
  assert.equal(isStop('待机多久了'), false); assert.equal(isStop('不要待机'), false);
});
test('stop interrupts a waiting reply and drops queued and late output', async () => {
  const reply = deferred(); const started = deferred();
  const captions=[], indicators=[];
  const f = fixture({ binding: { async ask() { started.resolve(); return reply.promise; } },
    lease: { caption(speaker,text){captions.push([speaker,text]);return true;}, indicate(state){indicators.push(state);} } });
  await f.bridge.enter('chosen'); const first = f.say('one'); await started.promise;
  const queued = f.say('two'); await f.say('停止');
  assert.equal(f.bridge.status().state, 'original'); reply.resolve('too late');
  await Promise.all([first,queued]); assert.deepEqual(f.spoken,[]);
  assert.deepEqual(captions,[['user','one']]);
  assert.deepEqual(indicators,['waiting']);
});
test('captions follow the accepted voice turn without changing the spoken response', async () => {
  const captions=[], indicators=[];
  const f=fixture({lease:{
    caption(speaker,text){captions.push([speaker,text]);return true;},
    indicate(state){indicators.push(state);},
    async speak(text){assert.equal(text,'reply:你好');assert.deepEqual(indicators,['waiting']);},
  }});
  await f.bridge.enter('chosen');
  await f.say('你好');
  assert.deepEqual(captions,[['user','你好'],['assistant','reply:你好']]);
  assert.deepEqual(indicators,['waiting','listening']);
  await f.bridge.stop();
});
test('stop during connection releases a late acquired lease before reporting original', async () => {
  const ready = deferred(); const started = deferred();
  const f = fixture({ voice: { async acquire() { started.resolve(); return ready.promise; } } });
  const entry = f.bridge.enter('chosen'); const failed = assert.rejects(entry);
  await started.promise; const stopped = f.bridge.stop();
  assert.equal(f.bridge.status().state,'releasing'); ready.resolve(f.lease);
  await stopped; await failed; assert.equal(f.bridge.status().state,'original');
  assert.equal(f.calls.filter(x => x === 'release').length,1);
});
test('failed release stays recovering and can be retried', async () => {
  let count = 0;
  const f = fixture({ lease: { async release() { if (!count++) throw new Error('offline'); return { originalReady: true }; } } });
  await f.bridge.enter('chosen'); await f.bridge.stop(); assert.equal(f.bridge.status().state,'recovering');
  await assert.rejects(f.bridge.enter('other'), { code: 'busy' });
  await f.bridge.stop(); assert.equal(f.bridge.status().state,'original');
});
test('unconfirmed restore never reports success', async () => {
  const f=fixture({lease:{async release(){ return {}; }}});await f.bridge.enter('chosen');await f.bridge.stop();
  assert.equal(f.bridge.status().state,'recovering');assert.equal(f.bridge.status().lastError,'restore-unconfirmed');
});
test('real factory MCP refuses continuous takeover before any session or audio mutation', async () => {
  const f=fixture();const bridge=new VoiceBridge({voice:factoryMcpVoice,dsh:f.dsh});
  await assert.rejects(bridge.enter('chosen'),{code:'unsupported-voice'});assert.deepEqual(f.calls,[]);
  assert.equal(bridge.status().state,'original');
});
test('duplicate and interim transcripts do not create extra turns', async () => {
  const f=fixture();await f.bridge.enter('chosen');
  await f.bridge.receive({id:'a',text:'partial',final:false});await f.say('one','a');await f.say('one','a');
  assert.deepEqual(f.spoken,['reply:one']);await f.bridge.stop();
});
test('old generation cannot route text after re-entry', async () => {
  const f=fixture();await f.bridge.enter('chosen');const old=f.handlers();await f.bridge.stop();await f.bridge.enter('chosen');
  await old.onTranscript({id:'old',text:'stale',final:true});assert.deepEqual(f.spoken,[]);await f.bridge.stop();
});
test('turn timeout detaches that turn, reports it and keeps the handoff for the next utterance', async () => {
  const notices=[];let hang=true;
  const f=fixture({binding:{async ask(text){if(hang)return new Promise(()=>{});return `reply:${text}`;}},options:{turnTimeoutMs:15},
    lease:{async notice(kind){notices.push(kind);}}});
  await f.bridge.enter('chosen');
  assert.deepEqual(await f.say('one'),{failed:'timeout',recovered:true});
  assert.equal(f.bridge.status().state,'bridged');assert.equal(f.bridge.status().lastTurnError,'timeout');
  assert.deepEqual(notices,['turn-failed']);assert.deepEqual(f.spoken,[]);
  hang=false;assert.deepEqual(await f.say('two'),{delivered:true});
  assert.deepEqual(f.spoken,['reply:two']);assert.equal(f.bridge.status().lastTurnError,null);
  await f.bridge.stop();assert.equal(f.bridge.status().state,'original');
});
test('a spoken hush dismisses the waiting reply without leaving the handoff', async () => {
  const reply=deferred();const started=deferred();
  const f=fixture({binding:{async ask(text,{signal}){
    if(text!=='one')return `reply:${text}`;
    started.resolve();
    return Promise.race([reply.promise,new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))]);
  }}});
  await f.bridge.enter('chosen');const first=f.say('one');await started.promise;
  assert.deepEqual(await f.say('别说了。','hush'),{interrupted:true});
  assert.deepEqual(await first,{interrupted:true});
  assert.equal(f.bridge.status().state,'bridged');assert.deepEqual(f.spoken,[]);
  assert.deepEqual(await f.say('two'),{delivered:true});assert.deepEqual(f.spoken,['reply:two']);
  assert.deepEqual(await f.say('安静','idle-hush'),{ignored:true});
  await f.bridge.stop();
});
test('device playback progress extends only the playback deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const stalls of [false, true]) {
    const start = deferred();
    const done = deferred();
    const f = fixture({
      options: { turnTimeoutMs: 25 },
      lease: { async speak(text, { onProgress }) { start.resolve(onProgress); await done.promise; } },
    });
    await f.bridge.enter('chosen');
    const turn = f.say('one');
    const progress = await start.promise;
    for (let section = 0; section < 3; section++) {
      t.mock.timers.tick(20);
      progress();
    }
    if (stalls) {
      t.mock.timers.tick(25);
      // Stalled playback is interrupted; the handoff survives it.
      assert.deepEqual(await turn, { failed: 'timeout', recovered: true });
      assert.ok(f.calls.includes('interrupt'));
      assert.equal(f.bridge.status().state, 'bridged');
      done.resolve();
      await f.bridge.stop();
    } else {
      done.resolve();
      assert.deepEqual(await turn, { delivered: true });
      assert.equal(f.bridge.status().state, 'bridged');
      await f.bridge.stop();
    }
  }
});
test('voice disconnect starts restoration', async () => {
  const f=fixture();await f.bridge.enter('chosen');f.handlers().onDisconnect();await tick();
  assert.equal(f.bridge.status().state,'original');
});
test('old disconnect callbacks cannot terminate a newer handoff', async () => {
  const f=fixture();await f.bridge.enter('chosen');const old=f.handlers();await f.bridge.stop();await f.bridge.enter('chosen');
  old.onDisconnect();await tick();assert.equal(f.bridge.status().state,'bridged');await f.bridge.stop();
});
test('a failed turn is recoverable while audio is usable and releases audio only when it is not', async () => {
  for (const source of ['session','playback']) {
    for (const usable of [true,false]) {
      const reported=[];const stages=[];
      const error=Object.assign(new Error('fixture failure'),{code:'fixture-code'});
      const f=fixture({lease:{
        reportFault(stage,reason){reported.push([stage,reason]);},
        status(){return {phase:usable?'active':'fault'};},
        async speak(){throw error;},
      },binding:source==='session'?{async ask(){throw error;}}:{},
        options:{onStage:(name,fields)=>{if(name==='turn-failed')stages.push(fields);}}});
      await f.bridge.enter('chosen');
      const result=await f.say('one');
      assert.deepEqual(stages,[{source,code:'fixture-code'}]);
      if(usable){
        assert.deepEqual(result,{failed:'fixture-code',recovered:true});
        assert.deepEqual(reported,[]);
        assert.equal(f.bridge.status().state,'bridged');
        assert.equal(f.calls.includes('interrupt'),source==='playback');
        await f.bridge.stop();
      }else{
        assert.deepEqual(result,{failed:'fixture-code'});
        assert.deepEqual(reported,[[source,error]]);
        assert.equal(f.bridge.status().state,'original');
      }
    }
  }
});
test('an uncooperative acquire timeout stays recovering until the late lease can be returned',async()=>{
  const acquired=deferred();const f=fixture({voice:{async acquire(){return acquired.promise;}},options:{timeoutMs:15}});
  await assert.rejects(f.bridge.enter('chosen'),{code:'timeout'});
  assert.equal(f.bridge.status().state,'recovering');acquired.resolve(f.lease);await tick();await f.bridge.stop();
  assert.equal(f.bridge.status().state,'original');
});
test('stop during playback interrupts before releasing the original assistant',async()=>{
  const started=deferred();const done=deferred();const events=[];
  const f=fixture({lease:{async speak(){events.push('speak');started.resolve();await done.promise;},async interrupt(){events.push('interrupt');done.resolve();},async release(){events.push('release');return{originalReady:true};}}});
  await f.bridge.enter('chosen');const pending=f.say('one');await started.promise;await f.say('停止');await pending;
  assert.deepEqual(events,['speak','interrupt','release']);assert.equal(f.bridge.status().state,'original');
});
test('playback interrupt failure still attempts to restore device ownership',async()=>{
  const f=fixture({lease:{async interrupt(){throw new Error('interrupt unavailable');}}});await f.bridge.enter('chosen');await f.bridge.stop();
  assert.ok(f.calls.includes('release'));assert.equal(f.bridge.status().state,'recovering');
});

function independent(overrides = {}) {
  return fixture({ ...overrides,
    options: { ...overrides.options, exitTarget: 'device-idle' },
    voice: { capabilities: Object.fromEntries(independentVoiceCapabilities.map(k => [k, true])), ...overrides.voice },
    lease: { async release({ target }) { assert.equal(target, 'device-idle'); return { deviceIdle: true }; }, ...overrides.lease },
  });
}
test('independent Agent routes continuously and stops to idle without claiming original readiness', async () => {
  const f = independent(); assert.equal(f.bridge.state, 'idle');
  await f.bridge.enter('chosen'); await f.say('one'); await f.say('two'); await f.say('停止');
  assert.equal(f.bridge.state, 'idle'); assert.equal(f.bridge.status().exitTarget, 'device-idle');
  assert.deepEqual(f.spoken, ['reply:one', 'reply:two']);
  await f.bridge.enter('chosen'); await f.say('three'); await f.bridge.stop();
  assert.deepEqual(f.spoken, ['reply:one', 'reply:two', 'reply:three']);
});
test('an original-ready receipt does not stand in for independent resource release', async () => {
  const f = independent({ lease: { async release() { return { originalReady: true }; } } });
  await f.bridge.enter('chosen'); await f.bridge.stop();
  assert.equal(f.bridge.state, 'recovering'); assert.equal(f.bridge.lastError, 'idle-unconfirmed');
  await assert.rejects(f.bridge.enter('other'), { code: 'busy' });
});
test('independent release failure is retryable and still blocks a new acquisition', async () => {
  let n = 0;
  const f = independent({ lease: { async release() { return { deviceIdle: ++n > 1 }; } } });
  await f.bridge.enter('chosen'); await f.bridge.stop(); assert.equal(f.bridge.state, 'recovering');
  await f.bridge.stop(); assert.equal(f.bridge.state, 'idle');
});
test('independent stop discards queued and late replies, and old callbacks after re-entry', async () => {
  const reply = deferred(); const started = deferred();
  const f = independent({ binding: { async ask() { started.resolve(); return reply.promise; } } });
  await f.bridge.enter('chosen'); const old = f.handlers(); const first = f.say('one'); await started.promise;
  const queued = f.say('two'); await f.say('停止'); await f.bridge.enter('chosen');
  reply.resolve('late'); await Promise.all([first, queued]);
  old.onDisconnect(); await old.onTranscript({ id: 'old', text: 'stale', final: true });
  assert.equal(f.bridge.state, 'bridged'); assert.deepEqual(f.spoken, []); await f.bridge.stop();
});
test('independent profile requires an idle-capable adapter before binding', async () => {
  const f = fixture({ options: { exitTarget: 'device-idle' } });
  await assert.rejects(f.bridge.enter('chosen'), { code: 'unsupported-voice' }); assert.deepEqual(f.calls, []);
});
test('independent stop during acquisition releases the late lease to idle', async () => {
  const ready = deferred(); const started = deferred();
  const f = independent({ voice: { async acquire(h) { assert.equal(h.exitTarget, 'device-idle'); started.resolve(); return ready.promise; } } });
  const entry = f.bridge.enter('chosen'); const rejected = assert.rejects(entry);
  await started.promise; const stopped = f.bridge.stop(); ready.resolve(f.lease);
  await stopped; await rejected; assert.equal(f.bridge.state, 'idle');
});

// Host admission and follow deliberately ignore abort: accepted desktop work can
// complete after the real session adapter has detached its voice subscriber.
function sessionBridgeFixture(blockedAt, holdRelease = false) {
  const submitted = deferred(); const following = deferred(); const release = deferred();
  const admitting = deferred(); const reply = deferred();
  const prompts = []; const cancels = []; const streams = []; const completed = [];
  const effects = []; let current;
  const controller = {
    async projections({ sessionId }) {
      assert.equal(sessionId, 'chosen');
      return { kind: 'sequenced', values: {} };
    },
    follow(request, signal) {
      assert.equal(request.address.sessionId, 'chosen');
      assert.equal(request.assistantStream, true);
      const stream = { signal, closed: deferred(), request: null };
      streams.push(stream); current = stream;
      return (async function* () {
        let seq = 10;
        const event = (type, data) => ({ type: 'event', event: { seq: ++seq, type, data } });
        try {
          yield { type: 'snapshot', header: { id: 'chosen' }, cursor: seq, projections: { values: {} } };
          yield event('turn/start', { turn: 8 });
          yield event('user/message', { source: { kind: 'user', rpcId: stream.request.requestId } });
          following.resolve();
          if (streams.indexOf(stream) === 0) await reply.promise;
          const text = streams.indexOf(stream) === 0 ? '迟到答复。' : '后续答复。';
          yield { type: 'assistant-stream', frame: { type: 'start', turn: 8, startedAfterSeq: seq, attemptId: 'attempt', step: 1 } };
          yield { type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'attempt', index: 0, chunk: { type: 'text-delta', text } } };
          yield { type: 'assistant-stream', frame: { type: 'end', attemptId: 'attempt', index: 1,
            outcome: { kind: 'committed', eventType: 'assistant/message', seq: seq + 1 } } };
          yield event('assistant/message', { turn: 8, step: 1, message: { content: [{ type: 'text', text }] } });
          yield event('turn/end', { turn: 8, reason: { kind: 'completed' } });
        } finally { stream.closed.resolve(); }
      })();
    },
    async prompt(request, signal) {
      prompts.push({ request, signal }); current.request = request; submitted.resolve();
      if (prompts.length === 1 && blockedAt === 'admission') await admitting.promise;
      return { requestId: request.requestId };
    },
    async cancel(...args) { cancels.push(args); },
  };
  const lease = {
    caption(speaker, text) { effects.push(['caption', speaker, text]); return true; },
    indicate(state) { effects.push(['indicate', state]); },
    prepareSpeech(text) {
      effects.push(['prepareSpeech', text]);
      return { async discard() {} };
    },
    async speak(text) { effects.push(['speak', text]); },
    async interrupt() { effects.push(['interrupt']); },
    async release({ target }) {
      assert.equal(target, 'device-idle'); effects.push(['release']);
      if (holdRelease) await release.promise;
      return { deviceIdle: true };
    },
  };
  const voice = { mode: 'simulation', capabilities: Object.fromEntries(independentVoiceCapabilities.map(k => [k, true])),
    async acquire() { return lease; } };
  const bridge = new VoiceBridge({ voice, dsh: createDshSessionAdapter({ controller }), exitTarget: 'device-idle',
    timeoutMs: 500, turnTimeoutMs: 100 });
  let finished = false;
  function finishDesktop() {
    if (!finished && prompts.length) { completed.push(prompts[0].request.requestId); finished = true; }
    admitting.resolve(); reply.resolve();
  }
  const say = (text, id = text) => bridge.receive({ id, text, final: true });
  return { bridge, say, submitted, following, release, prompts, cancels, streams, completed, effects, finishDesktop };
}

for (const blockedAt of ['admission', 'follow']) {
  for (const cancellation of ['release', 'spoken-stop', 'timeout']) {
    test(`real session adapter: ${cancellation} detaches ${blockedAt} without cancelling desktop work`, { timeout: 3000 }, async t => {
      const f = sessionBridgeFixture(blockedAt, cancellation === 'release');
      const pending = [];
      t.after(async () => {
        f.finishDesktop(); f.release.resolve();
        await f.bridge.stop(); await Promise.all(pending);
        await Promise.all(f.streams.map(stream => stream.closed.promise));
      });
      await f.bridge.enter('chosen');
      const first = f.say('one'); pending.push(first);
      await (blockedAt === 'admission' ? f.submitted.promise : f.following.promise);
      assert.equal(f.prompts.length, 1);
      assert.equal(f.prompts[0].request.sessionId, 'chosen');
      assert.equal(f.prompts[0].request.mode, 'queue');
      assert.deepEqual(f.prompts[0].request.content, [{ type: 'text', text: 'one' }]);
      const readSignal = f.streams[0].signal;
      if (cancellation === 'timeout') {
        assert.deepEqual(await first, { failed: 'timeout', recovered: true });
        assert.equal(f.bridge.state, 'bridged');
      } else {
        pending.push(f.say('queued'));
        const stopped = cancellation === 'release' ? f.bridge.stop('manual-release') : f.say('停止');
        pending.push(stopped);
        assert.equal(f.bridge.state, 'releasing');
        assert.equal(readSignal.aborted, true);
        if (cancellation === 'release') {
          await tick();
          assert.equal(f.bridge.state, 'releasing');
          f.release.resolve();
        }
        await stopped;
        assert.equal(f.bridge.state, 'idle');
      }
      assert.equal(readSignal.aborted, true);
      assert.equal(f.prompts[0].signal.aborted, true);
      assert.deepEqual(f.cancels, []);
      assert.deepEqual(f.effects.filter(effect => ['caption', 'indicate', 'prepareSpeech', 'speak'].includes(effect[0])),
        cancellation === 'timeout' ? [['caption', 'user', 'one'], ['indicate', 'waiting'], ['indicate', 'listening']]
          : [['caption', 'user', 'one'], ['indicate', 'waiting']]);
      const afterDetach = structuredClone(f.effects);
      f.finishDesktop();
      await Promise.all(pending); await f.streams[0].closed.promise; await tick();
      assert.deepEqual(f.completed, [f.prompts[0].request.requestId]);
      assert.equal(f.prompts.length, 1, 'queued speech and Stop must not submit another prompt');
      assert.deepEqual(f.cancels, []);
      assert.deepEqual(f.effects, afterDetach, 'late preview/final text must not reach TTS, device captions or listening state');
      if (cancellation !== 'timeout') await f.bridge.enter('chosen');
      assert.deepEqual(await f.say('next'), { delivered: true });
      assert.equal(f.prompts.length, 2);
      assert.notEqual(f.prompts[1].request.requestId, f.prompts[0].request.requestId);
      assert.deepEqual(f.effects.filter(effect => effect[0] === 'speak'), [['speak', '后续答复。']]);
      assert.deepEqual(f.effects.filter(effect => effect[0] === 'prepareSpeech'), [['prepareSpeech', '后续答复。']]);
      await f.say('停止', 'final-stop');
      assert.equal(f.bridge.state, 'idle');
      assert.equal(f.prompts.length, 2, 'Stop remains local after recovery');
      assert.deepEqual(f.cancels, []);
    });
  }
}
function linkedFixture(overrides = {}) {
  const indicators = [], notices = [], stages = [];
  const f = fixture({ ...overrides,
    options: { onStage: (stage, fields) => stages.push(fields?.source ? `${stage}:${fields.source}` : stage), ...overrides.options },
    lease: { standbyMode: 2, lastSpeechAtMs: () => 0, indicate: state => indicators.push(state),
      async notice(kind) { notices.push(kind); return true; }, ...overrides.lease } });
  return { ...f, indicators, notices, stages };
}
test('a configured wake name matches however recognition spells it, and ordinary speech does not', () => {
  for (const text of ['小D在吗', '小 D，在吗？', '小弟在吗', '嘿小迪在不在', '你好小D', '小D'])
    assert.deepEqual(testWake(text), { rest: '' }, text);
  assert.deepEqual(testWake('小D，帮我看下天气'), { rest: '帮我看下天气' });
  for (const text of ['小D在嗎？', '曉迪在嗎', '晓迪，在吗', '小帝在麼', '小地帶嗎', '有地在嗎?']) assert.deepEqual(testWake(text), { rest: '' }, text);
  assert.deepEqual(testWake('Hi 小D 在吗？今天几号'), { rest: '今天几号' });
  for (const text of ['小的时候我去过', '小弟在家吗', '小地方', '小弟弟在哪', '今天天气不错', '我问一下小D在吗'])
    assert.equal(testWake(text), null, text);
});
test('wake names come from configuration; the default answers to stackchan, not a personal name', () => {
  assert.deepEqual(matchWake('Hey StackChan, 在吗'), { rest: '' });
  assert.deepEqual(matchWake('stack chan 今天几号'), { rest: '今天几号' });
  assert.equal(matchWake('小D在吗'), null);
  assert.equal(createWakeMatcher([])('stackchan'), null);
  assert.deepEqual(createWakeMatcher(['a.b'])('a.b在吗'), { rest: '' });
  assert.equal(createWakeMatcher(['a.b'])('axb在吗'), null);
  assert.throws(() => createWakeMatcher(['[小']), /Unbalanced/);
});
test('a linked device waits until it is addressed and only then talks to DSH', async () => {
  const f = linkedFixture(); await f.bridge.enter('chosen');
  assert.equal(f.bridge.status().attending, false);
  assert.deepEqual(f.indicators, ['standby']);
  assert.deepEqual(await f.say('今天天气不错'), { ignored: true });
  assert.deepEqual(await f.say('停止'), { ignored: true }); // Nothing to stop while waiting.
  assert.equal(f.bridge.status().state, 'bridged');
  assert.deepEqual(await f.say('小D在吗'), { woke: true });
  await tick();
  assert.equal(f.bridge.status().attending, true);
  assert.deepEqual(f.notices, ['wake']); // An answer in place of the factory chime.
  await f.say('现在几点');
  assert.deepEqual(f.calls.filter(Array.isArray), [['bind', 'chosen'], ['ask', '现在几点']]);
  assert.deepEqual(f.spoken, ['reply:现在几点']);
  assert.deepEqual(f.indicators.slice(0, 2), ['standby', 'listening']);
  await f.bridge.stop();
});
test('a request after the wake phrase goes to DSH without the phrase', async () => {
  const f = linkedFixture(); await f.bridge.enter('chosen');
  await f.say('小D，帮我看下天气', 'u1');
  assert.deepEqual(f.calls.filter(Array.isArray), [['bind', 'chosen'], ['ask', '帮我看下天气']]);
  assert.deepEqual(f.notices, []); // The reply is the acknowledgement.
  await f.bridge.stop();
});
test('停止 or 待机 sends a linked device back to waiting without giving up the link', async () => {
  const reply = deferred(); const started = deferred();
  const f = linkedFixture({ binding: { async ask(text) { if (text === 'slow') { started.resolve(); return reply.promise; } return 'ok'; } } });
  await f.bridge.enter('chosen');
  await f.say('小D在吗');
  const first = f.say('slow'); await started.promise;
  const queued = f.say('queued');
  assert.deepEqual(await f.say('待机'), { asleep: true });
  assert.equal(f.bridge.status().state, 'bridged');
  assert.equal(f.bridge.status().attending, false);
  reply.resolve('too late');
  assert.deepEqual(await first, { interrupted: true });
  assert.deepEqual(await queued, { ignored: true }); // Asked before it went back to waiting.
  assert.deepEqual(f.spoken, []);
  assert.equal(f.calls.includes('release'), false);
  assert.equal(f.indicators.at(-1), 'standby');
  assert.deepEqual(await f.say('还在吗'), { ignored: true });
  await f.say('小弟在吗'); await f.say('again');
  assert.deepEqual(f.spoken, ['ok']);
  await f.bridge.stop();
  assert.deepEqual(f.calls.filter(call => call === 'release'), ['release']);
});
test('a linked device stops attending after a quiet period and keeps the link', async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const f = linkedFixture({ options: { idleReleaseMs: 120 } });
  await f.bridge.enter('chosen');
  await sleep(300); // Waiting is not a countdown.
  assert.equal(f.bridge.status().state, 'bridged');
  await f.say('小D在吗'); await sleep(40);
  assert.equal(f.bridge.status().attending, true);
  await sleep(320);
  assert.equal(f.bridge.status().attending, false);
  assert.equal(f.bridge.status().state, 'bridged');
  assert.ok(f.stages.includes('sleep:idle'));
  await f.say('小D在吗'); await tick(); // The same watch covers the next conversation.
  assert.equal(f.bridge.status().attending, true);
  await sleep(320);
  assert.equal(f.bridge.status().attending, false);
  await f.bridge.stop();
});
test('a tap on the face toggles attention; the head strip wakes, hushes and tells DSH about a stroke', async () => {
  const reply = deferred(); const started = deferred();
  const f = linkedFixture({ options: { eventCooldownMs: 60000, touchActions: true },
    binding: { async ask(text) { f.calls.push(['ask', text]); if (text === 'slow') { started.resolve(); return reply.promise; } return 'ok'; } } });
  await f.bridge.enter('chosen');
  f.handlers().onAttention(); await tick();
  assert.equal(f.bridge.status().attending, true);
  assert.deepEqual(f.notices, ['wake']);
  f.handlers().onAttention(); await tick(); await tick();
  assert.equal(f.bridge.status().attending, false);
  f.handlers().onGesture({ kind: 'hold' }); await tick();
  assert.equal(f.bridge.status().attending, true);
  const slow = f.say('slow'); await started.promise;
  f.handlers().onGesture({ kind: 'tap' }); // Silences this reply only.
  reply.resolve('never heard');
  assert.deepEqual(await slow, { interrupted: true });
  assert.equal(f.bridge.status().attending, true);
  await f.bridge.sleep('test');
  f.handlers().onGesture({ kind: 'toward_channel_1' }); // A stroke wakes it and DSH hears about it.
  f.handlers().onGesture({ kind: 'toward_channel_3' }); // Within the cooldown: no second turn.
  await tick(); await tick(); await tick();
  assert.equal(f.bridge.status().attending, true);
  assert.deepEqual(f.calls.filter(call => Array.isArray(call) && call[0] === 'ask').map(call => call[1]), ['slow', '（摸了摸你的头）']);
  assert.deepEqual(f.spoken, ['ok']);
  await f.bridge.stop();
  const plain = fixture({ options: { touchActions: true } }); await plain.bridge.enter('chosen');
  plain.handlers().onGesture({ kind: 'toward_channel_1' }); await tick();
  assert.deepEqual(plain.calls.filter(Array.isArray), [['bind', 'chosen']]); // Not configured: strokes stay local.
  await plain.bridge.stop();
});
test('hush words are recognised the way people actually say them', () => {
  // v66: every interrupt was merged into the next turn because only bare phrases matched.
  for (const text of ['别说了', '好了好了别说了', '停停停', '停一下吧', '你先别说了。', '等等，等等', '算了算了', '好了', '可以了可以了', 'OK stop', 'Enough!'])
    assert.equal(isHush(text), true, text);
  assert.equal(isHush('小D，停一下', testWake), true);
  assert.equal(isHush('小D', testWake), false);
  assert.equal(isHush('好了', undefined, { soft: false }), false); // Could be an answer.
  assert.equal(isHush('别说了吧', undefined, { soft: false }), true);
  for (const text of ['停车场在哪', '你好了吗', '别说了这个我们说别的', '等一下我要去买菜，你帮我记一下清单', '好', '停止', '我知道了然后呢', ''])
    assert.equal(isHush(text), false, text);
});
test('a hush mid-reply silences it; once she is quiet the same words reach DSH', async () => {
  const reply = deferred(); const started = deferred();
  const f = fixture({ binding: { async ask(text, { signal }) {
    f.calls.push(['ask', text]);
    if (text !== 'long') return `reply:${text}`;
    started.resolve();
    return Promise.race([reply.promise, new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))]);
  } } });
  await f.bridge.enter('chosen');
  const long = f.say('long'); await started.promise;
  assert.deepEqual(await f.say('好了好了别说了', 'h1'), { interrupted: true });
  assert.deepEqual(await long, { interrupted: true });
  assert.deepEqual(await f.say('停', 'late'), { ignored: true }); // Just after: a late hush, not a question.
  assert.deepEqual(await f.say('好了', 'answer'), { delivered: true }); // Soft words may be an answer.
  f.bridge.turnEndedAt = -Infinity;                                // Much later, even a strong word is speech.
  assert.deepEqual(await f.say('安静', 'later'), { delivered: true });
  assert.deepEqual(f.calls.filter(c => Array.isArray(c) && c[0] === 'ask').map(c => c[1]), ['long', '好了', '安静']);
  await f.bridge.stop();
});
test('a face tap while she is talking only silences her and keeps her listening', async () => {
  const reply = deferred(); const started = deferred();
  const f = linkedFixture({ binding: { async ask(text, { signal }) {
    if (text !== 'long') return 'ok';
    started.resolve();
    return Promise.race([reply.promise, new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))]);
  } } });
  await f.bridge.enter('chosen');
  f.handlers().onAttention(); await tick();
  const long = f.say('long'); await started.promise;
  f.handlers().onAttention(); await tick();
  assert.deepEqual(await long, { interrupted: true });
  assert.equal(f.bridge.status().attending, true);
  assert.ok(f.stages.includes('spoken-hush:tap'));
  f.handlers().onAttention(); await tick(); await tick(); // Quiet now: a tap sends her back to waiting.
  assert.equal(f.bridge.status().attending, false);
  assert.equal(f.bridge.status().state, 'bridged');
  await f.bridge.stop();
});
test('head touches are described as sensor facts, never as what they mean', () => {
  const at = new Date(2026, 10, 23, 14, 2, 11);
  assert.equal(describeTouch({ kind: 'toward_channel_3', durationMs: 830, peak: 3 }, at),
    '14:02:11 头顶电容（三通道，强度0–3）：从通道1滑向通道3，0.8秒，峰值强度3');
  assert.match(describeTouch({ kind: 'hold', durationMs: 1000, peak: 2 }, at), /持续接触，1\.0秒，峰值强度2$/);
  assert.match(describeTouch({ kind: 'tap', durationMs: 102, peak: 3 }, at), /短触，0\.1秒/);
  assert.doesNotMatch(describeTouch({ kind: 'tap', durationMs: 102, peak: 3 }, at), /摸/);
  for (const bad of [{ kind: 'pat', durationMs: 1, peak: 1 }, { kind: 'tap', durationMs: -1, peak: 1 }, { kind: 'tap', durationMs: 1, peak: 4 }, {}])
    assert.equal(describeTouch(bad), null);
});
test('touch facts ride along with the next thing said, without starting a turn', async () => {
  const f = fixture();
  await f.bridge.enter('chosen');
  f.handlers().onGesture({ kind: 'toward_channel_3', durationMs: 800, peak: 3 });
  f.handlers().onGesture({ kind: 'tap', durationMs: 100, peak: 3 });
  await tick(); await tick();
  assert.deepEqual(f.calls.filter(c => Array.isArray(c) && c[0] === 'ask'), []); // Nobody was disturbed.
  await f.say('你在干嘛');
  const asks = f.calls.filter(c => Array.isArray(c) && c[0] === 'ask').map(c => c[1]);
  assert.equal(asks.length, 1);
  assert.match(asks[0], /^［身体传感，非主人原话］\n.*从通道1滑向通道3.*\n.*短触.*\n［以下是主人说的话］\n你在干嘛$/su);
  await f.say('再说一次');                                    // Handed over once only.
  assert.equal(f.calls.filter(c => Array.isArray(c) && c[0] === 'ask').at(-1)[1], '再说一次');
  for (let i = 0; i < 10; i++) f.handlers().onGesture({ kind: 'tap', durationMs: 100, peak: 2 });
  await f.say('三');
  assert.match(f.calls.filter(c => Array.isArray(c) && c[0] === 'ask').at(-1)[1], /更早还有 2 条未列出/);
  await f.bridge.stop();
});
test('touch facts can instead start a turn at once, inside the event budget, or stay off', async () => {
  const turn = linkedFixture({ options: { bodyFacts: 'turn', eventCooldownMs: 60000 } });
  await turn.bridge.enter('chosen');
  turn.handlers().onGesture({ kind: 'hold', durationMs: 1200, peak: 3 });
  turn.handlers().onGesture({ kind: 'hold', durationMs: 1200, peak: 3 }); // Within the cooldown.
  await tick(); await tick(); await tick();
  const asks = turn.calls.filter(c => Array.isArray(c) && c[0] === 'ask').map(c => c[1]);
  assert.equal(asks.length, 1); assert.match(asks[0], /^［身体传感］.*持续接触，1\.2秒/u);
  await turn.bridge.stop();
  const off = fixture({ options: { bodyFacts: 'off' } });
  await off.bridge.enter('chosen');
  off.handlers().onGesture({ kind: 'tap', durationMs: 100, peak: 3 });
  await off.say('嗯');
  assert.equal(off.calls.filter(c => Array.isArray(c) && c[0] === 'ask').at(-1)[1], '嗯');
  await off.bridge.stop();
  assert.throws(() => fixture({ options: { bodyFacts: 'loud' } }), /Unknown body fact mode/);
});
test('the face Stop button only returns to waiting and keeps the link', async () => {
  const f = linkedFixture({});
  await f.bridge.enter('chosen');
  f.handlers().onAttention('sleep'); await tick(); // Already waiting: stays waiting, never wakes.
  assert.equal(f.bridge.status().attending, false);
  f.handlers().onAttention(); await tick();
  assert.equal(f.bridge.status().attending, true);
  f.handlers().onAttention('sleep'); await tick(); await tick();
  assert.equal(f.bridge.status().attending, false);
  f.handlers().onAttention('sleep'); await tick(); await tick();
  assert.equal(f.bridge.status().attending, false);
  assert.equal(f.bridge.status().state, 'bridged');
  await f.bridge.stop();
});
test('body events reach DSH within a per-kind cooldown and an hourly budget', async () => {
  const f = linkedFixture({ options: { eventCooldownMs: 1, eventsPerHour: 2 } });
  await f.bridge.enter('chosen');
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  assert.equal(f.bridge.tell('unknown'), false); // Only kinds the body really reports.
  assert.equal(f.bridge.tell('stroke'), true); await sleep(5);
  assert.equal(f.bridge.tell('stroke'), true); await sleep(5);
  assert.equal(f.bridge.tell('stroke'), false); // The hour's budget is spent.
  await tick(); await tick();
  assert.equal(f.calls.filter(call => Array.isArray(call) && call[0] === 'ask').length, 2);
  assert.ok(f.stages.includes('event-told:stroke') && f.stages.includes('wake:event'));
  await f.bridge.stop();
  assert.equal(f.bridge.tell('stroke'), false); // Nothing connected to tell.
});
test('DSH can speak first: a waiting device is woken and then listens', async () => {
  const f = linkedFixture(); await f.bridge.enter('chosen');
  assert.deepEqual(await f.bridge.say('饭好了'), { spoken: true });
  assert.deepEqual(f.spoken, ['饭好了']);
  assert.equal(f.bridge.status().attending, true);
  assert.deepEqual(f.notices, []); // Its own words, no acknowledgement first.
  assert.ok(f.stages.includes('wake:agent'));
  await f.say('知道了');
  assert.deepEqual(f.spoken, ['饭好了', 'reply:知道了']);
  await assert.rejects(f.bridge.say('  '), { code: 'invalid-speech' });
  const failing = linkedFixture({ lease: { async speak() { throw Object.assign(new Error('x'), { code: 'voice-playback-failed' }); } } });
  await failing.bridge.enter('chosen');
  assert.deepEqual(await failing.bridge.say('hello'), { failed: 'voice-playback-failed' });
  assert.equal(failing.bridge.status().state, 'bridged');
  await failing.bridge.stop(); await f.bridge.stop();
  await assert.rejects(f.bridge.say('too late'), { code: 'voice-not-connected' });
});
test('with the owner-voice policy on, only the enrolled owner can wake a waiting device', async () => {
  const f = linkedFixture({ options: { ownerOnly: 'wake', eventCooldownMs: 1, touchActions: true } });
  await f.bridge.enter('chosen');
  const hear = (text, owner, id = text + owner) => f.bridge.receive({ id, text, final: true, owner });
  assert.deepEqual(await hear('小D在吗', false), { ignored: true, refused: 'not-owner' });
  assert.deepEqual(await hear('小D在吗', undefined), { ignored: true, refused: 'not-owner' }); // Could not be judged: not a yes.
  assert.equal(f.bridge.status().attending, false);
  assert.ok(f.stages.includes('wake-refused'));
  assert.deepEqual(await hear('小D在吗', true), { woke: true });
  await hear('guest question', false); // Awake: 'wake' only guards the door.
  assert.deepEqual(f.spoken, ['reply:guest question']);
  await f.bridge.sleep('test');
  f.handlers().onGesture({ kind: 'hold' }); // Touching the device is not a voice and still wakes it.
  assert.equal(f.bridge.status().attending, true);
  await f.bridge.sleep('test');
  assert.equal(f.bridge.tell('stroke'), true); await tick(); await tick(); // Body events are the device's own.
  assert.equal(f.calls.filter(call => Array.isArray(call) && call[0] === 'ask').length, 2);
  await f.bridge.stop();
});
test('owner-only throughout ignores other voices even in the middle of a conversation', async () => {
  const f = linkedFixture({ options: { ownerOnly: 'always' } });
  await f.bridge.enter('chosen');
  const hear = (text, owner) => f.bridge.receive({ id: text, text, final: true, owner });
  await hear('小D，现在几点', true);
  assert.deepEqual(await hear('别理他', false), { ignored: true, refused: 'not-owner' });
  assert.deepEqual(await hear('停止', false), { ignored: true, refused: 'not-owner' }); // A guest cannot send it away either.
  assert.equal(f.bridge.status().attending, true);
  await hear('谢谢', true);
  assert.deepEqual(f.spoken, ['reply:现在几点', 'reply:谢谢']);
  await f.bridge.stop();
  assert.throws(() => fixture({ options: { ownerOnly: 'sometimes' } }), { code: 'invalid-owner-policy' });
});
test('by default head-strip gestures never hush, wake or tell DSH anything', async () => {
  const reply = deferred(); const started = deferred();
  const f = linkedFixture({ options: { eventCooldownMs: 1 },
    binding: { async ask() { started.resolve(); return reply.promise; } } });
  await f.bridge.enter('chosen');
  for (const kind of ['hold', 'tap', 'toward_channel_1', 'toward_channel_3']) f.handlers().onGesture({ kind, durationMs: 120, peak: 1 });
  await tick();
  assert.equal(f.bridge.status().attending, false);  // A false hold does not wake it.
  await f.say('小D在吗');
  const turn = f.say('现在几点');
  await started.promise;
  f.handlers().onGesture({ kind: 'tap', durationMs: 80, peak: 1 });  // A false tap does not cut the reply.
  reply.resolve('三点');
  await turn;
  assert.deepEqual(f.spoken, ['三点']);
  assert.ok(!f.stages.includes('spoken-hush') && !f.stages.some(stage => stage.startsWith('event-told')));
  await f.bridge.stop();
});
function earlyFixture(script) {
  const order = []; let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture({ options: { speakEarly: true },
    lease: { prepareSpeech(text) { order.push(['prepared', text]); return { text, discard: async () => {} }; },
      async speak(text, { prepared } = {}) { order.push(['speak', text, !!prepared]); } },
    binding: { async ask(_text, { onSpeechPreview }) { return script(onSpeechPreview, gate, order); } } });
  return { ...f, order, release };
}
test('the first sentence is spoken while DSH is still writing, then only the rest', async () => {
  const f = earlyFixture(async (preview, gate, order) => {
    preview('好的。');
    await tick(); order.push(['still-writing']);
    await gate;
    return '好的。现在是下午三点。';
  });
  await f.bridge.enter('chosen');
  const turn = f.say('几点了');
  await tick(); await tick(); await tick();
  f.release();
  await turn;
  assert.deepEqual(f.order, [['prepared', '好的。'], ['speak', '好的。', true], ['still-writing'], ['speak', '现在是下午三点。', false]]);
  await f.bridge.stop();
});
test('when DSH goes on to a tool call, the final reply is spoken whole after the early sentence', async () => {
  const f = earlyFixture(async (preview, gate) => {
    preview('我查一下。');
    await tick();
    preview(null);  // The turn went on to call a tool.
    await gate;
    return '查到了，明天晴。';
  });
  await f.bridge.enter('chosen');
  const turn = f.say('明天天气');
  await tick(); await tick(); f.release(); await turn;
  assert.deepEqual(f.order.filter(([kind]) => kind === 'speak').map(([, text]) => text), ['我查一下。', '查到了，明天晴。']);
  await f.bridge.stop();
});
test('a reply that is only the early sentence is not spoken twice, and stop cuts the early sentence', async () => {
  const f = earlyFixture(async (preview, gate) => { preview('好的。'); await gate; return '好的。'; });
  await f.bridge.enter('chosen');
  const turn = f.say('嗯'); await tick(); f.release(); await turn;
  assert.deepEqual(f.order.filter(([kind]) => kind === 'speak').map(([, text]) => text), ['好的。']);
  await f.bridge.stop();
  const g = fixture({ options: { speakEarly: true },
    lease: { prepareSpeech(text) { return { text, discard: async () => {} }; },
      speak: (_text, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) },
    binding: { async ask(_text, { onSpeechPreview, signal }) {
      onSpeechPreview('好的。');
      // Like the real adapter: cancellation ends the pending DSH turn.
      await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    } } });
  await g.bridge.enter('chosen');
  const cut = g.say('嗯'); await tick();
  await g.say('停止');
  assert.deepEqual(await cut, { failed: 'stopped' });  // The usual result for a turn Stop cut short.
  assert.equal(g.bridge.status().state, 'original');
});
test('speech arriving while DSH is busy joins the next turn instead of piling up', async () => {
  const first = deferred(); const started = deferred(); let n = 0;
  const f = fixture({ binding: { async ask(text) { f.calls.push(['ask', text]); if (n++ === 0) { started.resolve(); return first.promise; } return `reply:${text}`; } } });
  await f.bridge.enter('chosen'); const one = f.say('one'); await started.promise;
  const two = f.say('two'); const three = f.say('three'); const four = f.say('four');
  assert.equal(f.bridge.status().pending, 2);
  first.resolve('reply:one');
  const [a, b, c, d] = await Promise.all([one, two, three, four]);
  assert.deepEqual(f.calls.filter(x => Array.isArray(x) && x[0] === 'ask'), [['ask','one'],['ask','two\nthree\nfour']]);
  assert.deepEqual(f.spoken, ['reply:one', 'reply:two\nthree\nfour']);
  assert.equal(a.delivered, true); assert.equal(b.merged, undefined); assert.equal(c.merged, true); assert.equal(d.merged, true);
  await f.say('five'); assert.deepEqual(f.calls.filter(x => Array.isArray(x) && x[0] === 'ask').at(-1), ['ask','five']);
  await f.bridge.stop();
});
test('session replies from elsewhere are spoken only when enabled and while bridged', async () => {
  for (const enabled of [false, true]) {
    let push; const watching = deferred();
    const f = fixture({ options: { speakSessionReplies: enabled }, binding: {
      async watch({ onReply, signal }) { push = onReply; watching.resolve();
        await new Promise(r => signal.addEventListener('abort', r, { once: true })); } } });
    await f.bridge.enter('home');
    if (!enabled) { await tick(); assert.equal(push, undefined); await f.bridge.stop(); continue; }
    await watching.promise;
    await push('from the desktop');
    assert.deepEqual(f.spoken, ['from the desktop']);
    await f.bridge.stop();
    await push('after stop');
    assert.deepEqual(f.spoken, ['from the desktop']);
  }
});
test('saying something from inside the voice turn plays now instead of waiting for that turn', async () => {
  let f;
  f = fixture({ binding: { async ask(text) {
    const said = await f.bridge.say('稍等，我看一下。');
    f.calls.push(['said', said]);
    return `reply:${text}`;
  } } });
  await f.bridge.enter('chosen');
  const result = await f.say('几点了');
  assert.equal(result.delivered, true);
  assert.deepEqual(f.calls.find(x => Array.isArray(x) && x[0] === 'said'), ['said', { spoken: true }]);
  assert.deepEqual(f.spoken, ['稍等，我看一下。', 'reply:几点了']);
  await f.bridge.stop();
});
test('faces with a status line see thinking and tool progress, throttled to the latest', async () => {
  const captions = [];
  const f = fixture({ lease: { captionStatus: true, caption(speaker, text) { captions.push([speaker, text]); return true; } },
    binding: { async ask(text, { onProgress }) {
      onProgress({ kind: 'thinking', text: '想' }); onProgress({ kind: 'thinking', text: '想一想' });
      await new Promise(r => setTimeout(r, 350));
      onProgress({ kind: 'tool', name: 'web_search' });
      await new Promise(r => setTimeout(r, 350));
      return `reply:${text}`;
    } } , options: { timeoutMs: 2000 } });
  await f.bridge.enter('chosen');
  await f.say('天气');
  assert.deepEqual(captions, [['user', '天气'], ['status', '思考中…'], ['status', '思考中：想一想'],
    ['status', '正在用 web_search…'], ['assistant', 'reply:天气']]);
  await f.bridge.stop();
});
