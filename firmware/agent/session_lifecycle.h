// SPDX-License-Identifier: MIT
#pragma once
#include <cstdint>
#include <limits>

namespace sion::agent {
enum class Phase { Idle, Connecting, Active, Draining, Returning, Home, Fault };
enum class Result { Pending, Done, Failed };

// Called only on the device owner task. These hooks must be nonblocking and
// idempotent: StopResources revokes input, audio, camera/actions and queued work;
// ResourcesStopped is Done only after all producers have acknowledged the fence.
// ReturnHome is the installer-selected navigation adapter, never a hardcoded slot.
struct Effects {
    virtual ~Effects() = default;
    virtual void StopResources(uint64_t epoch) = 0;
    virtual Result ResourcesStopped(uint64_t epoch) = 0;
    virtual Result ReturnHome(uint64_t epoch) = 0;
};

class SessionLifecycle {
public:
    SessionLifecycle(Effects& effects, uint64_t lease_ms = 15000, uint64_t drain_ms = 20000)
        : effects_(effects), lease_ms_(lease_ms), drain_ms_(drain_ms) {
        if (!lease_ms || !drain_ms) phase_ = Phase::Fault;
    }
    Phase phase() const { return phase_; }
    uint64_t epoch() const { return epoch_; }
    bool Reopen() {
        if (phase_ != Phase::Home) return false;
        home_requested_ = false;
        phase_ = Phase::Idle;
        return true; // Keep epoch monotonic across navigation and re-entry.
    }
    bool Begin(uint64_t now) {
        if (phase_ != Phase::Idle || !Advance()) return false;
        phase_ = Phase::Connecting;
        last_renewal_ = now;
        return true;
    }
    bool Connected(uint64_t epoch, uint64_t now) {
        if (phase_ != Phase::Connecting || epoch != epoch_) return false;
        if (Expired(now)) { Stop(now); return false; }
        phase_ = Phase::Active;
        return true;
    }
    bool Renew(uint64_t epoch, uint64_t now) {
        if (phase_ != Phase::Active || epoch != epoch_) return false;
        if (Expired(now)) { Stop(now); return false; }
        last_renewal_ = now;
        return true;
    }
    bool Accept(uint64_t epoch, uint64_t now) const {
        return phase_ == Phase::Active && epoch == epoch_ && !Expired(now);
    }
    void Disconnected(uint64_t epoch, uint64_t now) {
        if (epoch == epoch_ && (phase_ == Phase::Connecting || phase_ == Phase::Active)) Stop(now);
    }
    void Stop(uint64_t now) {
        if (phase_ == Phase::Idle || phase_ == Phase::Home || phase_ == Phase::Draining || phase_ == Phase::Returning) return;
        Fence(now);
    }
    void Home(uint64_t now) {
        if (phase_ == Phase::Home) return;
        home_requested_ = true;
        if (phase_ != Phase::Draining && phase_ != Phase::Returning) Fence(now);
    }
    void Tick(uint64_t now) {
        if ((phase_ == Phase::Active || phase_ == Phase::Connecting) && Expired(now)) Stop(now);
        if (phase_ == Phase::Draining) {
            if (now - phase_started_ >= drain_ms_) { phase_ = Phase::Fault; return; }
            auto result = effects_.ResourcesStopped(epoch_);
            if (result == Result::Failed) { phase_ = Phase::Fault; return; }
            if (result == Result::Pending) return;
            phase_ = home_requested_ ? Phase::Returning : Phase::Idle;
            phase_started_ = now;
        }
        if (phase_ == Phase::Returning) {
            if (now - phase_started_ >= drain_ms_) { phase_ = Phase::Fault; return; }
            auto result = effects_.ReturnHome(epoch_);
            if (result == Result::Done) phase_ = Phase::Home;
            if (result == Result::Failed) phase_ = Phase::Fault;
        }
    }
private:
    Effects& effects_;
    uint64_t lease_ms_, drain_ms_, epoch_ = 0, last_renewal_ = 0, phase_started_ = 0;
    Phase phase_ = Phase::Idle;
    bool home_requested_ = false;
    bool Expired(uint64_t now) const { return now - last_renewal_ >= lease_ms_; }
    bool Advance() {
        if (epoch_ == std::numeric_limits<uint64_t>::max()) { phase_ = Phase::Fault; return false; }
        ++epoch_;
        return true;
    }
    void Fence(uint64_t now) {
        if (!Advance()) return;
        phase_ = Phase::Draining;
        phase_started_ = now;
        effects_.StopResources(epoch_);
    }
};
}  // namespace sion::agent
