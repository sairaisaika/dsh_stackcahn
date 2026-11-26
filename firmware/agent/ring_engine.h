// SPDX-License-Identifier: MIT
#pragma once
#include "session_lifecycle.h"
#include <array>
#include <mutex>

namespace sion::agent {

struct RingColor {
    uint8_t red, green, blue;
    bool operator==(const RingColor& other) const {
        return red == other.red && green == other.green && blue == other.blue;
    }
};
using RingFrame = std::array<RingColor, 12>;
// One colour for the whole ring (count 0), or up to kRingFrames frames of 12
// individual LEDs (0-5 one side, 6-11 the other), each shown for its own time.
// brightness scales every channel (255 = as given).
constexpr unsigned kRingFrames = 8;
struct RingEffect {
    RingColor color{}; int duration_ms = 0;
    std::array<RingFrame, kRingFrames> frames{};
    std::array<int, kRingFrames> frame_ms{};
    unsigned count = 0;
    uint8_t brightness = 255;
};
constexpr bool ValidRingDuration(int duration_ms) { return duration_ms >= 250 && duration_ms <= 10000; }
inline bool ValidRingEffect(const RingEffect& effect) {
    if (effect.count == 0) return ValidRingDuration(effect.duration_ms);
    if (effect.count > kRingFrames) return false;
    int total = 0;
    for (unsigned i = 0; i < effect.count; ++i) {
        if (effect.frame_ms[i] < 20 || effect.frame_ms[i] > 10000) return false;
        total += effect.frame_ms[i];
    }
    return total >= 20 && total <= 10000;
}

enum class RingPhase { Idle, Opening, Showing, Lit, Clearing, Fault, Indicator };
enum class RingResult { None, Completed, Invalid, Disabled, Busy, Cancelled, Open, Write, Release };
enum class RingIndicator { Off, Listening, Waiting, Speaking };
struct RingStatus { RingPhase phase; bool allowed; RingResult error; bool indicator; };

struct RingPort {
    virtual ~RingPort() = default;
    virtual bool Open() = 0;
    virtual bool Show(const RingFrame& frame) = 0;
    virtual bool Close() = 0;
};

class RingEngine {
public:
    explicit RingEngine(RingPort& port) : port_(port) {}
    void Allow(bool allowed) {
        std::lock_guard lock(mutex_);
        if (allowed_ == allowed) return;
        allowed_ = allowed;
        if (!allowed) CancelLocked();
        else indicator_failed_ = false;
    }
    // level: speaker peak, hearing: microphone peak; both 0..32.
    void Indicate(uint64_t epoch, RingIndicator indicator, uint8_t level = 0, uint8_t hearing = 0) {
        std::lock_guard lock(mutex_);
        if (epoch <= fence_ || epoch < indicator_epoch_) return;
        indicator_epoch_ = epoch;
        indicator_ = indicator;
        level_ = level > 32 ? 32 : level;
        hearing_ = hearing > 32 ? 32 : hearing;
    }
    RingResult Begin(uint64_t epoch, RingEffect effect) {
        std::lock_guard lock(mutex_);
        if (!ValidRingEffect(effect)) return RingResult::Invalid;
        if (phase_ == RingPhase::Fault) return RingResult::Release;
        if (!allowed_) return RingResult::Disabled;
        if ((phase_ != RingPhase::Idle && phase_ != RingPhase::Indicator) ||
            result_ready_ || epoch <= fence_ || epoch < epoch_ || epoch < indicator_epoch_) return RingResult::Busy;
        epoch_ = epoch;
        target_ = effect;
        frame_ = 0;
        result_ = RingResult::None;
        manual_ = true;
        phase_ = RingPhase::Opening;
        return RingResult::None;
    }
    void Cancel(uint64_t epoch) {
        std::lock_guard lock(mutex_);
        if (manual_ && epoch == epoch_ && epoch > fence_) CancelLocked();
    }
    void Stop(uint64_t fence) {
        std::lock_guard lock(mutex_);
        if (fence < epoch_ || fence < indicator_epoch_ || fence < fence_) return;
        fence_ = fence;
        result_ready_ = false;
        indicator_ = RingIndicator::Off;
        indicator_failed_ = false;
        if (phase_ == RingPhase::Fault) {
            result_ = RingResult::Cancelled;
            phase_ = RingPhase::Clearing;
        }
        CancelLocked();
    }
    Result Stopped(uint64_t fence) const {
        std::lock_guard lock(mutex_);
        if (fence != fence_ || epoch_ > fence) return Result::Pending;
        if (phase_ == RingPhase::Fault) return Result::Failed;
        return phase_ == RingPhase::Idle ? Result::Done : Result::Pending;
    }
    RingStatus status() const {
        std::lock_guard lock(mutex_);
        const bool error = result_ == RingResult::Open || result_ == RingResult::Write || result_ == RingResult::Release;
        const auto visible = phase_ == RingPhase::Indicator ? RingPhase::Idle : phase_;
        return {visible, allowed_, error ? result_ : RingResult::None, phase_ == RingPhase::Indicator};
    }
    RingResult Take(uint64_t epoch) {
        std::lock_guard lock(mutex_);
        if (!result_ready_ || epoch != epoch_ || epoch <= fence_) return RingResult::None;
        result_ready_ = false;
        return result_;
    }

    // Called only by the ring worker. Control and state reads do not hold the
    // engine mutex across I2C. A cancelled in-flight write still needs Close.
    void Pump(uint64_t now) {
        RingPhase phase;
        RingColor color;
        RingFrame effect_frame{};
        bool counted = false;
        uint8_t brightness = 255;
        RingIndicator indicator;
        uint8_t level, hearing;
        {
            std::lock_guard lock(mutex_);
            if (phase_ == RingPhase::Lit) {
                const int shown_ms = target_.count ? target_.frame_ms[frame_] : target_.duration_ms;
                if (now >= lit_since_ && now - lit_since_ < static_cast<uint64_t>(shown_ms)) return;
                if (target_.count && frame_ + 1 < target_.count) { ++frame_; phase_ = RingPhase::Showing; }
                else phase_ = RingPhase::Clearing;
            }
            if (phase_ == RingPhase::Idle && allowed_ && !indicator_failed_ && !result_ready_ &&
                indicator_epoch_ > fence_ && indicator_ != RingIndicator::Off) {
                phase_ = RingPhase::Indicator;
                next_indicator_at_ = now;
            }
            // Off fades out first; Stop and permission changes still cut at once.
            if (phase_ == RingPhase::Indicator && indicator_ == RingIndicator::Off && dark_) CancelLocked();
            phase = phase_;
            color = target_.color;
            effect_frame = target_.count ? target_.frames[frame_] : RingFrame{};
            counted = target_.count != 0;
            brightness = target_.brightness;
            indicator = indicator_;
            level = level_;
            hearing = hearing_;
        }
        if (phase == RingPhase::Clearing) {
            const bool closed = !owns_port_ || port_.Close();
            ready_port_ = false;
            if (closed) owns_port_ = false;
            std::lock_guard lock(mutex_);
            if (!closed) result_ = RingResult::Release;
            else if (result_ == RingResult::None) result_ = RingResult::Completed;
            phase_ = closed ? RingPhase::Idle : RingPhase::Fault;
            result_ready_ = manual_ && epoch_ > fence_;
            manual_ = false;
        } else if (phase == RingPhase::Indicator) {
            PumpIndicator(now, indicator, level, hearing);
        } else if (phase == RingPhase::Opening || phase == RingPhase::Showing) {
            RingFrame frame;
            if (counted) frame = effect_frame;
            else frame.fill(color);
            for (auto& led : frame) {
                led = {static_cast<uint8_t>(led.red * brightness / 255), static_cast<uint8_t>(led.green * brightness / 255),
                       static_cast<uint8_t>(led.blue * brightness / 255)};
            }
            const bool ok = phase == RingPhase::Opening ? OpenPort() : port_.Show(frame);
            std::lock_guard lock(mutex_);
            if (phase_ != phase) return;
            if (!ok) {
                result_ = phase == RingPhase::Opening ? RingResult::Open : RingResult::Write;
                phase_ = RingPhase::Clearing;
            } else if (phase == RingPhase::Opening) {
                phase_ = RingPhase::Showing;
            } else {
                lit_since_ = now;
                phase_ = RingPhase::Lit;
            }
        }
    }
private:
    RingPort& port_;
    mutable std::mutex mutex_;
    RingPhase phase_ = RingPhase::Idle;
    RingResult result_ = RingResult::None;
    RingEffect target_{};
    unsigned frame_ = 0;
    uint64_t epoch_ = 0, fence_ = 0, lit_since_ = 0;
    uint64_t indicator_epoch_ = 0, next_indicator_at_ = 0;
    RingIndicator indicator_ = RingIndicator::Off;
    RingFrame last_frame_{};
    uint8_t level_ = 0, hearing_ = 0;
    std::array<uint16_t, 36> glow_{};  // Worker-only eased channels, 8.8 fixed point.
    bool dark_ = true;                 // Worker-only: the eased frame reached black.
    bool allowed_ = false, result_ready_ = false, manual_ = false, indicator_failed_ = false;
    bool owns_port_ = false, ready_port_ = false; // Worker-only. Failed Open still needs Close.
    bool OpenPort() {
        if (ready_port_) return true;
        owns_port_ = true;
        last_frame_ = {};
        glow_ = {};
        dark_ = true;
        return ready_port_ = port_.Open();
    }
    static constexpr uint64_t IndicatorStepMs = 20;  // 50 Hz, as the stock NeonLight
    void PumpIndicator(uint64_t now, RingIndicator indicator, uint8_t level, uint8_t hearing) {
        if (now < next_indicator_at_) return;
        next_indicator_at_ = now + IndicatorStepMs;
        const bool opening = !ready_port_;
        const auto frame = Ease(IndicatorFrame(now, indicator, level, hearing));
        if (OpenPort() && (frame == last_frame_ || port_.Show(frame))) {
            last_frame_ = frame;
            dark_ = frame == RingFrame{};
            return;
        }
        std::lock_guard lock(mutex_);
        indicator_failed_ = true;
        if (phase_ == RingPhase::Clearing) return;
        result_ = opening && !ready_port_ ? RingResult::Open : RingResult::Write;
        phase_ = RingPhase::Clearing;
    }
    // Each channel moves about a fifth of the way per 20 ms step: a change
    // settles in roughly 0.3 s, the stock light's colour animation time.
    RingFrame Ease(const RingFrame& target) {
        RingFrame shown{};
        for (unsigned i = 0; i < 12; ++i) {
            const uint8_t goal[3] = {target[i].red, target[i].green, target[i].blue};
            uint8_t out[3];
            for (unsigned c = 0; c < 3; ++c) {
                auto& value = glow_[i * 3 + c];
                const int aim = goal[c] << 8;
                const int gap = aim - value;
                value = static_cast<uint16_t>(gap > -96 && gap < 96 ? aim : value + gap * 3 / 16);
                // The PY32 strip takes RGB565: drop bits it cannot show, so a
                // fade only writes when the LED would actually change.
                out[c] = static_cast<uint8_t>(((value + 128) >> 8) & (c == 1 ? 0xfc : 0xf8));
            }
            shown[i] = {out[0], out[1], out[2]};
        }
        return shown;
    }
    static uint8_t Scale(int value, int permille) {
        const int scaled = value * permille / 1000;
        return static_cast<uint8_t>(scaled < 0 ? 0 : scaled > 255 ? 255 : scaled);
    }
    // Fraction lit of the i-th LED of a six-LED bar filled to `fill` (0..32).
    static int BarPermille(unsigned i, int fill) {
        const int edge = fill * 6000 / 32 - static_cast<int>(i) * 1000;
        return edge < 0 ? 0 : edge > 1000 ? 1000 : edge;
    }
    // Left strip (0-5) is the ear: microphone. Right strip (6-11) is the voice:
    // speaker. Waiting carries a light from the ear to the voice. Off is dark,
    // like the stock standby.
    static RingFrame IndicatorFrame(uint64_t now, RingIndicator indicator, uint8_t level, uint8_t hearing) {
        RingFrame result{};
        if (indicator == RingIndicator::Listening) {
            const int heard = hearing * 2 > 32 ? 32 : hearing * 2;
            for (unsigned i = 0; i < 6; ++i) {
                // Steady soft green says "ready"; voice lifts it from the first LED up.
                const RingColor ready{0, 16, static_cast<uint8_t>(8 + 2 * i)};
                const RingColor lifted{0, 64, static_cast<uint8_t>(16 + 4 * i)};
                const int lift = BarPermille(i, heard);
                result[i] = {0, static_cast<uint8_t>(ready.green + Scale(lifted.green - ready.green, lift)),
                             static_cast<uint8_t>(ready.blue + Scale(lifted.blue - ready.blue, lift))};
            }
        } else if (indicator == RingIndicator::Waiting) {
            // A soft amber light travels ear -> voice in 1.2 s.
            const int position = static_cast<int>(now % 1200) * 12000 / 1200;  // milli-LED
            for (unsigned i = 0; i < 12; ++i) {
                int distance = static_cast<int>(i) * 1000 - position;
                if (distance < 0) distance = -distance;
                const int near = distance >= 1600 ? 0 : 1000 - distance * 1000 / 1600;
                result[i] = {static_cast<uint8_t>(8 + Scale(56, near)), static_cast<uint8_t>(4 + Scale(24, near)), 0};
            }
        } else if (indicator == RingIndicator::Speaking) {
            for (unsigned i = 0; i < 6; ++i) {
                result[i] = {0, 4, 16};  // Ear rests while it speaks.
                const RingColor rest{0, 8, 24};
                const RingColor peak{0, static_cast<uint8_t>(16 + 8 * i), 72};  // Blue to cyan up the bar.
                const int lit = BarPermille(i, level);
                result[6 + i] = {0, static_cast<uint8_t>(rest.green + Scale(peak.green - rest.green, lit)),
                                 static_cast<uint8_t>(rest.blue + Scale(peak.blue - rest.blue, lit))};
            }
        }
        return result;
    }
    void CancelLocked() {
        if (phase_ == RingPhase::Idle || phase_ == RingPhase::Fault) return;
        if (result_ == RingResult::None || result_ == RingResult::Completed) result_ = RingResult::Cancelled;
        phase_ = RingPhase::Clearing;
    }
};

}
