// SPDX-License-Identifier: MIT
#include "ambient_engine.h"
#include <cassert>
#include <cstdio>

using namespace sion::agent;

int main() {
    const HeadTouchSample idle{0, 0, 0};
    const HeadTouchSample light{0, 1, 0};
    {
        HeadTouchGestures startup;
        startup.Observe(idle, 0);
        startup.Observe(idle, 50);
        startup.Observe(light, 100);
        startup.Observe(light, 150);
        for (uint64_t now = 200; now <= 350; now += 50) startup.Observe(idle, now);
        assert(startup.Next(0, 350).sequence == 0); // An unstable startup baseline cannot arm a tap.
        startup.Observe(light, 400);
        startup.Observe(light, 450);
        startup.Observe(idle, 500);
        startup.Observe(idle, 550);
        assert(startup.Next(0, 550).kind == HeadTouchKind::Tap && startup.Next(0, 550).sequence == 1);
    }
    {
        HeadTouchGestures sparse;
        for (uint64_t now = 0; now <= 150; now += 50) sparse.Observe(idle, now);
        sparse.Observe(light, 200);
        sparse.Observe(light, 250);
        sparse.Observe(idle, 400); // Several missed polls could conceal another contact.
        sparse.Observe(idle, 450);
        assert(sparse.Next(0, 450).sequence == 0);
        sparse.Observe(light, 500);
        sparse.Observe(light, 550);
        for (uint64_t now = 600; now <= 750; now += 50) sparse.Observe(idle, now);
        assert(sparse.Next(0, 750).sequence == 0); // Two idle readings after the gap still do not arm it.
        sparse.Observe(light, 800);
        sparse.Observe(light, 850);
        sparse.Observe(idle, 900);
        sparse.Observe(idle, 950);
        assert(sparse.Next(0, 950).sequence == 1);
    }
    HeadTouchGestures touch;
    uint64_t now = 0;
    const auto read = [&](HeadTouchSample sample) { touch.Observe(sample, now); now += 50; };
    const auto release = [&] { read(idle); read(idle); };
    const auto settle = [&] { for (int sample = 0; sample < 4; ++sample) read(idle); };
    // Holding the head while the session starts must not turn the release into a tap.
    for (int sample = 0; sample < 8; ++sample) read({3, 0, 0});
    settle();
    assert(touch.Next(0, now).sequence == 0);
    read({0, 3, 0}); // Even a strong single-sample spike is ignored.
    release();
    assert(touch.Next(0, now).sequence == 0);
    read({0, 1, 0}); read({0, 1, 0});
    read(idle); // A single idle glitch must not end the gesture.
    read({0, 1, 0});
    release();
    const auto tap = touch.Next(0, now);
    assert(tap.sequence == 1 && tap.kind == HeadTouchKind::Tap && tap.peak == 1 && tap.duration_ms == 200);

    read({0, 1, 0}); read({0, 1, 0}); read({0, 1, 0}); // Contact returns before re-arm.
    release();
    read({0, 3, 0}); read({0, 3, 0}); release(); // A brief gap restarts the quiet period.
    assert(touch.Next(1, now).sequence == 0);
    settle();
    read({0, 1, 0}); read({0, 1, 0}); release();
    const auto short_tap = touch.Next(1, now);
    assert(short_tap.sequence == 2 && short_tap.kind == HeadTouchKind::Tap &&
           short_tap.peak == 1 && short_tap.duration_ms == 100);
    settle();

    read({2, 0, 0}); read({2, 0, 0});
    read({0, 3, 1}); read({0, 0, 1});
    release();
    const auto forward = touch.Next(2, now);
    assert(forward.sequence == 3 && forward.kind == HeadTouchKind::TowardChannel3 && forward.peak == 3);
    settle();
    read({0, 0, 3}); read({0, 0, 3});
    read({2, 0, 0}); read({2, 0, 0});
    release();
    assert(touch.Next(3, now).kind == HeadTouchKind::TowardChannel1);
    settle();

    for(int sample=0;sample<8;++sample)read(sample==2 ? HeadTouchSample{3,0,0} : HeadTouchSample{0,2,0});
    release();
    const auto hold = touch.Next(4, now);
    assert(hold.sequence == 5 && hold.kind == HeadTouchKind::Hold && hold.duration_ms == 400);
    settle();

    read({0, 2, 0}); read({0, 2, 0});
    read({}); // Read failure invalidates unfinished gesture only.
    read({3, 0, 0}); read({3, 0, 0}); settle();
    assert(touch.Next(0, now).sequence == 2 && touch.Next(5, now).sequence == 0);
    read({1, 0, 0}); read({1, 0, 0}); settle();
    assert(touch.Next(0, now).sequence == 3); // Only the four most recent outcomes survive.
    assert(touch.Next(0, now+3000).sequence == 0);

    read({3, 0, 0}); read({3, 0, 0});
    now += 250; // A stalled sampler cannot complete a gesture even with a release.
    settle();
    assert(touch.Next(6, now).sequence == 0);
    read({3, 0, 0}); read({3, 0, 0});
    now += 350; // A stalled sampler cannot turn isolated contacts into a swipe.
    read({0, 0, 3}); read({0, 0, 3}); // Contact across the gap is not a swipe.
    settle();
    assert(touch.Next(6, now).sequence == 0);
    assert(touch.Next(5, now).sequence == 6); // Previously completed events still expire normally.
    read({0, 1, 0}); read({0, 1, 0}); release();
    const auto fresh = touch.Next(6, now);
    assert(fresh.kind == HeadTouchKind::Tap && fresh.sequence == 7);

    struct Port : HeadTouchPort {
        HeadTouchSample reading{0, 0, 0};
        bool Open() override { return true; }
        HeadTouchSample Read() override { return reading; }
        bool Close() override { return true; }
    } port;
    HeadTouchEngine engine(port);
    const auto next = [](const HeadTouchGestures& observer) { return observer.Next(0, 2000); };
    engine.Begin(1);
    engine.Pump(0);
    engine.Pump(200);
    engine.Pump(250);
    engine.Pump(300);
    engine.Pump(350);
    port.reading = {1, 0, 0};
    engine.Pump(400);
    engine.Pump(450);
    port.reading = idle;
    engine.Pump(500);
    engine.Pump(550);
    assert(engine.Inspect(1, next).sequence == 1);
    engine.Stop(2);
    assert(engine.Inspect(1, next).sequence == 0);
    engine.Pump(560);
    engine.Begin(3);
    engine.Pump(570);
    assert(engine.Inspect(3, next).sequence == 0);

    // Local watch between sessions: readable under the idle fence, taken over
    // by the next session without reopening, and never able to outlive a Stop.
    struct Counted : HeadTouchPort {
        int opens = 0, closes = 0;
        bool open_ok = true;
        bool Open() override { ++opens; return open_ok; }
        HeadTouchSample Read() override { return {2, 0, 0}; }
        bool Close() override { ++closes; return true; }
    } counted;
    HeadTouchEngine watch(counted);
    watch.Watch(0);
    watch.Pump(0); watch.Pump(200);
    assert(counted.opens == 1 && watch.Snapshot(0, 210).channel1 == 2);
    assert(watch.Snapshot(1, 210).channel1 == -1); // A session epoch never reads watch samples.
    watch.Begin(1); // The session adopts the open sensor.
    assert(watch.Snapshot(1, 210).channel1 == -1);
    watch.Pump(260);
    assert(counted.opens == 1 && counted.closes == 0 && watch.Snapshot(1, 270).channel1 == 2);
    watch.Unwatch(); // Not a watch any more: only the session fence closes it.
    watch.Pump(320);
    assert(counted.closes == 0);
    watch.Stop(2); watch.Pump(330);
    assert(counted.closes == 1 && watch.Stopped(2) == Result::Done);
    watch.Watch(1); // A fence older than the last Stop cannot reopen it.
    watch.Pump(340);
    assert(counted.opens == 1);
    watch.Watch(2); watch.Pump(350); watch.Pump(560);
    assert(counted.opens == 2 && watch.Snapshot(2, 570).channel1 == 2);
    watch.Unwatch();
    assert(watch.Snapshot(2, 570).channel1 == -1);
    watch.Begin(3); // Arrives while the watch is still closing: reopen for the session.
    watch.Pump(580);
    assert(counted.closes == 2 && watch.Stopped(3) == Result::Pending);
    watch.Pump(590); watch.Pump(800);
    assert(counted.opens == 3 && watch.Snapshot(3, 810).channel1 == 2);
    watch.Stop(4); watch.Pump(820);
    assert(counted.closes == 3 && watch.Stopped(4) == Result::Done);
    counted.open_ok = false;
    watch.Watch(4); watch.Pump(830); watch.Pump(840);
    assert(counted.opens == 4 && counted.closes == 4 && watch.Stopped(4) == Result::Done);
    watch.Stop(5); // A failed watch leaves nothing for the next fence to wait on.
    assert(watch.Stopped(5) == Result::Done);
    std::puts("Head touch: debounce, quiet re-arm, light tap, hold, both directions, failed or stale samples, bounded history, epoch reset and local watch handover passed");
}
