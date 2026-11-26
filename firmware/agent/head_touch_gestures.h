// SPDX-License-Identifier: MIT
#pragma once
#include <algorithm>
#include <array>
#include <cstdint>

namespace sion::agent {

struct HeadTouchSample {
    int channel1 = -1, channel2 = -1, channel3 = -1;
};

inline constexpr uint64_t head_touch_sample_max_age_ms = 300;
inline constexpr uint64_t head_touch_gesture_max_gap_ms = 150;
inline constexpr uint64_t head_touch_rearm_ms = 150;

enum class HeadTouchKind : uint8_t { Tap, Hold, TowardChannel1, TowardChannel3 };

struct HeadTouchGesture {
    uint32_t sequence = 0;
    uint32_t duration_ms = 0;
    uint64_t completed_at = 0;
    HeadTouchKind kind = HeadTouchKind::Tap;
    uint8_t peak = 0;
};

class HeadTouchGestures {
public:
    void Observe(const HeadTouchSample& sample, uint64_t now) {
        const auto [first, middle, last] = sample;
        const bool valid = first >= 0 && middle >= 0 && last >= 0;
        if (!valid || now - last_observed_at_ >= head_touch_gesture_max_gap_ms) {
            ready_ = in_touch_ = touch_pending_ = release_pending_ = false;
        }
        last_observed_at_ = now;
        if (!valid) return;
        const int peak = std::max({first, middle, last});
        if (peak == 0) {
            touch_pending_ = false;
            pending_direction_ = HeadTouchKind::Tap;
            if (!release_pending_) {
                release_pending_ = true;
                released_at_ = now;
                return;
            }
            if (in_touch_) {
                Complete(released_at_);
                in_touch_ = false;
                ready_ = false;
            }
            if (now - released_at_ >= head_touch_rearm_ms) ready_ = true;
            return;
        }
        release_pending_ = false;
        if (!ready_) return; // Require a stable untouched baseline before accepting contact.
        const int position = (last - first) * 100 / (first + middle + last);
        if (!in_touch_) {
            if (!touch_pending_) {
                touch_pending_ = true;
                started_at_ = now;
                start_position_ = position;
                peak_ = peak;
                pending_direction_ = direction_ = HeadTouchKind::Tap;
                return;
            }
            in_touch_ = true;
            touch_pending_ = false;
        }
        peak_ = std::max(peak_, peak);
        // The factory recognizer uses a three-channel centroid and a 40-point
        // displacement. Device testing determines the physical direction labels.
        if (direction_ != HeadTouchKind::Tap) return;
        const int displacement = position - start_position_;
        const auto next = displacement < -40 ? HeadTouchKind::TowardChannel1 :
            displacement > 40 ? HeadTouchKind::TowardChannel3 : HeadTouchKind::Tap;
        if (next == pending_direction_) direction_ = next;
        pending_direction_ = next;
    }

    HeadTouchGesture Next(uint32_t after, uint64_t now) const {
        HeadTouchGesture next;
        for (const auto& gesture : recent_) {
            if (gesture.sequence <= after || now < gesture.completed_at || now - gesture.completed_at >= 3000) continue;
            if (next.sequence == 0 || next.sequence > gesture.sequence) next = gesture;
        }
        return next;
    }

private:
    void Complete(uint64_t now) {
        if (now <= started_at_ || sequence_ == UINT32_MAX) return;
        const auto duration = static_cast<uint32_t>(std::min<uint64_t>(now - started_at_, 60000));
        const auto kind = direction_ == HeadTouchKind::Tap && duration >= 400 ? HeadTouchKind::Hold : direction_;
        recent_[sequence_ % recent_.size()] = {sequence_ + 1, duration, now, kind, static_cast<uint8_t>(peak_)};
        ++sequence_;
    }

    std::array<HeadTouchGesture, 4> recent_{};
    uint64_t started_at_ = 0, released_at_ = 0, last_observed_at_ = 0;
    uint32_t sequence_ = 0;
    int start_position_ = 0, peak_ = 0;
    HeadTouchKind direction_ = HeadTouchKind::Tap, pending_direction_ = HeadTouchKind::Tap;
    bool ready_ = false, in_touch_ = false, touch_pending_ = false, release_pending_ = false;
};

}
