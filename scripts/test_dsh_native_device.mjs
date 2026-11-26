// The C++ peer uses the shipped session/audio logic with codec and hardware fixtures.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { AUDIO } from '../src/agent-protocol.mjs';
import { isStop } from '../src/bridge.mjs';

export async function exerciseCppDevice({
  executable, pairId, socket, connecting, voiceRuntime, queue, stop, requests, desktopSeed,
  releaseLastReply, lateText, ctx, sessionId, baseline, lookup, history, serialProcesses, playbackStopFrames, photo,
}) {
  const peer = spawn(executable, ['--stdio-audio', pairId, ...(photo ? [photo.jpegPath] : [])],
    { stdio: ['pipe', 'pipe', 'inherit'] });
  const closed = once(peer, 'close');
  closed.catch(() => {});
  let problem;
  peer.on('error', error => { problem = error; });
  peer.stdin.on('error', error => { problem = error; });
  const pipe = createInterface({ input: peer.stdout });
  let state, atHome = false, closedTransport = false;
  let outputFrames = 0, drains = 0;
  let input = Buffer.alloc(0), offset = 0, tick = 0;
  let stopped;
  const receive = (bytes, binary) => {
    if (binary) {
      if (photo && !photo.readyForPlayback()) {
        problem = new Error('The C++ device received PCM before the final photographed reply');
        return;
      }
      outputFrames++;
    }
    peer.stdin.write(`${binary ? 'B '+bytes.toString('hex') : 'T '+bytes.toString()}\n`);
  };
  socket.on('message', receive);
  pipe.on('line', line => {
    try {
      if (line === 'C') {
        closedTransport = true;
        if (typeof socket.close === 'function') socket.close();
        else socket.terminate();
      } else if (line === 'H') atHome = true;
      else if (line.startsWith('Q ')) {
        const [phase, epoch, attached, inputDepth, outputDepth, opens, closes, writes, cameraOpens, cameraCloses] = line.slice(2).split(' ');
        state = { phase, epoch: Number(epoch), attached: attached === '1',
          inputDepth: Number(inputDepth), outputDepth: Number(outputDepth),
          opens: Number(opens), closes: Number(closes), writes: Number(writes),
          cameraOpens: Number(cameraOpens), cameraCloses: Number(cameraCloses) };
      } else if (line.startsWith('T ')) {
        assert.ok(!closedTransport, 'Closed C++ peer emitted a protocol message');
        const message = JSON.parse(line.slice(2));
        if (message.type === 'output_drained') drains++;
        if (message.type === 'stopped') stopped = message;
        socket.send(line.slice(2));
      } else if (line.startsWith('B ')) {
        assert.ok(!closedTransport, 'Closed C++ peer emitted PCM');
        socket.send(Buffer.from(line.slice(2), 'hex'));
      } else assert.fail('Unexpected C++ fixture output');
    } catch (error) { problem = error; }
  });
  const timer = setInterval(() => {
    if (problem) return;
    const pcm = Buffer.alloc(AUDIO.samples * 4);
    for (let i = 0; i < AUDIO.samples && offset + 1 < input.length; i++, offset += 2) {
      pcm.writeInt16LE(input.readInt16LE(offset), i * 4);
    }
    peer.stdin.write(`P ${tick += 10} ${pcm.toString('hex')}\n`);
  }, 10);

  async function until(check, label) {
    const limit = Date.now() + 30000;
    while (Date.now() < limit) {
      if (problem) throw problem;
      if (await check()) return;
      await delay(20);
    }
    const last = requests.at(-1)?.filter(message => message.role === 'user').at(-1)?.content;
    const transcript = typeof last === 'string' ? last : (last ?? []).map(block => block.text ?? '').join('');
    assert.fail(label + ' ' + JSON.stringify({
      phase: voiceRuntime.snapshot().phase, requests: requests.length, drains, outputFrames, state,
      lastPromptIsStop: isStop(transcript), lastPromptContainsStop: /停止|\bstop\b/iu.test(transcript),
    }));
  }

  function speak(pcm) {
    input = pcm;
    offset = 0;
  }

  async function query() {
    state = undefined;
    peer.stdin.write('Q\n');
    await until(() => state, 'C++ fixture resource state');
    return state;
  }

  async function stopByVoice(previousEpoch) {
    stopped = undefined;
    speak(stop);
    await until(() => stopped && voiceRuntime.snapshot().phase === 'listening', 'Spoken Stop reached the C++ device');
    assert.equal(stopped.resources_stopped, true);
    assert.equal(voiceRuntime.snapshot().deviceIdleConfirmed, true);
    const idle = await query();
    assert.equal(idle.phase, 'idle');
    assert.ok(idle.attached && idle.epoch > previousEpoch);
    assert.equal(idle.inputDepth + idle.outputDepth, 0);
    assert.equal(idle.opens, idle.closes);
    return idle;
  }

  async function resumeAfter(state) {
    speak(Buffer.alloc(0));
    assert.equal((await voiceRuntime.execute('connect')).sessionId, sessionId);
    const resumed = await query();
    assert.ok(resumed.attached && resumed.phase === 'active' && resumed.epoch > state.epoch);
    return resumed;
  }

  async function startPlayback(resumed, requestNumber, frames = 1) {
    speak(queue[1]);
    await until(async () => requests.length === requestNumber &&
      (await query()).writes - resumed.writes >= frames, 'C++ audio port wrote the next reply');
    assert.equal(drains, 2, 'The reply in progress has not drained');
  }

  async function finishHome() {
    await until(() => atHome && voiceRuntime.snapshot().canReconnect, 'Device Home and Host release both completed');
    assert.ok(closedTransport);
    assert.equal(voiceRuntime.snapshot().connected, false);
    assert.equal(voiceRuntime.snapshot().deviceIdleConfirmed, false, 'Closing Home has no successful Stop receipt');
    if (serialProcesses) await until(() => serialProcesses().length === 0, 'Home released the packaged serial process');
    const home = await query();
    assert.equal(home.attached, false);
    assert.equal(home.inputDepth + home.outputDepth, 0);
    assert.equal(home.opens, home.closes);
    assert.equal(home.cameraOpens, home.cameraCloses);
    const final = await lookup();
    assert.equal(final.values.agentPreset, baseline.values.agentPreset);
    assert.equal(final.values.workingDirectory, baseline.values.workingDirectory);
    return home;
  }

  try {
    if (!connecting) {
      await until(() => voiceRuntime.snapshot().connected, 'The host authenticated the C++ hello');
      connecting = voiceRuntime.execute('connect');
    }
    assert.equal((await connecting).sessionId, sessionId);
    const transport = voiceRuntime.snapshot().transport;
    const serialBeforeStop = serialProcesses?.();
    if (serialBeforeStop) assert.equal(serialBeforeStop.length, 1);
    const beforeTouch = await query();
    const beforeTouchRequests = requests.length;
    const gestures = () => voiceRuntime.snapshot().capabilities.headTouch?.recentGestures ?? [];
    peer.stdin.write('G\n');
    await until(() => gestures().length >= 2, 'C++ head-touch events reached the installed DSH plugin');
    assert.deepEqual(gestures().map(gesture => gesture.kind), ['tap', 'toward_channel_3']);
    const afterTouch = await query();
    assert.equal(afterTouch.epoch, beforeTouch.epoch);
    assert.equal(afterTouch.phase, 'active');
    assert.equal(afterTouch.opens, beforeTouch.opens);
    assert.equal(afterTouch.closes, beforeTouch.closes);
    assert.equal(afterTouch.writes, beforeTouch.writes);
    assert.equal(requests.length, beforeTouchRequests, 'Head touch is telemetry and does not start a DSH turn');
    console.log('Installed DSH saw one head tap and one swipe after contact bounce, with no new conversation turn.');

    if (photo) {
      speak(queue[0]);
      await until(() => drains === 1, 'C++ played the final reply after returning a photo');
      const captured = await query();
      assert.equal(captured.cameraOpens, 1, 'The model requested exactly one C++ capture');
      assert.equal(captured.cameraCloses, 1);
      assert.equal(requests.length, 3, 'The tool was followed by one continuation in the same turn');
      assert.ok(JSON.stringify(requests[1]).includes(desktopSeed));
      await photo.verifyModelPhoto();

      speak(Buffer.alloc(0));
      peer.stdin.write('W\n');
      const pending = photo.capture();
      pending.catch(() => {});
      await until(async () => (await query()).cameraOpens === 2, 'Second capture opened and waited for a frame');
      assert.equal((await query()).cameraCloses, 1);
      peer.stdin.write('H\n');
      const home = await finishHome();
      const invalidated = await pending;
      assert.equal(invalidated.isError, true);
      assert.ok(!invalidated.content?.some(block => block.type === 'image'), 'Home invalidated the unfinished photo');
      assert.equal(home.cameraCloses, 2);
      assert.equal(requests.length, 3, 'Home did not send a late image or start a turn');
      await photo.verifyModelPhoto();
      console.log('Installed DSH and C++ CameraEngine passed on '+transport+
        ': completed one photographed turn and released a second pending capture on Home.');
      return;
    }

    for (let round = 0; round < 2; round++) {
      speak(queue[round]);
      await until(() => drains === round + 1, 'C++ playback fence drained real synthesized audio');
      assert.equal(requests.length, round + 2);
      assert.equal(voiceRuntime.snapshot().sessionId, sessionId);
    }
    const heard = await query();
    assert.equal(heard.writes, outputFrames);
    assert.ok(heard.writes > 0);
    assert.equal(heard.phase, 'active');
    assert.ok(JSON.stringify(requests[1]).includes(desktopSeed));
    const firstQuestion = requests[1].filter(message => message.role === 'user').at(-1);
    assert.ok(requests[2].some(message => message.role === 'user' &&
      JSON.stringify(message.content) === JSON.stringify(firstQuestion.content)));
    assert.ok(requests[2].some(message => message.role === 'assistant'));

    speak(queue[2]);
    await until(() => requests.length === 4, 'Third utterance reached the native session');
    const beforeStop = outputFrames;
    const idle = await stopByVoice(heard.epoch);
    assert.equal(idle.writes, heard.writes);
    assert.deepEqual(gestures(), [], 'Stop hides the retired head-touch history');

    releaseLastReply();
    await until(() => ctx.agents.get(sessionId)?.status === 'idle', 'The native session finished the late reply');
    assert.equal(outputFrames, beforeStop);
    assert.equal(requests.length, 4, 'Stop is a control action');
    assert.ok(JSON.stringify((await history()).records).includes(lateText));

    const resumed = await resumeAfter(idle);
    await startPlayback(resumed, 5, playbackStopFrames);
    assert.ok(JSON.stringify(requests[4]).includes(lateText));
    const afterPlaybackStop = await stopByVoice(resumed.epoch);
    assert.equal(drains, 2, 'Spoken Stop preempted the long reply instead of playing it to completion');
    assert.equal(requests.length, 5, 'An interruption during playback also stays out of the conversation');
    const framesAfterPlaybackStop = outputFrames;
    await delay(100);
    assert.equal(outputFrames, framesAfterPlaybackStop, 'No old PCM is sent after the resource receipt');
    if (serialBeforeStop) assert.deepEqual(serialProcesses(), serialBeforeStop);

    const readyForHome = await resumeAfter(afterPlaybackStop);
    await startPlayback(readyForHome, 6);
    peer.stdin.write('H\n');
    await finishHome();
    console.log('Installed DSH and C++ AgentSession passed on '+transport+
      ': two continued turns, stopped with a late reply, stopped after '+playbackStopFrames+
      ' playback frames with echo, and Home during playback.');
  } finally {
    clearInterval(timer);
    socket.off('message', receive);
    peer.stdin.end();
    const result = await Promise.race([closed, delay(3000, null, {ref: false})]);
    if (!result) { peer.kill('SIGKILL'); await closed; }
    pipe.close();
    assert.ok(result, 'C++ fixture terminated on stdin EOF');
    assert.equal(result[0], 0, 'C++ fixture exited successfully');
  }
}
