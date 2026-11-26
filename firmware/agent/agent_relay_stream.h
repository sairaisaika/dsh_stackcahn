// SPDX-License-Identifier: MIT
#pragma once
#include <algorithm>
#include <array>
#include <cstring>
#include <cstdint>
#include <mutex>
#include <string_view>

namespace sion::agent {
// The relay emits whole, uncompressed WebSocket frames. The ESP SDK may split
// each frame into callbacks with a stable opcode/length and increasing offset.
// The callback is the sole producer. The inner TLS worker owns the read end.
class AgentRelayStream {
public:
    static constexpr size_t MaxFrame = 16384, Capacity = 32768;

    bool Feed(int opcode, bool fin, int payload, int offset, const uint8_t* bytes, int length) {
        std::lock_guard<std::mutex> lock(mutex_);
        if (failed_ || !fin || !bytes || length <= 0 || payload <= 0 || payload > int(MaxFrame) ||
            offset != frame_offset_ || offset > payload || length > payload - offset) return Fail();
        if (!offset) frame_length_ = payload;
        if (payload != frame_length_) return Fail();

        if (!ready_) {
            if (opcode != 1 || payload != int(Ready.size()) ||
                std::memcmp(bytes, Ready.data() + offset, length)) return Fail();
            if (offset + length == payload) ready_ = true;
        } else {
            if (opcode != 2) return Fail();
            const size_t marker_count = std::min<size_t>(length, Preamble.size() - marker_used_);
            if (std::memcmp(bytes, Preamble.data() + marker_used_, marker_count)) return Fail();
            marker_used_ += marker_count;
            const size_t count = size_t(length) - marker_count;
            if (count > Capacity - used_) return Fail();
            const size_t end = (head_ + used_) % Capacity;
            const size_t first = std::min(count, Capacity - end);
            std::memcpy(data_.data() + end, bytes + marker_count, first);
            std::memcpy(data_.data(), bytes + marker_count + first, count - first);
            used_ += count;
        }
        frame_offset_ = offset + length == payload ? 0 : offset + length;
        return true;
    }

    bool CanHandshake() {
        std::lock_guard<std::mutex> lock(mutex_);
        return !failed_ && marker_used_ == Preamble.size();
    }

    // No bytes available yet is distinct from a fatal framing/backpressure error.
    int Read(uint8_t* destination, size_t length) {
        std::lock_guard<std::mutex> lock(mutex_);
        if (failed_) return -1;
        const size_t count = std::min(used_, length);
        if (!count) return 0;
        const size_t first = std::min(count, Capacity - head_);
        std::memcpy(destination, data_.data() + head_, first);
        std::memcpy(destination + first, data_.data(), count - first);
        head_ = (head_ + count) % Capacity;
        used_ -= count;
        return static_cast<int>(count);
    }

private:
    static constexpr std::string_view Ready = "SION-RELAY-READY 1", Preamble = "\nSIONR1\n";
    bool Fail() { failed_ = true; return false; }

    std::mutex mutex_;
    std::array<uint8_t, Capacity> data_;
    size_t marker_used_ = 0, head_ = 0, used_ = 0;
    int frame_offset_ = 0, frame_length_ = 0;
    bool ready_ = false, failed_ = false;
};
}
