// SPDX-License-Identifier: MIT
#include "ring_engine.h"
#include <cassert>
#include <cstdio>
#include <functional>

using namespace sion::agent;

struct Port : RingPort {
    int opens = 0, shows = 0, closes = 0;
    bool open = false, write_ok = true, close_ok = true;
    RingFrame frame{};
    std::function<void()> on_show;
    bool Open() override { assert(!open); ++opens; return open = true; }
    bool Show(const RingFrame& value) override {
        assert(open);
        ++shows;
        frame = value;
        if (on_show) on_show();
        return write_ok;
    }
    bool Close() override {
        ++closes;
        if (!close_ok) return false;
        open = false;
        frame = {};
        return true;
    }
};

// Pumps the worker every 20 ms (its 50 Hz step) and returns the next time.
static uint64_t Run(RingEngine& ring, uint64_t from, uint64_t ms) {
    for (uint64_t t = from; t < from + ms; t += 20) ring.Pump(t);
    return from + ms;
}

int main() {
    const RingColor manual{24,0,16}, black{};
    Port port;
    RingEngine ring(port);
    ring.Indicate(1,RingIndicator::Listening);
    ring.Pump(0);
    assert(!port.open);
    ring.Allow(true);
    ring.Pump(1);
    assert(port.opens==1&&ring.status().phase==RingPhase::Idle&&ring.status().indicator);
    // Fades in rather than switching: early frames are a fraction of the target.
    uint64_t now=Run(ring,21,40);
    assert(port.shows>=1&&port.frame[0].green>0&&port.frame[0].green<16&&port.frame[6]==black);
    now=Run(ring,now,600);
    assert(port.frame[0].green==16&&port.frame[5].blue==16&&port.frame[11]==black);  // Settled in ~0.3 s.
    const int settled=port.shows;
    now=Run(ring,now,200);
    assert(port.shows==settled);  // A steady colour adds no I2C writes.
    ring.Indicate(1,RingIndicator::Listening,0,16);  // The owner speaks: the ear lifts.
    now=Run(ring,now,600);
    assert(port.frame[0].green==64&&port.frame[5].green==64&&port.frame[6]==black);
    ring.Indicate(1,RingIndicator::Listening,0,4);   // Quiet: only the lowest LEDs stay lifted.
    now=Run(ring,now,600);
    assert(port.frame[0].green>port.frame[5].green&&port.frame[5].green==16);

    ring.Indicate(1,RingIndicator::Waiting);
    now=Run(ring,now,1200);
    bool left=false,right=false;
    for(int i=0;i<60;++i){now=Run(ring,now,20);left|=port.frame[0].red>=32;right|=port.frame[11].red>=32;}
    assert(left&&right);  // The light travels from the ear strip to the voice strip.
    assert(port.frame[3].blue==0&&port.frame[3].red>=8);

    ring.Indicate(1,RingIndicator::Speaking,32);
    now=Run(ring,now,600);
    assert(port.frame[11].blue==72&&port.frame[11].green==56&&port.frame[0]==(RingColor{0,4,16}));
    ring.Indicate(1,RingIndicator::Speaking,0);  // Between syllables the voice rests dim, not dark.
    now=Run(ring,now,600);
    assert(port.frame[11]==(RingColor{0,8,24}));
    ring.Indicate(1,RingIndicator::Speaking,32);
    now=Run(ring,now,600);
    assert(ring.Begin(1,{manual,250})==RingResult::None);
    ring.Pump(now+1);ring.Pump(now+2);
    assert(port.opens==1&&port.frame[0]==manual&&port.frame[11]==manual);
    ring.Pump(now+252);
    assert(!port.open&&ring.Take(1)==RingResult::Completed);
    now=Run(ring,now+253,600);
    assert(port.opens==2&&port.frame[11].blue==72);  // Indicator resumes after a manual effect.

    // Off fades out before the port is released.
    ring.Indicate(1,RingIndicator::Off);
    ring.Pump(now);
    assert(port.open&&port.frame[11].blue>0&&port.frame[11].blue<72);
    now=Run(ring,now+20,600);
    assert(!port.open&&port.closes==2&&ring.status().phase==RingPhase::Idle&&!ring.status().indicator);
    ring.Indicate(1,RingIndicator::Waiting);
    now=Run(ring,now,100);
    assert(port.open&&port.opens==3);
    port.on_show=[&]{ring.Stop(2);assert(ring.Stopped(2)==Result::Pending);};
    ring.Indicate(1,RingIndicator::Waiting,0,1);
    ring.Pump(now);
    port.on_show={};
    port.close_ok=false;
    ring.Pump(now+1);
    assert(ring.Stopped(2)==Result::Failed&&port.open);
    port.close_ok=true;
    ring.Stop(2);
    ring.Pump(now+2);
    assert(ring.Stopped(2)==Result::Done&&!port.open&&port.frame[0]==black);  // Stop cuts at once.
    ring.Indicate(1,RingIndicator::Speaking,32);
    ring.Pump(now+40);
    assert(!port.open&&port.opens==3);

    port.write_ok=false;
    ring.Indicate(3,RingIndicator::Listening);
    ring.Pump(now+100);
    ring.Pump(now+101);
    assert(!port.open&&ring.status().error==RingResult::Write);
    ring.Pump(now+200);
    assert(!port.open&&port.opens==4);
    port.write_ok=true;
    assert(ring.Begin(3,{manual,250})==RingResult::None);
    ring.Pump(now+210);ring.Pump(now+220);ring.Pump(now+470);
    assert(!port.open&&ring.Take(3)==RingResult::Completed);
    { // Frames of individual LEDs, each for its own time, scaled by brightness.
        Port port;RingEngine ring(port);ring.Allow(true);
        RingEffect effect;effect.count=3;effect.brightness=128;
        effect.frames[0][0]={255,0,0};effect.frames[0][11]={0,0,254};effect.frame_ms[0]=100;
        effect.frames[1][5]={0,200,0};effect.frame_ms[1]=50;
        effect.frames[2].fill({255,255,255});effect.frame_ms[2]=30;
        assert(ring.Begin(1,effect)==RingResult::None);
        ring.Pump(0);ring.Pump(1);
        assert(port.frame[0].red==128&&port.frame[11].blue==127&&port.frame[5]==RingColor{});
        ring.Pump(100);ring.Pump(101);
        assert(port.frame[5].green==100&&port.frame[0]==RingColor{});
        ring.Pump(150);ring.Pump(151);assert(port.frame[3].red==128);
        ring.Pump(181);ring.Pump(182);
        assert(ring.Take(1)==RingResult::Completed&&!port.open&&port.shows==3);
        RingEffect bad=effect;bad.frame_ms[1]=19;assert(ring.Begin(2,bad)==RingResult::Invalid);
        bad=effect;bad.count=kRingFrames+1;assert(ring.Begin(2,bad)==RingResult::Invalid);
        bad=effect;bad.frame_ms={5000,5000,1};assert(ring.Begin(2,bad)==RingResult::Invalid);   // Over 10 s in total.
    }
    std::puts("Ring indicators: permission, eased fades, ear/voice strips, travelling wait, fade-out, manual takeover, failed write, Stop during I/O and release retry passed");
}
