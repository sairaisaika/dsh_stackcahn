// SPDX-License-Identifier: MIT
#include "session_lifecycle.h"
#include <cassert>
#include <iostream>
using namespace sion::agent;
struct Fake : Effects {
    Result drained = Result::Pending, returned = Result::Pending;
    int stops = 0, homes = 0;
    uint64_t fence = 0;
    void StopResources(uint64_t epoch) override { ++stops; fence = epoch; }
    Result ResourcesStopped(uint64_t epoch) override { assert(epoch == fence); return drained; }
    Result ReturnHome(uint64_t epoch) override { assert(epoch == fence); ++homes; return returned; }
};
int main() {
    { // Stop fences old work, and does not turn into navigation.
        Fake f; SessionLifecycle s(f, 15, 20);
        assert(s.Begin(0)); const auto old = s.epoch();
        assert(s.Connected(old, 1)); assert(s.Accept(old, 2));
        s.Stop(3); assert(!s.Accept(old, 3)); assert(!s.Begin(3));
        assert(s.epoch() != old); s.Stop(4); assert(f.stops == 1);
        s.Tick(4); assert(s.phase() == Phase::Draining); assert(f.homes == 0);
        f.drained = Result::Done; s.Tick(5); assert(s.phase() == Phase::Idle);
        assert(s.Begin(6)); assert(s.Connected(s.epoch(), 7));
        s.Disconnected(old, 8); assert(s.phase() == Phase::Active);
        assert(!s.Renew(old, 9)); assert(!s.Accept(old, 9));
    }
    { // Home upgrades an in-flight Stop, waits for drain, then waits for return ack.
        Fake f; SessionLifecycle s(f, 15, 20);
        assert(s.Begin(0)); s.Stop(1); s.Home(2); assert(f.stops == 1);
        s.Tick(3); assert(f.homes == 0);
        f.drained = Result::Done; s.Tick(4); assert(s.phase() == Phase::Returning);
        s.Stop(5); s.Home(5); assert(f.stops == 1);
        f.returned = Result::Done; s.Tick(6); assert(s.phase() == Phase::Home);
        s.Home(7); assert(!s.Begin(7));
    }
    { // Home from idle still needs resource and navigation acknowledgment.
        Fake f; SessionLifecycle s(f); s.Home(0); assert(f.stops == 1);
        f.drained = Result::Done; f.returned = Result::Failed; s.Tick(1);
        assert(s.phase() == Phase::Fault); assert(!s.Begin(2));
        s.Home(3); f.returned = Result::Done; s.Tick(4); assert(s.phase() == Phase::Home);
    }
    { // A heartbeat or late connect cannot revive an expired lease.
        Fake f; SessionLifecycle s(f, 15, 20); assert(s.Begin(0));
        assert(!s.Connected(s.epoch(), 15)); assert(s.phase() == Phase::Draining);
        f.drained = Result::Done; s.Tick(16); assert(s.Begin(20));
        assert(s.Connected(s.epoch(), 21)); assert(s.Renew(s.epoch(), 34));
        assert(!s.Accept(s.epoch(), 49)); assert(!s.Renew(s.epoch(), 49));
        assert(s.phase() == Phase::Draining);
    }
    { // Dead Mac is handled by a device tick, not a request back to the Mac.
        Fake f; SessionLifecycle s(f, 15, 20); assert(s.Begin(0)); s.Tick(15);
        assert(f.stops == 1); s.Tick(35); assert(s.phase() == Phase::Fault);
        assert(f.homes == 0); f.drained = Result::Done; s.Stop(36); s.Tick(37);
        assert(s.phase() == Phase::Idle);
    }
    { // Explicit drain failure cannot navigate; pending navigation has its own timeout.
        Fake f; SessionLifecycle s(f, 15, 20); s.Home(0);
        f.drained = Result::Failed; s.Tick(1); assert(s.phase() == Phase::Fault); assert(f.homes == 0);
        s.Home(2); f.drained = Result::Done; s.Tick(3); s.Tick(23);
        assert(s.phase() == Phase::Fault);
    }
    std::cout << "6 device lifecycle scenarios passed (host simulation, no hardware)\n";
}
