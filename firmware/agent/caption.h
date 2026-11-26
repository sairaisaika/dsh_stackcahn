// SPDX-License-Identifier: MIT
#pragma once
#include <cstddef>
#include <cstdint>
#include <string>
#include <string_view>
#include <utility>

namespace sion::agent {
constexpr size_t kCaptionBytes = 896;
enum class CaptionSpeaker { User, Assistant, Status };

// Flat JSON carries ASCII hex. Decode and validate before any bytes enter LVGL.
inline bool DecodeCaption(std::string_view hex, std::string& text) {
    if (hex.empty() || hex.size() % 2 || hex.size() > 2 * kCaptionBytes) return false;
    const auto nibble = [](char ch) -> int {
        if (ch >= '0' && ch <= '9') return ch - '0';
        return ch >= 'a' && ch <= 'f' ? ch - 'a' + 10 : -1;
    };
    text.clear();
    text.reserve(hex.size() / 2);
    for (size_t i = 0; i < hex.size(); i += 2) {
        const int high = nibble(hex[i]), low = nibble(hex[i + 1]);
        if (high < 0 || low < 0) return false;
        text.push_back(static_cast<char>((high << 4) | low));
    }
    for (size_t i = 0; i < text.size();) {
        const unsigned lead = static_cast<uint8_t>(text[i++]);
        if (lead < 0x80) {
            if ((lead < 0x20 && lead != '\n') || lead == 0x7f) return false;
            continue;
        }
        if (lead < 0xc2 || lead > 0xf4) return false;
        unsigned rest = lead < 0xe0 ? 1 : lead < 0xf0 ? 2 : 3;
        const unsigned minimum = rest == 1 ? 0x80 : rest == 2 ? 0x800 : 0x10000;
        unsigned point = lead & (0x3f >> rest);
        if (text.size() - i < rest) return false;
        for (; rest; --rest) {
            const unsigned next = static_cast<uint8_t>(text[i++]);
            if ((next & 0xc0) != 0x80) return false;
            point = (point << 6) | (next & 0x3f);
        }
        if (point < minimum || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff) || point < 0xa0) return false;
    }
    return true;
}

class Captions {
public:
    const std::string& User() const { return user_; }
    const std::string& Assistant() const { return assistant_; }
    // Transient: what DSH is doing now (thinking, a tool). Replaced by the reply.
    const std::string& Status() const { return status_; }
    uint64_t Revision() const { return revision_; }
    void Add(CaptionSpeaker speaker, std::string text) {
        if (speaker == CaptionSpeaker::Status) {
            if (user_.empty()) return;
            status_ = std::move(text);
        } else if (speaker == CaptionSpeaker::User) {
            user_ = std::move(text);
            assistant_.clear();
            status_.clear();
        } else {
            if (user_.empty()) return;
            assistant_ = std::move(text);
            status_.clear();
        }
        ++revision_;
    }
    void Clear() {
        if (user_.empty() && assistant_.empty() && status_.empty()) return;
        user_.clear();
        assistant_.clear();
        status_.clear();
        ++revision_;
    }
private:
    std::string user_, assistant_, status_;
    uint64_t revision_ = 0;
};
}
