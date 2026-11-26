// SPDX-License-Identifier: MIT
#include "audio_engine.h"
#include <cassert>
#include <condition_variable>
#include <functional>
#include <iostream>
#include <thread>
using namespace sion::agent;

struct Port : AudioPort {
    int opens = 0, reads = 0, writes = 0, closes = 0;
    int volume = -1; bool volume_ok = true;
    bool open_ok = true, read_ok = true, write_ok = true, close_ok = true;
    std::function<void()> during_open, during_read, during_write;
    std::function<void()> during_fence;
    Result fence_result=Result::Pending;int fence_begins=0,fence_polls=0;bool discarded=false;
    Result PlaybackFence(bool begin,bool discard) override {
        if(begin)++fence_begins;else ++fence_polls;
        discarded=discard;if(during_fence)during_fence();return fence_result;
    }
    bool Open(int next) override { volume = next; ++opens; if (during_open) during_open(); return open_ok; }
    bool Volume(int next) override { volume = next; return volume_ok; }
    bool Read(InputPcm& pcm) override {
        ++reads; pcm[0] = 101; pcm[1] = -102;
        if (during_read) during_read();
        return read_ok;
    }
    bool Write(const OutputPcm&) override { ++writes; if (during_write) during_write(); return write_ok; }
    bool Close() override { ++closes; return close_ok; }
};
void start(AudioEngine& engine, uint64_t epoch = 1) {
    assert(engine.Begin(epoch)); engine.Pump(0);
    assert(engine.status().phase == AudioPhase::Running);
}
OutputFrame output(uint64_t epoch, uint64_t sequence) { return {epoch, sequence, {42}}; }

void duplex_and_backpressure() {
    Port port; AudioEngine engine(port);
    engine.Pump(0); assert(port.opens == 0);
    assert(!engine.Begin(0)); start(engine);
    for (size_t i = 0; i < kAudioQueueFrames; ++i) assert(engine.Push(output(1, i)) == AudioPush::Accepted);
    assert(engine.Push(output(1, 0)) == AudioPush::OutOfOrder);
    assert(engine.Push(output(1, kAudioQueueFrames)) == AudioPush::Backpressure);
    engine.Pump(10000);
    assert(port.reads == 1 && port.writes == 1);
    assert(engine.status().output_written == 1);
    InputFrame frame;
    assert(engine.TakeInput(1, frame));
    assert(frame.pcm[0] == 101 && frame.pcm[1] == -102 && frame.sequence == 0 && frame.read_started_us == 10000);
    assert(engine.Push(output(1, kAudioQueueFrames)) == AudioPush::Accepted);
    engine.Stop(2);
    assert(engine.Stopped(2) == Result::Pending && !engine.Begin(3));
    engine.Pump(0);
    assert(engine.Stopped(2) == Result::Done && port.closes == 1);
    assert(!engine.TakeInput(1, frame) && engine.Push(output(1, 21)) == AudioPush::Stale);
    start(engine, 3); assert(engine.status().output_written == 0);
    assert(engine.Push(output(3, 0)) == AudioPush::Accepted);
}
void overload() {
    Port port; AudioEngine engine(port); start(engine);
    for (size_t i = 0; i <= kAudioQueueFrames; ++i) engine.Pump(i * 10000);
    assert(engine.status().error == AudioError::InputOverflow);
    assert(engine.status().input_depth == 0 && engine.status().phase == AudioPhase::Closing);
    engine.Pump(0); assert(port.closes == 1 && engine.Stopped(1) == Result::Done);
    assert(!engine.Begin(1)); start(engine, 2);
}
void errors() {
    for (auto error : {AudioError::Open, AudioError::Read, AudioError::Write}) {
        Port port; AudioEngine engine(port);
        port.open_ok = error != AudioError::Open;
        port.read_ok = error != AudioError::Read;
        port.write_ok = error != AudioError::Write;
        assert(engine.Begin(1)); engine.Pump(0);
        if (error != AudioError::Open) {
            assert(engine.Push(output(1, 0)) == AudioPush::Accepted);
            engine.Pump(10000);
        }
        assert(engine.status().error == error && engine.Stopped(1) == Result::Pending);
        assert(engine.status().output_written == 0);
        port.close_ok = false; engine.Pump(0);
        assert(engine.Stopped(1) == Result::Failed && !engine.Begin(2));
        port.close_ok = true; engine.Stop(2); engine.Pump(0);
        assert(engine.Stopped(2) == Result::Done && port.closes == 2);
    }
}
void cancelled_open() {
    Port port; AudioEngine engine(port);
    assert(engine.Begin(1)); engine.Stop(2); engine.Pump(0);
    assert(port.opens == 0 && engine.Stopped(2) == Result::Done);
    port.during_open = [&] { engine.Stop(4); };
    assert(engine.Begin(3)); engine.Pump(0);
    assert(engine.Stopped(4) == Result::Pending);
    engine.Pump(0); assert(port.closes == 1 && engine.Stopped(4) == Result::Done);
    engine.Stop(1); assert(engine.status().epoch == 4);
}
void cancel_during_blocked_read(bool microphone = false) {
    Port port; AudioEngine engine(port); start(engine);
    assert(engine.Push(output(1, 0)) == AudioPush::Accepted);
    std::mutex mutex; std::condition_variable cv; bool entered = false, released = false;
    port.during_read = [&] {
        std::unique_lock<std::mutex> lock(mutex);
        entered = true; cv.notify_one(); cv.wait(lock, [&] { return released; });
    };
    std::thread worker([&] { engine.Pump(10000); });
    { std::unique_lock<std::mutex> lock(mutex); cv.wait(lock, [&] { return entered; }); }
    if (microphone) engine.AllowCapture(false);
    engine.Stop(2); // Must return without waiting for the blocked I/O thread.
    assert(engine.Stopped(2) == Result::Pending && !engine.Begin(3));
    { std::lock_guard<std::mutex> lock(mutex); released = true; cv.notify_one(); }
    worker.join();
    InputFrame frame;
    assert(!engine.TakeInput(1, frame) && port.writes == 0 && port.closes == 0);
    engine.Pump(0); assert(engine.Stopped(2) == Result::Done);
}
void cancel_during_write() {
    Port port; AudioEngine engine(port); start(engine);
    port.during_write = [&] { engine.Stop(2); assert(engine.Stopped(2) == Result::Pending); };
    assert(engine.Push(output(1, 0)) == AudioPush::Accepted);
    engine.Pump(0); assert(port.writes == 1 && port.closes == 0);
    assert(engine.status().output_written == 0); // late old write is never a new-epoch credit
    engine.Pump(0); assert(engine.Stopped(2) == Result::Done);
}
void home_integration() {
    Port port; AudioEngine engine(port);
    struct LifecycleEffects : Effects {
        explicit LifecycleEffects(AudioEngine& audio) : audio(audio) {}
        AudioEngine& audio; int home = 0;
        void StopResources(uint64_t epoch) override { audio.Stop(epoch); }
        Result ResourcesStopped(uint64_t epoch) override { return audio.Stopped(epoch); }
        Result ReturnHome(uint64_t) override { ++home; return Result::Done; }
    } effects(engine);
    SessionLifecycle lifecycle(effects);
    assert(!lifecycle.Reopen());
    assert(lifecycle.Begin(0)); const auto first = lifecycle.epoch();
    start(engine, first); assert(lifecycle.Connected(first, 1));
    lifecycle.Home(2); lifecycle.Tick(3);
    assert(effects.home == 0 && lifecycle.phase() == Phase::Draining);
    engine.Pump(0); lifecycle.Tick(4);
    assert(effects.home == 1 && lifecycle.Reopen());
    assert(lifecycle.Begin(5) && lifecycle.epoch() > first);
    assert(!lifecycle.Connected(first, 6));
    start(engine, lifecycle.epoch());
    assert(lifecycle.Connected(lifecycle.epoch(), 6));
}
void settings_controls() {
    Port port; AudioEngine engine(port); engine.SetVolume(70); start(engine);
    assert(port.volume == 70 && engine.status().applied_volume == 70);
    engine.SetVolume(0); assert(engine.status().applied_volume == 70);
    engine.Pump(0); assert(port.volume == 0 && engine.status().applied_volume == 0);
    InputFrame input; assert(engine.TakeInput(1, input));
    port.during_read = [&] { engine.AllowCapture(false); };
    engine.Pump(0); assert(!engine.TakeInput(1, input) && !engine.Begin(2));
    assert(engine.status().phase == AudioPhase::Closing);
    engine.Pump(0); assert(engine.Stopped(1) == Result::Done && !engine.Begin(2));
    engine.AllowCapture(true); assert(engine.status().phase == AudioPhase::Idle);
    start(engine, 2); port.during_read = {}; port.volume_ok = false;
    engine.SetVolume(50); engine.Pump(0);
    assert(engine.status().error == AudioError::Volume);
    engine.Pump(0); assert(engine.status().phase == AudioPhase::Idle);
}
void playback_fences() {
    Port port;AudioEngine engine(port);start(engine);
    assert(engine.Push(output(1,0))==AudioPush::Accepted);
    assert(engine.Push(output(1,1))==AudioPush::Accepted);
    assert(engine.RequestPlaybackFence(1,false));assert(!engine.RequestPlaybackFence(1,true));
    assert(engine.Push(output(1,2))==AudioPush::Backpressure);
    InputFrame input;
    for(int i=0;i<2;++i){engine.Pump(i*10000);assert(engine.TakeInput(1,input));}
    assert(port.writes==2 && port.fence_begins==0);
    engine.Pump(20000);assert(engine.TakeInput(1,input));
    assert(port.fence_begins==1 && !port.discarded && engine.PlaybackFenceStatus(1)==Result::Pending);
    port.fence_result=Result::Done;engine.Pump(30000);assert(engine.TakeInput(1,input));
    assert(engine.PlaybackFenceStatus(1)==Result::Done && port.fence_polls==1);
    assert(engine.Push(output(1,2))==AudioPush::Accepted);
    assert(engine.RequestPlaybackFence(1,true));port.fence_result=Result::Pending;
    engine.Pump(40000);assert(engine.TakeInput(1,input));
    assert(port.writes==2 && port.discarded && engine.status().output_depth==0);
    port.fence_result=Result::Done;engine.Pump(50000);assert(engine.TakeInput(1,input));
    assert(engine.Push(output(1,3))==AudioPush::Accepted);engine.Pump(60000);
    assert(engine.status().output_written==4); // discarded sequence 2 is not replayed
    assert(engine.TakeInput(1,input));
    assert(engine.RequestPlaybackFence(1,false));
    port.during_fence=[&]{engine.Stop(2);};engine.Pump(70000);
    assert(engine.PlaybackFenceStatus(1)==Result::Failed && engine.PlaybackFenceStatus(2)==Result::Failed);
    engine.Pump(80000);assert(engine.Stopped(2)==Result::Done);
}
void playback_fence_failures() {
    for(bool timeout : {false,true}) {
        Port port;AudioEngine engine(port);start(engine);
        assert(!engine.RequestPlaybackFence(0,true));assert(engine.RequestPlaybackFence(1,true));
        port.fence_result=timeout?Result::Pending:Result::Failed;
        engine.Pump(10000);
        if(timeout)engine.Pump(2010000);
        assert(engine.status().error==AudioError::PlaybackFence);
        assert(engine.PlaybackFenceStatus(1)==Result::Failed);
        engine.Pump(2020000);assert(engine.Stopped(1)==Result::Done);
    }
    Port port;AudioEngine engine(port);start(engine);
    port.during_write=[&]{assert(engine.RequestPlaybackFence(1,true));};
    assert(engine.Push(output(1,0))==AudioPush::Accepted);engine.Pump(0);
    assert(port.fence_begins==0);engine.Pump(10000);
    assert(port.fence_begins==1 && port.writes==1); // fence begins after the in-flight write
}
int main() {
    playback_fences();playback_fence_failures();
    settings_controls(); duplex_and_backpressure(); overload(); errors(); cancelled_open();
    cancel_during_blocked_read(); cancel_during_blocked_read(true); cancel_during_write(); home_integration();
    std::cout << "8 audio scenario groups passed: duplex, overload, errors, cancellation and Home integration\n";
}
