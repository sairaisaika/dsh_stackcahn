#include "sion/preservation_policy.h"
#include <cassert>
#include <iostream>
using sion::TrialPolicy;
int main() {
    for (const char* ns : {"board", "wifi", "mqtt", "websocket", "assets", "account", "app_config"})
        assert(sion::ProtectedNamespace(ns));
    for (const char* ns : {"sion_pair", "warm_boot", "audio", "display", "wifi_other"})
        assert(!sion::ProtectedNamespace(ns));
    int commits = 0;
    auto commit = [&] { ++commits; return true; };
    TrialPolicy p("boot", "image", 100);
    assert(!p.Confirm("old", "image", true, 101, commit));
    assert(!p.Confirm("boot", "other", true, 101, commit));
    assert(!p.Confirm("boot", "image", false, 101, commit));
    assert(commits == 0);
    assert(p.Confirm("boot", "image", true, 101, commit));
    assert(p.state() == TrialPolicy::State::Confirmed);
    assert(!p.Confirm("boot", "image", true, 102, commit));
    assert(!p.Expire(1000000));
    assert(commits == 1);
    TrialPolicy expired("boot", "image", 100);
    assert(!expired.Expire(100 + TrialPolicy::DurationMs - 1));
    assert(!expired.Confirm("boot", "image", true, 100 + TrialPolicy::DurationMs, commit));
    assert(expired.Expire(100 + TrialPolicy::DurationMs));
    assert(!expired.Expire(100 + TrialPolicy::DurationMs + 1));
    assert(!expired.Confirm("boot", "image", true, 101, commit));
    TrialPolicy failed("boot", "image", 0);
    assert(!failed.Confirm("boot", "image", true, 1, [] { return false; }));
    assert(failed.state() == TrialPolicy::State::Fault);
    assert(!failed.Confirm("boot", "image", true, 2, commit));
    assert(!failed.Expire(1000000));
    assert(commits == 1);
    std::cout << "Trial policy: identity, attestation, deadline, replay, failed commit and namespace boundaries passed\n";
}
