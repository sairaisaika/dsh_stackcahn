// SPDX-License-Identifier: MIT
#include "motion_engine.h"
#include <algorithm>
#include <cassert>
#include <condition_variable>
#include <cstdio>
#include <functional>
#include <thread>
#include <vector>
using namespace sion::agent;
struct Port final:MotionPort {
    int opened=0,moved=0,polled=0,released=0;
    bool open_ok=true,move_ok=true;
    Result poll_result=Result::Done,release_result=Result::Done;
    MotionFeedback sample{0,450,false,false};
    std::function<void()> on_open,on_move,on_poll,on_release;
    bool Open() override {++opened;if(on_open)on_open();return open_ok;}
    bool Move(const MotionTarget& t) override {assert(ValidMotionTarget(t));++moved;if(on_move)on_move();return move_ok;}
    Result Poll(MotionFeedback& out) override {++polled;if(on_poll)on_poll();out=sample;return poll_result;}
    Result Release() override {++released;if(on_release)on_release();return release_result;}
    int torqued=0,sensed=0;bool torque_ok=true,sense_ok=true,last_torque=false;
    std::vector<MotionTarget> targets;
    bool Torque(bool on) override {++torqued;last_torque=on;return torque_ok;}
    bool Sense(MotionSense& s) override {++sensed;s.yaw.angle=sample.yaw;s.pitch.angle=sample.pitch;s.pitch.temperature=31;s.yaw.load=yaw_load;return sense_ok;}
    std::vector<int> rotations;int yaw_load=0;bool rotate_ok=true;
    bool Rotate(int v) override {rotations.push_back(v);return rotate_ok;}
};
// Feedback that reports each commanded frame as reached.
struct Follow final:MotionPort {
    MotionTarget at{};int opened=0,released=0;std::vector<MotionTarget> targets;
    bool Open() override{++opened;return true;}
    bool Move(const MotionTarget& t) override{targets.push_back(t);at=t;return true;}
    Result Poll(MotionFeedback& f) override{f={at.yaw,at.pitch,false,false};return Result::Done;}
    Result Release() override{++released;return Result::Done;}
};
static MotionRequest Frames(std::initializer_list<MotionTarget> list,uint32_t hold=0,bool torque=true) {
    MotionRequest r;r.count=0;for(const auto& t:list)r.frames[r.count++]=t;r.hold_ms=hold;r.torque=torque;return r;
}
// Pump until the engine stops changing or `limit` ms pass, 10 ms per step.
static uint64_t Run(MotionEngine& e,uint64_t from,uint64_t limit) {
    uint64_t t=from;for(;t<from+limit;t+=10)e.Pump(t);return t;
}
static uint64_t start(MotionEngine& e,uint64_t now=0) {
    e.AllowMotion(true);const auto t=e.Begin(1,{},now);assert(t);
    e.Pump(now);e.Pump(now+1);return t;
}
int main() {
    { // Default permission, bounds, single result, and observation after release.
        Port p;MotionEngine e(p);MotionOutcome out;
        assert(!e.Begin(1,{},0));e.AllowMotion(true);assert(!e.Begin(0,{},0));
        for(auto t:{MotionTarget{-1281,450,500},MotionTarget{1281,450,500},
                    MotionTarget{0,49,500},MotionTarget{0,651,500},
                    MotionTarget{0,450,99},MotionTarget{0,450,3001}})assert(!e.Begin(1,t,0));
        assert(p.opened==0);auto ticket=e.Begin(1,{},0);assert(ticket&&!e.Begin(1,{},0));
        e.Pump(0);e.Pump(1);assert(p.moved==1&&!e.Take(1,ticket,out));
        e.Pump(2);e.Pump(51);assert(p.polled==1);e.Pump(52);
        assert(e.status().phase==MotionPhase::Releasing&&!e.Take(1,ticket,out));
        p.release_result=Result::Pending;e.Pump(53);assert(!e.Take(1,ticket,out));
        p.release_result=Result::Done;e.Pump(54);assert(!e.Begin(1,{},55));
        assert(!e.Take(2,ticket,out)&&!e.Take(1,ticket+1,out));
        assert(e.Take(1,ticket,out)&&out.observed&&out.feedback.pitch==450&&out.error==MotionError::None);
        assert(!e.Take(1,ticket,out));assert(e.Begin(1,{-1280,50,100},56)>ticket);
        e.Cancel(1,ticket);assert(e.status().phase==MotionPhase::Opening);
        e.Stop(2);e.Pump(57);assert(e.Stopped(2)==Result::Done&&!e.Begin(2,{},58));
        assert(e.Begin(3,{1280,650,3000},58));e.Stop(1);e.Pump(58);assert(p.opened==2);
        e.Stop(4);e.Pump(59);assert(e.Stopped(4)==Result::Done);
    }
    { // One good sample is insufficient; moving, Pending and off-target reset it.
        for(int variant=0;variant<3;++variant) {
            Port p;MotionEngine e(p);auto t=start(e);MotionOutcome out;
            e.Pump(2);
            if(variant==0)p.sample.moving=true;
            if(variant==1)p.sample.yaw=21;
            if(variant==2)p.poll_result=Result::Pending;
            e.Pump(52);p.sample={20,430,false,false};p.poll_result=Result::Done;
            e.Pump(102);assert(e.status().phase==MotionPhase::Moving);
            e.Pump(152);e.Pump(153);assert(e.Take(1,t,out)&&out.error==MotionError::None);
        }
    }
    { // Failure at each hardware stage is withheld until confirmed release.
        for(int variant=0;variant<6;++variant) {
            Port p;MotionEngine e(p);MotionOutcome out;MotionError expected;
            if(variant==0){p.open_ok=false;expected=MotionError::Open;}
            else if(variant==1){p.move_ok=false;expected=MotionError::Command;}
            else if(variant==2){p.poll_result=Result::Failed;expected=MotionError::Feedback;}
            else if(variant==3){p.sample.pitch=901;expected=MotionError::Feedback;}
            else if(variant==4){p.sample.yaw=std::numeric_limits<int>::min();expected=MotionError::Feedback;}
            else {p.sample.stalled=true;expected=MotionError::Stall;}
            e.AllowMotion(true);auto t=e.Begin(1,{},0);
            e.Pump(0);if(variant>0)e.Pump(1);if(variant>1)e.Pump(2);
            assert(e.status().phase==MotionPhase::Releasing&&!e.Take(1,t,out));
            e.Pump(3);assert(p.released==1&&e.Take(1,t,out)&&out.error==expected);
            assert(p.moved==(variant==0?0:1));
        }
    }
    { // Deadline and ANY backward worker clock, including reversal after start.
      // A frame's deadline is its duration plus the grace, from the move command (101).
        for(int variant=0;variant<4;++variant) {
            Port p;MotionEngine e(p);MotionOutcome out;
            auto t=start(e,100);p.poll_result=Result::Pending;e.Pump(200);
            e.Pump(variant==0?4101:variant==1?99:variant==2?199:4100);
            if(variant==3){assert(e.status().phase==MotionPhase::Moving);e.Pump(4101);}
            assert(e.Take(1,t,out)&&out.error==MotionError::Timeout&&p.released==1);
        }
    }
    { // Stop can run inside every hardware call; no old completion is published.
        for(int step=0;step<4;++step) {
            Port p;MotionEngine e(p);MotionOutcome out;
            auto stop=[&]{e.Stop(2);assert(e.Stopped(2)==Result::Pending);};
            if(step==0)p.on_open=stop;else if(step==1)p.on_move=stop;
            else if(step==2)p.on_poll=stop;else p.on_release=stop;
            auto t=start(e);e.Pump(2);e.Pump(52);e.Pump(53);e.Pump(54);
            assert(e.Stopped(2)==Result::Done&&!e.Take(1,t,out)&&p.released==1);
            assert(p.moved==(step==0?0:1));
        }
    }
    { // Stop before the first worker call performs no hardware I/O.
        Port p;MotionEngine e(p);e.AllowMotion(true);e.Begin(1,{},0);e.Stop(2);e.Pump(1);
        assert(e.Stopped(2)==Result::Done&&p.opened==0&&p.moved==0&&p.released==0);
    }
    { // Release failure is sticky; only explicit cancellation/Stop retries it.
        Port p;MotionEngine e(p);auto t=start(e);MotionOutcome out;
        p.release_result=Result::Failed;e.Stop(2);e.Pump(2);
        assert(e.Stopped(2)==Result::Failed&&!e.Take(1,t,out)&&!e.Begin(3,{},3));
        e.Pump(3);assert(p.released==1);p.release_result=Result::Pending;
        e.Stop(2);e.Pump(4);assert(e.Stopped(2)==Result::Pending);
        p.release_result=Result::Done;e.Pump(5);assert(e.Stopped(2)==Result::Done);
        assert(e.Begin(3,{},6));e.Stop(4);e.Pump(6);
    }
    { // Ready results are revoked by permission changes or Stop before Take.
        for(bool disable:{false,true}) {
            Port p;MotionEngine e(p);auto t=start(e);MotionOutcome out;
            e.Pump(2);e.Pump(52);e.Pump(53);assert(e.status().result_ready);
            if(disable)e.AllowMotion(false);else e.Stop(2);
            assert(!e.Take(1,t,out));
        }
    }
    { // Real worker/control concurrency at each blocking port method. Reallowing
      // during old I/O cannot revive its ticket or admit another command.
        for(int step=0;step<4;++step) {
            Port p;MotionEngine e(p);MotionOutcome out;
            std::mutex m;std::condition_variable cv;bool entered=false,resume=false;
            auto block=[&]{std::unique_lock<std::mutex> lock(m);entered=true;cv.notify_all();cv.wait(lock,[&]{return resume;});};
            e.AllowMotion(true);auto t=e.Begin(1,{},0);
            if(step>0)e.Pump(0);
            if(step>1)e.Pump(1);
            if(step>2){e.Pump(2);e.Pump(52);}
            if(step==0)p.on_open=block;else if(step==1)p.on_move=block;
            else if(step==2)p.on_poll=block;else p.on_release=block;
            std::thread worker([&]{e.Pump(53);});
            {std::unique_lock<std::mutex> lock(m);cv.wait(lock,[&]{return entered;});}
            e.AllowMotion(false);assert(e.status().phase==MotionPhase::Releasing);
            e.AllowMotion(true);assert(!e.Begin(1,{},54)&&!e.Take(1,t,out));
            {std::lock_guard<std::mutex> lock(m);resume=true;cv.notify_all();}worker.join();
            e.Pump(54);assert(!e.Take(1,t,out)&&e.status().phase==MotionPhase::Idle);
            assert(e.Begin(1,{},55)>t);e.Stop(2);e.Pump(55);
            assert(e.Stopped(2)==Result::Done&&p.released==1);
        }
    }
    { // Keyframes run in order on one open port; one result after the last frame.
        Follow p;MotionEngine e(p);e.AllowMotion(true);MotionOutcome out;
        const auto t=e.BeginRequest(1,Frames({{200,450,300},{-200,450,300},{0,300,300}}),0);assert(t);
        Run(e,0,2000);
        assert(p.opened==1&&p.released==1&&p.targets.size()==3&&p.targets[1].yaw==-200);
        assert(e.Take(1,t,out)&&out.error==MotionError::None&&out.feedback.pitch==300&&!out.holding);
        MotionRequest bad=Frames({{0,450,300}});bad.count=0;assert(!e.BeginRequest(1,bad,3000));
        bad.count=kMaxMotionFrames+1;assert(!e.BeginRequest(1,bad,3000));
        assert(!e.BeginRequest(1,Frames({{0,450,300},{0,651,300}}),3000));   // Every frame is checked.
        assert(!e.BeginRequest(1,Frames({{0,450,300}},kMaxHoldMs+1),3000));
    }
    { // Holding: the result comes at once, the port stays open, a follow-up skips
      // Open, and power is released when the hold expires.
        Follow p;MotionEngine e(p);e.AllowMotion(true);MotionOutcome out;
        auto t=e.BeginRequest(1,Frames({{100,450,300}},1000),0);
        uint64_t now=Run(e,0,500);
        assert(e.status().phase==MotionPhase::Holding&&e.Take(1,t,out)&&out.holding&&p.released==0);
        t=e.BeginRequest(1,Frames({{-100,450,300}},1000),now);assert(t);
        now=Run(e,now,500);
        assert(p.opened==1&&p.targets.size()==2&&e.Take(1,t,out)&&out.holding);
        assert(!e.BeginRequest(2,Frames({{0,450,300}}),now));                // Another epoch must wait.
        now=Run(e,now,1100);
        assert(e.status().phase==MotionPhase::Idle&&p.released==1&&!e.Take(1,t,out));
    }
    { // Stop and permission loss end a hold.
        for(bool stop:{true,false}) {
            Follow p;MotionEngine e(p);e.AllowMotion(true);
            e.BeginRequest(1,Frames({{0,450,300}},60000),0);Run(e,0,500);
            assert(e.status().phase==MotionPhase::Holding);
            if(stop)e.Stop(2);else e.AllowMotion(false);
            e.Pump(600);assert(e.status().phase==MotionPhase::Idle&&p.released==1);
        }
    }
    { // Torque: limp-but-powered, hold present pose, or release; read from idle or while held.
        Port p;MotionEngine e(p);e.AllowMotion(true);MotionOutcome out;
        MotionRequest limp;limp.kind=MotionKind::Torque;limp.count=0;limp.torque=false;limp.hold_ms=5000;
        auto t=e.BeginRequest(1,limp,0);assert(t);e.Pump(0);e.Pump(1);
        assert(p.torqued==1&&!p.last_torque&&e.status().phase==MotionPhase::Holding&&e.Take(1,t,out)&&out.observed);
        MotionRequest sense;sense.kind=MotionKind::Sense;sense.count=0;sense.hold_ms=5000;
        t=e.BeginRequest(1,sense,10);e.Pump(10);
        assert(p.opened==1&&p.sensed==1&&e.Take(1,t,out)&&out.sensed&&out.sense.pitch.temperature==31&&out.holding);
        MotionRequest peek;peek.kind=MotionKind::Sense;peek.count=0;         // hold_ms 0: keep the running hold.
        t=e.BeginRequest(1,peek,15);e.Pump(15);
        assert(p.sensed==2&&e.status().phase==MotionPhase::Holding&&e.Take(1,t,out)&&out.holding);
        p.sense_ok=false;t=e.BeginRequest(1,peek,16);e.Pump(16);                // v69: a failed read keeps the hold.
        assert(e.status().phase==MotionPhase::Holding&&e.Take(1,t,out)&&out.error==MotionError::Sense&&out.holding);
        p.sense_ok=true;
        MotionRequest release;release.kind=MotionKind::Torque;release.count=0;release.torque=false;
        t=e.BeginRequest(1,release,20);e.Pump(20);e.Pump(21);
        assert(e.status().phase==MotionPhase::Idle&&p.released==1&&e.Take(1,t,out));
        MotionRequest once;once.kind=MotionKind::Sense;once.count=0;
        t=e.BeginRequest(1,once,30);e.Pump(30);e.Pump(31);e.Pump(32);
        assert(p.opened==2&&p.released==2&&e.Take(1,t,out)&&out.sensed&&!out.holding);
        MotionRequest wrong=once;wrong.count=1;assert(!e.BeginRequest(1,wrong,40));
        p.sense_ok=false;t=e.BeginRequest(1,once,40);e.Pump(40);e.Pump(41);e.Pump(42);
        assert(e.Take(1,t,out)&&out.error==MotionError::Sense);
        p.torque_ok=false;t=e.BeginRequest(1,limp,50);e.Pump(50);e.Pump(51);e.Pump(52);
        assert(e.Take(1,t,out)&&out.error==MotionError::Torque&&e.status().phase==MotionPhase::Idle);
    }
    { // v68: pressed against the body, no load threshold fired. No progress past the
      // requested time plus grace, while off target, is a stall well before the deadline.
        Port p;MotionEngine e(p);e.AllowMotion(true);MotionOutcome out;
        p.sample={0,600,true,false};
        auto t=e.BeginRequest(1,Frames({{0,650,800}}),0);
        e.Pump(0);e.Pump(1);
        uint64_t now=2;
        for(;now<3000&&e.status().phase==MotionPhase::Moving;now+=50)e.Pump(now);
        assert(now<=1300);                                // 800 ms + 400 ms grace + one window.
        e.Pump(now);assert(e.Take(1,t,out)&&out.error==MotionError::Stall);
        // Slow but real progress is not a stall.
        Port q;MotionEngine f(q);f.AllowMotion(true);
        q.sample={0,100,true,false};
        f.BeginRequest(1,Frames({{0,650,800}}),0);f.Pump(0);f.Pump(1);
        for(uint64_t at=2;at<2500;at+=50){q.sample.pitch=std::min(640,q.sample.pitch+12);f.Pump(at);}
        assert(f.status().phase==MotionPhase::Moving);
    }
    { // Yaw rotation: turn for the requested time, stop, then release or hold.
        Port p;MotionEngine e(p);e.AllowMotion(true);MotionOutcome out;
        MotionRequest r;r.kind=MotionKind::Rotate;r.count=0;r.velocity=-400;r.rotate_ms=1000;
        auto t=e.BeginRequest(1,r,0);assert(t);
        for(uint64_t now=0;now<=1100;now+=50)e.Pump(now);
        e.Pump(1150);
        assert((p.rotations==std::vector<int>{-400,0})&&p.released==1&&e.Take(1,t,out)&&out.error==MotionError::None);
        r.hold_ms=3000;r.torque=true;t=e.BeginRequest(1,r,2000);
        for(uint64_t now=2000;now<=3200;now+=50)e.Pump(now);
        assert(p.torqued==1&&p.last_torque&&e.status().phase==MotionPhase::Holding&&e.Take(1,t,out)&&out.holding);
        e.Stop(2);e.Pump(3300);assert(e.status().phase==MotionPhase::Idle);
        MotionRequest bad=r;bad.velocity=0;assert(!e.BeginRequest(3,bad,4000));
        bad=r;bad.velocity=1001;assert(!e.BeginRequest(3,bad,4000));
        bad=r;bad.rotate_ms=kMaxRotateMs+1;assert(!e.BeginRequest(3,bad,4000));
        bad=r;bad.count=1;assert(!e.BeginRequest(3,bad,4000));
    }
    { // Turning against something heavy stops; cancelling mid-turn stops first.
        Port p;MotionEngine e(p);e.AllowMotion(true);MotionOutcome out;p.yaw_load=-900;
        MotionRequest r;r.kind=MotionKind::Rotate;r.count=0;r.velocity=300;r.rotate_ms=5000;
        auto t=e.BeginRequest(1,r,0);
        for(uint64_t now=0;now<=600;now+=50)e.Pump(now);
        e.Pump(650);
        assert(e.Take(1,t,out)&&out.error==MotionError::Stall&&p.rotations.back()==0);
        Port q;MotionEngine f(q);f.AllowMotion(true);
        t=f.BeginRequest(1,r,0);f.Pump(0);f.Pump(1);f.Cancel(1,t);f.Pump(2);
        assert((q.rotations==std::vector<int>{300,0})&&q.released==1&&f.status().phase==MotionPhase::Idle);
    }
    { // Setpoints while holding with torque on: newest wins, no result, hold still ends.
        Follow p;MotionEngine e(p);e.AllowMotion(true);MotionOutcome out;
        assert(!e.Setpoint(1,{100,450,100}));                                   // Not holding yet.
        auto t=e.BeginRequest(1,Frames({{0,450,300}},2000),0);uint64_t now=Run(e,0,500);
        assert(e.Take(1,t,out)&&e.status().phase==MotionPhase::Holding);
        assert(e.Setpoint(1,{100,450,100})&&e.Setpoint(1,{200,400,100}));
        e.Pump(now);assert(p.targets.back().yaw==200&&p.targets.size()==2&&e.SetpointsApplied()==1);
        e.Pump(now+10);assert(p.targets.size()==2);                             // Nothing new: nothing sent.
        assert(!e.Setpoint(2,{0,450,100})&&!e.Setpoint(1,{0,651,100}));        // Other epoch, out of range.
        assert(!e.Take(1,t,out));                                               // Setpoints publish nothing.
        Run(e,now+20,2100);assert(e.status().phase==MotionPhase::Idle&&!e.Setpoint(1,{0,450,100}));
        // Limp holds take no setpoints.
        MotionRequest limp;limp.kind=MotionKind::Torque;limp.count=0;limp.torque=false;limp.hold_ms=1000;
        e.BeginRequest(1,limp,5000);Run(e,5000,100);assert(!e.Setpoint(1,{0,450,100}));
    }
    std::puts("Motion core: bounds/permission, fresh paired feedback, release confirmation, timeout, faults and concurrent cancellation, keyframes, hold/limp/read, yaw rotation and no-progress stall passed; fake port, no device.");
}
