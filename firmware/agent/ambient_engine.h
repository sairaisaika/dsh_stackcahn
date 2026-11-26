// SPDX-License-Identifier: MIT
#pragma once
#include "session_lifecycle.h"
#include "head_touch_gestures.h"
#include <array>
#include <mutex>

namespace sion::agent {

struct AmbientSample {
    int channel0 = -1, channel1 = -1, proximity = -1;
};

template<class Sample>
struct SensorPort {
    virtual ~SensorPort() = default;
    virtual bool Open() = 0;
    virtual Sample Read() = 0;
    virtual bool Close() = 0;
};

struct NoSensorObserver {
    template<class Sample>
    void Observe(const Sample&, uint64_t) {}
};

template<class Sample, uint64_t IntervalMs, uint64_t MaxAgeMs, uint64_t StartupMs = IntervalMs,
         class Observer = NoSensorObserver>
class SensorEngine {
public:
    explicit SensorEngine(SensorPort<Sample>& port) : port_(port) {}

    void Begin(uint64_t epoch) {
        std::lock_guard lock(mutex_);
        if (epoch <= epoch_) return;
        // A sensor waiting to retry a failed open is closed: same as Idle.
        if (stage_ == Stage::Idle || retry_wait_) stage_ = Stage::Opening;
        // A session takes over the sensor a local watch already opened. One
        // that is still closing reopens under the session's epoch.
        else if (watching_ && stage_ == Stage::Closing) reopen_ = true;
        else if (!watching_ || stage_ == Stage::Fault) return;
        watching_ = false;
        epoch_ = epoch;
        sample_ = {};
        observer_ = {};
        open_failures_ = 0;
        next_open_ = 0;
        retry_wait_ = false;
    }

    // Local sampling between sessions, for reactions that never leave the
    // device. It runs under the fence the last Stop left, so every session
    // epoch still supersedes it and Snapshot(fence) reads it.
    void Watch(uint64_t fence) {
        std::lock_guard lock(mutex_);
        if (stage_ != Stage::Idle || fence < epoch_) return;
        epoch_ = fence;
        stage_ = Stage::Opening;
        watching_ = true;
        sample_ = {};
        observer_ = {};
    }

    void Unwatch() {
        std::lock_guard lock(mutex_);
        if (!watching_ || reopen_ || (stage_ != Stage::Opening && stage_ != Stage::Sampling)) return;
        sample_ = {};
        retry_ = false;
        if (retry_wait_) { retry_wait_ = false; watching_ = false; stage_ = Stage::Idle; return; }
        stage_ = Stage::Closing;
    }

    void Stop(uint64_t fence) {
        std::lock_guard lock(mutex_);
        if (fence < epoch_) return;
        epoch_ = fence;
        sample_ = {};
        watching_ = reopen_ = retry_ = false;
        // Waiting to retry a failed open: the port is already closed.
        if (retry_wait_) { retry_wait_ = false; stage_ = Stage::Idle; }
        else if (stage_ != Stage::Idle) stage_ = Stage::Closing;
    }

    // Diagnostic only: failed opens since the current session began.
    unsigned OpenFailures() const {
        std::lock_guard lock(mutex_);
        return open_failures_;
    }
    static constexpr unsigned OpenRetries = 5;
    static constexpr uint64_t OpenRetryMs = 2000;

    Result Stopped(uint64_t fence) const {
        std::lock_guard lock(mutex_);
        if (epoch_ != fence) return Result::Pending;
        if (stage_ == Stage::Fault) return Result::Failed;
        // Waiting to retry a failed open holds no port resources.
        return stage_ == Stage::Idle || retry_wait_ ? Result::Done : Result::Pending;
    }

    Sample Snapshot(uint64_t epoch, uint64_t now) const {
        std::lock_guard lock(mutex_);
        if (stage_ != Stage::Sampling || epoch != epoch_ || now < sampled_at_ || now - sampled_at_ >= MaxAgeMs) return {};
        return sample_;
    }

    template<class Read>
    auto Inspect(uint64_t epoch, Read read) const {
        std::lock_guard lock(mutex_);
        if (stage_ != Stage::Sampling || epoch != epoch_) return decltype(read(observer_)){};
        return read(observer_);
    }

    // One worker owns the I2C handle. A stop fence can arrive during any call.
    void Pump(uint64_t now) {
        Stage stage;
        uint64_t epoch;
        {
            std::lock_guard lock(mutex_);
            stage = stage_;
            epoch = epoch_;
            if (stage == Stage::Sampling && now < next_sample_) return;
            if (stage == Stage::Opening && now < next_open_) return;
        }
        if (stage == Stage::Opening) {
            {
                std::lock_guard lock(mutex_);
                retry_wait_ = false;
            }
            const bool opened = port_.Open();
            std::lock_guard lock(mutex_);
            if (stage_ != Stage::Opening) return;
            next_sample_ = now + StartupMs;
            stage_ = opened ? Stage::Sampling : Stage::Closing;
            // v67: one failed open used to leave the sensor dark for the whole
            // session. Close, then try again a few times for the same owner.
            if (!opened && ++open_failures_ <= OpenRetries) {
                retry_ = true;
                next_open_ = now + OpenRetryMs;
            }
        } else if (stage == Stage::Sampling) {
            const auto sample = port_.Read();
            std::lock_guard lock(mutex_);
            if (stage_ != Stage::Sampling || epoch_ != epoch) return;
            sampled_at_ = now;
            next_sample_ = now + IntervalMs;
            sample_ = sample;
            observer_.Observe(sample, now);
        } else if (stage == Stage::Closing) {
            const bool closed = port_.Close();
            std::lock_guard lock(mutex_);
            if (!closed) stage_ = Stage::Fault;
            else if (reopen_ || retry_) { stage_ = Stage::Opening; retry_wait_ = retry_ && !reopen_; }
            else stage_ = Stage::Idle;
            if (!retry_ || !closed) watching_ = false;
            reopen_ = retry_ = false;
        }
    }

private:
    enum class Stage { Idle, Opening, Sampling, Closing, Fault };
    SensorPort<Sample>& port_;
    mutable std::mutex mutex_;
    Stage stage_ = Stage::Idle;
    bool watching_ = false, reopen_ = false, retry_ = false, retry_wait_ = false;
    unsigned open_failures_ = 0;
    uint64_t epoch_ = 0, next_sample_ = 0, sampled_at_ = 0, next_open_ = 0;
    Sample sample_{};
    Observer observer_{};
};

struct ImuSample {
    std::array<int, 6> axes{};
    bool valid = false;
    // BMM150 raw counts (x, y 13-bit, z 15-bit), when the magnetometer answered.
    std::array<int, 3> mag{};
    bool mag_valid = false;
};

using AmbientPort = SensorPort<AmbientSample>;
using AmbientEngine = SensorEngine<AmbientSample, 750, 1500>;
using HeadTouchPort = SensorPort<HeadTouchSample>;
using HeadTouchEngine = SensorEngine<HeadTouchSample, 50, head_touch_sample_max_age_ms, 200, HeadTouchGestures>;
using ImuPort = SensorPort<ImuSample>;
// 20 ms so a recording can report up to 50 Hz; the BMI270 runs at 100 Hz.
using ImuEngine = SensorEngine<ImuSample, 20, 400>;

}
