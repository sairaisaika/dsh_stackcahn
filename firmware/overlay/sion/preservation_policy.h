// SPDX-License-Identifier: MIT
#pragma once
#include <cstdint>
#include <string>
#include <string_view>

namespace sion {
// Original service identity/configuration must not be rewritten by this trial.
inline bool ProtectedNamespace(std::string_view name) {
    return name == "board" || name == "wifi" || name == "mqtt" ||
           name == "websocket" || name == "assets" || name == "account" ||
           name == "app_config";
}

class TrialPolicy {
public:
    enum class State { Pending, Confirmed, Expired, Fault };
    static constexpr int64_t DurationMs = 10 * 60 * 1000;
    TrialPolicy(std::string nonce, std::string image, int64_t started)
        : nonce_(std::move(nonce)), image_(std::move(image)), deadline_(started + DurationMs) {}
    template <class Commit>
    bool Confirm(const std::string& nonce, const std::string& image, bool observed,
                 int64_t now, Commit commit) {
        if (state_ != State::Pending || now >= deadline_ || !observed ||
            nonce != nonce_ || image != image_)
            return false;
        if (!commit()) {
            // A failed commit may have partially changed OTA metadata. Do not
            // report success or retry/rollback blindly after an uncertain write.
            state_ = State::Fault;
            return false;
        }
        state_ = State::Confirmed;
        return true;
    }
    bool Expire(int64_t now) {
        if (state_ != State::Pending || now < deadline_)
            return false;
        state_ = State::Expired;
        return true;
    }
    void Fault() { state_ = State::Fault; }
    State state() const { return state_; }
    int64_t Remaining(int64_t now) const {
        return state_ == State::Pending && now < deadline_ ? deadline_ - now : 0;
    }
    const std::string& nonce() const { return nonce_; }
    const std::string& image() const { return image_; }
private:
    std::string nonce_, image_;
    int64_t deadline_;
    State state_ = State::Pending;
};
}  // namespace sion
