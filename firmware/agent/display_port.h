// SPDX-License-Identifier: MIT
#pragma once
#include <cstdint>
#include <string>

namespace sion::agent {
// Content DSH puts on the face page: a text panel or an RGB565 image (little
// endian, as the face sprites), each for a limited time. The face stays the
// owner of the page; leaving it, Stop or a disconnect clears the overlay.
enum class DisplayArea : uint8_t { Full, Top, Bottom };
constexpr uint32_t kDisplayMinMs = 100, kDisplayMaxMs = 60000;
constexpr uint16_t kDisplayWidth = 320, kDisplayHeight = 240;
inline bool ValidDisplayImage(uint16_t w, uint16_t h, uint16_t x, uint16_t y) {
    return w && h && w <= kDisplayWidth && h <= kDisplayHeight && x + w <= kDisplayWidth && y + h <= kDisplayHeight;
}
// Single LVGL owner (the UI loop, which also runs the session).
struct DisplayPort {
    virtual ~DisplayPort() = default;
    virtual bool ShowText(const std::string& utf8, DisplayArea area, uint32_t ms, uint64_t now) = 0;
    // Allocates width*height*2 bytes; data arrives in order through ImageData.
    virtual bool BeginImage(uint16_t w, uint16_t h, uint16_t x, uint16_t y, uint32_t ms) = 0;
    virtual bool ImageData(uint32_t offset, const uint8_t* bytes, size_t size) = 0;
    virtual bool ShowImage(uint64_t now) = 0;    // false until every byte arrived
    virtual void ClearDisplay() = 0;
    // A stored frame (frame_bank.h): the pixels stay owned by the bank and must outlive
    // the picture, so the session clears the screen before it drops or rewrites that slot.
    virtual bool ShowFrame(const uint8_t* /*pixels*/, uint16_t /*w*/, uint16_t /*h*/, uint16_t /*x*/, uint16_t /*y*/,
                           uint32_t /*ms*/, uint64_t /*now*/) { return false; }
};
}
