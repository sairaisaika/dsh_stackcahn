#include "sion/mode_controller.h"
#include <cassert>
#include <functional>
#include <iostream>
#include <vector>
using namespace sion;
struct Fake : Effects {
    bool quiet = false;
    Result result = Result::Pending;
    int connects = 0, activates = 0, quiesces = 0;
    Backend last = Backend::Original;
    bool activated = true;
    std::function<void()> on_activate;
    void Quiesce(uint64_t) override {
        ++quiesces;
        result = Result::Pending;
    }
    bool IsQuiescent() override { return quiet; }
    void Connect(Backend b, uint64_t) override {
        ++connects;
        last = b;
    }
    Result ConnectionResult(uint64_t) override { return result; }
    bool Activate(Backend, uint64_t) override {
        ++activates;
        if (on_activate)
            on_activate();
        return activated;
    }
};
static void connect(ModeController& c, Fake& f, uint64_t now) {
    f.quiet = true;
    c.Tick(now);
    f.result = Result::Ready;
    c.Tick(now + 1);
}
int main() {
    {
        Fake f;
        ModeController c(f);
        assert(!c.Get().original_ready);
        c.FactoryReady(true);
        assert(c.Enter(0, 100));
        assert(!c.Get().original_ready);
        c.Tick(101);
        assert(f.connects == 0);
        connect(c, f, 102);
        assert(c.Get().phase == Phase::Local);
        assert(f.last == Backend::Local);
        assert(c.Renew(1, 200));
        assert(c.Leave(1, 201));
        assert(c.Get().epoch == 2);
        assert(!c.Renew(1, 202));
        connect(c, f, 203);
        assert(c.Get().original_ready);
        assert(f.last == Backend::Original);
        assert(c.Enter(2, 300));
        assert(!c.Leave(1, 301));
    }
    {
        Fake f;
        ModeController c(f);
        assert(c.Enter(0, 0));
        connect(c, f, 1);
        c.Tick(ModeController::kLeaseMs);
        assert(c.Get().selected == Backend::Original);
        assert(!c.Get().original_ready);
        assert(!c.Renew(1, ModeController::kLeaseMs));
    }
    {
        Fake f;
        ModeController c(f);
        c.Enter(0, 0);
        c.Leave(1, 1);
        c.Tick(2);
        assert(f.connects == 0);
        connect(c, f, 3);
        assert(c.Get().original_ready);
    }
    {
        Fake f;
        ModeController c(f);
        c.Enter(0, 0);
        f.quiet = true;
        c.Tick(1);
        f.result = Result::Failed;
        c.Tick(2);
        assert(c.Get().selected == Backend::Original);
        c.Tick(3);
        f.result = Result::Failed;
        c.Tick(4);
        assert(c.Get().phase == Phase::Fault);
        assert(!c.Get().original_ready);
        assert(c.ReturnOriginal(5));
        connect(c, f, 6);
        assert(c.Get().original_ready);
    }
    {
        Fake f;
        ModeController c(f);
        c.Enter(0, 0);
        connect(c, f, 1);
        c.Disconnected(0, 3);
        assert(c.Get().phase == Phase::Local);
        c.Disconnected(1, 4);
        assert(c.Get().selected == Backend::Original);
    }
    {
        Fake f;
        ModeController c(f);
        c.Enter(0, 0);
        c.Tick(20001);
        assert(c.Get().selected == Backend::Original);
        c.Tick(40002);
        assert(c.Get().phase == Phase::Fault);
        assert(f.activates == 0);
    }
    {
        Fake f;
        ModeController c(f);
        c.Enter(0, 0);
        connect(c, f, 1);
        assert(c.Renew(1, 14999));
        c.Tick(15000);
        assert(c.Get().phase == Phase::Local);
        assert(!c.Renew(1, 29999));
        c.Tick(29999);
        assert(c.Get().selected == Backend::Original);
    }
    {
        Fake f;
        ModeController c(f);
        c.Enter(0, 0);
        f.activated = false;
        connect(c, f, 1);
        assert(c.Get().selected == Backend::Original);
        connect(c, f, 3);
        assert(c.Get().phase == Phase::Fault);
        assert(!c.Get().original_ready);
        assert(f.quiesces == 3);
        f.activated = true;
        c.ReturnOriginal(5);
        connect(c, f, 6);
        assert(c.Get().original_ready);
    }
    {
        Fake f;
        ModeController c(f);
        c.Enter(0, 0);
        f.on_activate = [&] { c.Disconnected(c.Get().epoch, 3); };
        connect(c, f, 1);
        assert(c.Get().phase == Phase::Recovering);
        assert(c.Get().selected == Backend::Original);
        assert(!c.Get().original_ready);
        f.on_activate = {};
        connect(c, f, 4);
        assert(c.Get().original_ready);
    }
    std::cout << "9 mode lifecycle scenarios passed\n";
}
