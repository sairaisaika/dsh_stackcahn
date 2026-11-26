// SPDX-License-Identifier: MIT
#pragma once
#include <cstdint>
#include <limits>

namespace sion {
enum class Backend { Original, Local };
enum class Phase { Original, Quiescing, Connecting, Local, Recovering, Fault };
enum class Result { Pending, Ready, Failed };

// All methods execute on the application's main task. Effects must not block it.
// A failed/expired attempt never permits reuse of resources before they quiesce.
struct Effects {
    virtual ~Effects() = default;
    virtual void Quiesce(uint64_t epoch) = 0;
    virtual bool IsQuiescent() = 0;
    virtual void Connect(Backend backend, uint64_t epoch) = 0;
    virtual Result ConnectionResult(uint64_t epoch) = 0;
    virtual bool Activate(Backend backend, uint64_t epoch) = 0;
};

struct Snapshot {
    Phase phase = Phase::Original;
    Backend selected = Backend::Original;
    uint64_t epoch = 0;
    uint64_t expires_ms = 0;
    bool original_ready = false;
};

class ModeController {
public:
    static constexpr uint64_t kLeaseMs = 15000;
    static constexpr uint64_t kTransitionMs = 20000;
    explicit ModeController(Effects& effects) : effects_(effects) {}
    const Snapshot& Get() const { return state_; }
    void FactoryReady(bool ready) {
        if (state_.phase == Phase::Original)
            state_.original_ready = ready;
    }
    bool Enter(uint64_t expected_epoch, uint64_t now) {
        if (state_.phase != Phase::Original || expected_epoch != state_.epoch || Exhausted())
            return false;
        state_.selected = Backend::Local;
        state_.expires_ms = Add(now, kLeaseMs);
        Begin(now);
        return true;
    }
    bool Renew(uint64_t epoch, uint64_t now) {
        if (epoch != state_.epoch || state_.selected != Backend::Local ||
            now >= state_.expires_ms || state_.phase != Phase::Local)
            return false;
        state_.expires_ms = Add(now, kLeaseMs);
        return true;
    }
    bool Leave(uint64_t epoch, uint64_t now) {
        if (epoch != state_.epoch)
            return false;
        if (state_.selected == Backend::Original && state_.phase != Phase::Fault)
            return true;
        return ReturnOriginal(now);
    }
    bool ReturnOriginal(uint64_t now) {
        if (state_.selected == Backend::Original && state_.phase != Phase::Fault)
            return true;
        if (Exhausted())
            return false;
        state_.selected = Backend::Original;
        state_.expires_ms = 0;
        Begin(now);
        return true;
    }
    void Tick(uint64_t now) {
        if (state_.selected == Backend::Local && now >= state_.expires_ms)
            ReturnOriginal(now);
        if (state_.phase == Phase::Quiescing || state_.phase == Phase::Recovering) {
            if (effects_.IsQuiescent()) {
                effects_.Connect(state_.selected, state_.epoch);
                state_.phase = Phase::Connecting;
                deadline_ = Add(now, kTransitionMs);
            } else if (now >= deadline_)
                Fail(now);
        } else if (state_.phase == Phase::Connecting) {
            auto result = effects_.ConnectionResult(state_.epoch);
            if (result == Result::Ready) {
                state_.phase = state_.selected == Backend::Local ? Phase::Local : Phase::Original;
                const auto epoch = state_.epoch;
                const bool activated = effects_.Activate(state_.selected, epoch);
                // Activation can replay a queued disconnect and begin recovery.
                if (state_.epoch != epoch)
                    return;
                if (activated)
                    state_.original_ready = state_.selected == Backend::Original;
                else
                    Fail(now);
            } else if (result == Result::Failed || now >= deadline_)
                Fail(now);
        }
    }
    void Disconnected(uint64_t epoch, uint64_t now) {
        if (epoch != state_.epoch)
            return;
        if (state_.selected == Backend::Local)
            ReturnOriginal(now);
        else
            state_.original_ready = false;
    }

private:
    static uint64_t Add(uint64_t now, uint64_t duration) {
        return now > UINT64_MAX - duration ? UINT64_MAX : now + duration;
    }
    bool Exhausted() const { return state_.epoch == UINT64_MAX; }
    void Begin(uint64_t now) {
        ++state_.epoch;  // Invalidate every callback before invoking effects.
        state_.original_ready = false;
        state_.phase = state_.selected == Backend::Local ? Phase::Quiescing : Phase::Recovering;
        deadline_ = Add(now, kTransitionMs);
        effects_.Quiesce(state_.epoch);
    }
    void Fail(uint64_t now) {
        if (state_.selected == Backend::Local)
            ReturnOriginal(now);
        else {
            state_.phase = Phase::Fault;
            state_.original_ready = false;
            if (!Exhausted())
                effects_.Quiesce(++state_.epoch);
            // Leave resources fenced; explicit retry/physical return can recover.
        }
    }
    Effects& effects_;
    Snapshot state_;
    uint64_t deadline_ = 0;
};
}  // namespace sion
