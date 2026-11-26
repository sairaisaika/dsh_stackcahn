import test from 'node:test';
import assert from 'node:assert/strict';
import { createDshSessionAdapter } from '../src/dsh-session.mjs';
import { createHostAgent } from '../src/host.mjs';
import { independentVoiceCapabilities } from '../src/bridge.mjs';
function fixture({ missing=false, migration=false, concurrent=false, gap=false, reason='completed', inbox=()=>undefined }={}) {
  let request;let opened=false;let closed=false;const calls=[];
  const controller={
    async projections({sessionId}) {calls.push(['projections',sessionId]);return missing?null:{kind:migration?'migration-required':'sequenced',values:{workingDirectory:'/workspace',agentPreset:'chosen-persona'}};},
    async prompt(value){assert.equal(opened,true);request=value;calls.push(['prompt',value]);},
    async *follow({address},signal){
      try{
        opened=true;yield {type:'snapshot',header:{id:address.sessionId},cursor:10,projections:{values:{inbox:inbox()}},records:[]};
        let seq=10;
        const event=(type,data)=>({type:'event',event:{seq:++seq,type,data}});
        yield event('turn/start',{turn:8});
        yield event('user/message',{role:'user',content:request.content,source:{kind:'user',rpcId:request.requestId}});
        if(concurrent)yield event('user/message',{role:'user',content:[],source:{kind:'user',rpcId:'desktop'}});
        if(gap)seq++;
        yield event('assistant/message',{turn:8,message:{content:[{type:'thinking',text:'private reasoning'},{type:'text',text:'actual reply'}]}});
        yield event('turn/end',{turn:8,reason:{kind:reason}});
        signal.throwIfAborted();
      }finally{closed=true;}
    },
  };
  return {controller,calls,closed:()=>closed};
}
const signal=()=>new AbortController().signal;
test('binds exact session and forwards plain text through public controller without persona/model rewriting',async()=>{
  const f=fixture();const dsh=createDshSessionAdapter({controller:f.controller});const b=await dsh.bind('selected',{signal:signal()});
  assert.equal(b.sessionId,'selected');assert.equal(b.preset,'chosen-persona');
  assert.equal(await b.ask('unchanged\nmessage',{signal:signal()}),'actual reply');
  const req=f.calls.find(x=>x[0]==='prompt')[1];
  assert.equal(req.sessionId,'selected');assert.equal(req.mode,'queue');
  assert.deepEqual(req.content,[{type:'text',text:'unchanged\nmessage'}]);assert.equal('model'in req,false);assert.equal('system'in req,false);assert.equal(f.closed(),true);
});
test('two turns use the same session after DSH changes its model selection',async()=>{
  const {controller,calls}=fixture();
  const selections=[{provider:'first-provider',model:'first-model'}, {provider:'new-provider',model:'new-model'}];
  let selected=selections[0];
  const projections=controller.projections;
  controller.projections=async request=>{
    const snapshot=await projections(request);
    return {...snapshot,values:{...snapshot.values,modelSelection:{next:selected}}};
  };
  const prompt=controller.prompt;
  const used=[];
  controller.prompt=async request=>{used.push(selected);await prompt(request);};
  const binding=await createDshSessionAdapter({controller}).bind('selected',{signal:signal()});
  assert.equal(await binding.ask('first turn',{signal:signal()}),'actual reply');
  selected=selections[1];
  assert.equal(await binding.ask('second turn',{signal:signal()}),'actual reply');
  assert.deepEqual(used,selections);
  const requests=calls.filter(([kind])=>kind==='prompt').map(([,request])=>request);
  assert.deepEqual(requests.map(({requestId,...rest})=>rest),['first turn','second turn'].map(text=>({
    sessionId:'selected', mode:'queue', content:[{type:'text',text}],
  })));
  assert.notEqual(requests[0].requestId,requests[1].requestId);
});
test('missing/migration session never creates replacement',async()=>{
  for(const [arg,code]of [[{missing:true},'session-not-found'],[{migration:true},'session-migration-required']]){
    const f=fixture(arg);await assert.rejects(createDshSessionAdapter({controller:f.controller}).bind('selected',{signal:signal()}),{code});
    assert.equal(f.calls.length,1);
  }
});
test('concurrent desktop input withholds ambiguous voice output',async()=>{
  const f=fixture({concurrent:true});const b=await createDshSessionAdapter({controller:f.controller}).bind('selected',{signal:signal()});
  await assert.rejects(b.ask('hello',{signal:signal()}),{code:'session-concurrent-input'});assert.equal(f.closed(),true);
});
test('sequence gaps and incomplete turns fail instead of speaking stale output',async()=>{
  for(const [arg,code]of [[{gap:true},'dsh-protocol'],[{reason:'cancelled'},'dsh-turn-incomplete']]){
    const f=fixture(arg);const b=await createDshSessionAdapter({controller:f.controller}).bind('selected',{signal:signal()});
    await assert.rejects(b.ask('hello',{signal:signal()}),{code});assert.equal(f.closed(),true);
  }
});
test('only a matching durable final reply can reuse locally prepared speech', async () => {
  for (const scenario of ['matching', 'different-text', 'tool-call', 'retry', 'cursor-gap']) {
    const f = fixture();
    const previews = [];
    let admitted;
    f.controller.prompt = async request => { admitted = request.requestId; };
    f.controller.follow = async function* (request) {
      assert.equal(request.assistantStream, true);
      yield { type: 'snapshot', header: { id: request.address.sessionId }, cursor: 10 };
      let seq = 10;
      const event = (type, data) => ({ type: 'event', event: { seq: ++seq, type, data } });
      const live = frame => ({ type: 'assistant-stream', frame });
      yield live({ type: 'start', attemptId: 'old', turn: 7, step: 2, startedAfterSeq: 10 });
      yield live({ type: 'chunk', attemptId: 'old', index: 0, chunk: { type: 'text-delta', text: '上一轮。' } });
      yield event('turn/start', { turn: 8 });
      yield event('user/message', { source: { kind: 'user', rpcId: admitted } });
      yield live({ type: 'start', attemptId: 'a', turn: 8, step: 3, startedAfterSeq: seq });
      yield live({ type: 'chunk', attemptId: 'a', index: 0, chunk: { type: 'reasoning-delta', text: '推理。' } });
      yield live({ type: 'chunk', attemptId: 'a', index: 1, chunk: { type: 'text-delta', text: '第一句。' } });
      assert.deepEqual(previews, ['第一句。']);
      const content = [{ type: 'text', text: scenario === 'different-text' ? '另一句。' : '第一句。然后继续。' }];
      if (scenario === 'tool-call') content.push({ type: 'tool-call' });
      const settlement = scenario === 'retry' ? 'assistant/attempt' : 'assistant/message';
      yield event(settlement, { turn: 8, step: 3, message: { content } });
      yield live({ type: 'end', attemptId: 'a', index: scenario === 'cursor-gap' ? 3 : 2,
        outcome: { kind: 'committed', eventType: settlement, seq } });
      if (scenario === 'retry') yield event('assistant/message', { turn: 8, step: 3, message: { content } });
      yield event('turn/end', { turn: 8, reason: { kind: 'completed' } });
    };
    const b = await createDshSessionAdapter({ controller: f.controller }).bind('selected', { signal: signal() });
    const result = await b.ask('hello', { signal: signal(), onSpeechPreview: value => previews.push(value) });
    assert.deepEqual(previews, scenario === 'matching' ? ['第一句。'] : ['第一句。', null], scenario);
    assert.equal(result, scenario === 'tool-call' ? '' : scenario === 'different-text' ? '另一句。' : '第一句。然后继续。');
  }
});
test('busy selected agent drains preceding work before the new voice input is submitted exactly once',async()=>{
  const f=fixture();
  const agent={status:'running'};
  let observing=false;
  f.controller.observeState=async function* ({sessionId}) {
    assert.equal(sessionId,'selected');
    yield {running:true,queue:[]};
    assert.equal(f.calls.length,1);
    yield {running:false,queue:[{placement:'queued'}]};
    assert.equal(f.calls.length,1);
    agent.status='idle';
    try { yield {running:false,queue:[]}; } finally { observing=false; }
  };
  const b=await createDshSessionAdapter({controller:f.controller,getAgent:()=>agent}).bind('selected',{signal:signal()});
  observing=true;
  assert.equal(await b.ask('hello',{signal:signal()}),'actual reply');
  assert.equal(observing,false);
  assert.equal(f.calls.filter(([method])=>method==='prompt').length,1);
});
test('waiting for durable queued input checks a newer state and preserves passive plugin context',async()=>{
  let inbox={'next-turn':[{source:{kind:'user'}}]};
  const f=fixture({inbox:()=>inbox});
  let observations=0;
  f.controller.observeState=async function* () {
    observations++;
    yield {running:false,queue:null,cursor:10};
    assert.equal(f.calls.length,1);
    inbox={'next-step':[{source:{kind:'memory-plugin'}}]};
    yield {running:false,queue:[{placement:'context'}],cursor:11};
  };
  const b=await createDshSessionAdapter({controller:f.controller}).bind('selected',{signal:signal()});
  assert.equal(await b.ask('hello',{signal:signal()}),'actual reply');
  assert.equal(observations,1);
  assert.equal(f.calls.filter(([method])=>method==='prompt').length,1);
});
test('stopping while waiting aborts state observation and leaves the DSH inbox untouched',async()=>{
  const f=fixture();
  const started=Promise.withResolvers();
  const released=Promise.withResolvers();
  f.controller.observeState=async function* (_,observing) {
    try {
      yield {running:true,queue:[]};
      const stopped=new Promise(resolve=>observing.addEventListener('abort',resolve,{once:true}));
      started.resolve();
      await stopped;
      observing.throwIfAborted();
    } finally { released.resolve(); }
  };
  const b=await createDshSessionAdapter({controller:f.controller,getAgent:()=>({status:'running'})}).bind('selected',{signal:signal()});
  const stop=new AbortController();
  const rejected=assert.rejects(b.ask('hello',{signal:stop.signal}),{name:'AbortError'});
  await started.promise;
  stop.abort();
  await Promise.all([rejected,released.promise]);
  assert.deepEqual(f.calls,[['projections','selected']]);
});
async function within(promise, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), 250);
    })]);
  } finally { clearTimeout(timer); }
}
for (const phase of ['prompt receipt pending', 'owned turn awaiting end']) {
  test(`abort after submission detaches voice with ${phase}`, { timeout: 2000 }, async t => {
    const receipt = Promise.withResolvers();
    const completed = Promise.withResolvers();
    const submitted = Promise.withResolvers();
    const awaitingEnd = Promise.withResolvers();
    const stop = new AbortController();
    const calls = [];
    const marks = [];
    let request, closed = false, reply;
    const controller = {
      async projections() { return { kind: 'sequenced', values: {} }; },
      async prompt(value) {
        calls.push('prompt'); request = value; submitted.resolve();
        // Admission can finish on the Host even after local voice detaches.
        await receipt.promise;
      },
      async cancel() { calls.push('cancel'); },
      async *follow({ address }, following) {
        try {
          yield { type: 'snapshot', header: { id: address.sessionId }, cursor: 10 };
          yield { type: 'event', event: { seq: 11, type: 'turn/start', data: { turn: 8 } } };
          yield { type: 'event', event: { seq: 12, type: 'user/message',
            data: { source: { kind: 'user', rpcId: request.requestId } } } };
          yield { type: 'event', event: { seq: 13, type: 'assistant/message',
            data: { turn: 8, message: { content: [{ type: 'text', text: 'late reply' }] } } } };
          let onAbort;
          try {
            const aborted = new Promise(resolve => {
              onAbort = resolve;
              following.addEventListener('abort', onAbort, { once: true });
              if (following.aborted) resolve();
            });
            awaitingEnd.resolve(); // The matching rpcId and public text have been consumed.
            await Promise.race([completed.promise, aborted]);
          } finally { following.removeEventListener('abort', onAbort); }
          following.throwIfAborted();
          yield { type: 'event', event: { seq: 14, type: 'turn/end',
            data: { turn: 8, reason: { kind: 'completed' } } } };
        } finally { closed = true; }
      },
    };
    const binding = await createDshSessionAdapter({ controller }).bind('selected', { signal: signal() });
    // Handle rejection immediately, including a failure during test cleanup.
    const outcome = binding.ask('hello', { signal: stop.signal, mark: name => marks.push(name) }).then(
      value => { reply = value; return { value }; }, error => ({ error }),
    );
    t.after(async () => {
      stop.abort(); receipt.resolve(); completed.resolve();
      await outcome;
    });
    await submitted.promise;
    if (phase === 'owned turn awaiting end') {
      receipt.resolve();
      await awaitingEnd.promise;
      assert.ok(marks.includes('dshPublicText'));
    }
    stop.abort();
    const result = await within(outcome, 'voice ask did not detach before the deferred Host result');
    assert.equal(result.error?.name, 'AbortError');
    assert.equal(closed, true);
    assert.deepEqual(calls, ['prompt']);
    receipt.resolve(); completed.resolve();
    await outcome;
    assert.equal(reply, undefined);
    assert.equal(marks.includes('dshTurnCompleted'), false);
    assert.deepEqual(calls, ['prompt']);
  });
}
test('independent Host factory composes the actual session adapter and requires idle release', async () => {
  const f = fixture(); const spoken = []; const targets = [];
  const ctx = { get: key => key === 'sessionController' ? f.controller : new Map() };
  const voice = { mode: 'contract-test',
    capabilities: Object.fromEntries(independentVoiceCapabilities.map(key => [key, true])),
    async acquire() { return {
      async speak(text) { spoken.push(text); }, async interrupt() {},
      async release({ target }) { targets.push(target); return { deviceIdle: true }; },
    }; },
  };
  assert.throws(() => createHostAgent(ctx), /adapter is required/);
  // A caller cannot accidentally turn the independent factory into cloud restoration.
  const bridge = createHostAgent(ctx, { voice, exitTarget: 'original' });
  await bridge.enter('selected');
  await bridge.receive({ id: 'one', text: 'hello', final: true });
  await bridge.receive({ id: 'two', text: '停止', final: true });
  assert.deepEqual(spoken, ['actual reply']); assert.deepEqual(targets, ['device-idle']);
  assert.equal(bridge.status().state, 'idle');
  const request = f.calls.find(c => c[0] === 'prompt')[1];
  assert.equal(request.sessionId, 'selected'); assert.equal('system' in request, false);
  assert.equal(f.calls.filter(c => c[0] === 'prompt').length, 1);
});
test('watch hands over only completed public replies from turns voice did not start', async () => {
  const events = [
    ['turn/start', { turn: 1 }],
    ['user/message', { source: { kind: 'user', rpcId: 'desktop-1' } }],
    ['assistant/message', { turn: 1, message: { content: [{ type: 'tool-call', name: 'x' }] } }],
    ['assistant/message', { turn: 1, message: { content: [{ type: 'thinking', text: 'hidden' }, { type: 'text', text: 'desktop reply' }] } }],
    ['turn/end', { turn: 1, reason: { kind: 'completed' } }],
    ['turn/start', { turn: 2 }],
    ['user/message', { source: { kind: 'user', rpcId: 'stackchan-abc' } }],
    ['assistant/message', { turn: 2, message: { content: [{ type: 'text', text: 'voice reply' }] } }],
    ['turn/end', { turn: 2, reason: { kind: 'completed' } }],
    ['turn/start', { turn: 3 }],
    ['assistant/message', { turn: 3, interrupted: true, message: { content: [{ type: 'text', text: 'cut off' }] } }],
    ['turn/end', { turn: 3, reason: { kind: 'cancelled' } }],
    ['turn/start', { turn: 4 }],
    ['user/message', { source: { kind: 'im' } }],
    ['assistant/message', { turn: 4, message: { content: [{ type: 'text', text: 'telegram reply' }] } }],
    ['turn/end', { turn: 4, reason: { kind: 'completed' } }],
  ];
  let closed = false; const prompts = [];
  const controller = {
    async projections() { return { kind: 'sequenced', values: {} }; },
    async prompt(value) { prompts.push(value); },
    async *follow({ address }) {
      try {
        yield { type: 'snapshot', header: { id: address.sessionId }, cursor: 0 };
        let seq = 0;
        for (const [type, data] of events) yield { type: 'event', event: { seq: ++seq, type, data } };
      } finally { closed = true; }
    },
  };
  const binding = await createDshSessionAdapter({ controller }).bind('home', { signal: signal() });
  const heard = [];
  await binding.watch({ signal: signal(), onReply: text => { heard.push(text); } });
  assert.deepEqual(heard, ['desktop reply', 'telegram reply']);
  assert.deepEqual(prompts, []); assert.equal(closed, true);
});
test('the owned turn reports thinking, tool calls and reply text as progress, ignoring other turns', async () => {
  const f = fixture();
  let admitted;
  f.controller.prompt = async request => { admitted = request.requestId; };
  f.controller.follow = async function* (request) {
    assert.equal(request.assistantStream, true);
    yield { type: 'snapshot', header: { id: request.address.sessionId }, cursor: 10 };
    let seq = 10;
    const event = (type, data) => ({ type: 'event', event: { seq: ++seq, type, data } });
    const live = frame => ({ type: 'assistant-stream', frame });
    yield live({ type: 'start', attemptId: 'old', turn: 7, step: 1, startedAfterSeq: 10 });
    yield live({ type: 'chunk', attemptId: 'old', index: 0, chunk: { type: 'reasoning-delta', text: '别人的。' } });
    yield event('turn/start', { turn: 8 });
    yield event('user/message', { source: { kind: 'user', rpcId: admitted } });
    yield live({ type: 'start', attemptId: 'a', turn: 8, step: 1, startedAfterSeq: seq });
    yield live({ type: 'chunk', attemptId: 'a', index: 0, chunk: { type: 'reasoning-delta', text: '想一想' } });
    yield live({ type: 'chunk', attemptId: 'a', index: 1, chunk: { type: 'tool-call-delta', toolName: 'web_search' } });
    yield event('assistant/message', { turn: 8, step: 1, message: { content: [{ type: 'tool-call', toolName: 'web_search' }] } });
    yield live({ type: 'end', attemptId: 'a', index: 2, outcome: { kind: 'committed', eventType: 'assistant/message', seq } });
    yield live({ type: 'start', attemptId: 'b', turn: 8, step: 2, startedAfterSeq: seq });
    yield live({ type: 'chunk', attemptId: 'b', index: 0, chunk: { type: 'text-delta', text: '晴天。' } });
    yield event('assistant/message', { turn: 8, step: 2, message: { content: [{ type: 'text', text: '晴天。' }] } });
    yield event('turn/end', { turn: 8, reason: { kind: 'completed' } });
  };
  const b = await createDshSessionAdapter({ controller: f.controller }).bind('selected', { signal: signal() });
  const updates = [];
  const result = await b.ask('天气', { signal: signal(), onProgress: update => updates.push(update) });
  assert.equal(result, '晴天。');
  assert.deepEqual(updates, [
    { kind: 'thinking', text: '想一想' },
    { kind: 'tool', name: 'web_search' },
    { kind: 'tool', name: 'web_search' },
    { kind: 'text', text: '晴天。' },
  ]);
});
