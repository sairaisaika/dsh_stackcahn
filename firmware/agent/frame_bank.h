// SPDX-License-Identifier: MIT
#pragma once
#include "camera_engine.h"
#include "display_port.h"
#include <array>
#include <cstring>
#include <memory>
#ifdef ESP_PLATFORM
#include <esp_heap_caps.h>
#endif

namespace sion::agent {
// Pictures the Mac stores ahead of time and later shows by number (wiki/head-coupled-view.md).
// Memory only: survives Stop, disconnects and page changes, gone after a restart. The
// only rules are against harm: a total budget and a floor of free PSRAM left for the
// camera and the rest of the body.
constexpr int kFrameSlots = 48;
constexpr size_t kFrameBudget = 4u * 1024 * 1024;
constexpr size_t kFrameFreeFloor = 1536u * 1024;
constexpr size_t kFrameTagSize = 16;   // Lowercase hex chosen by the Mac (a content digest).

inline size_t FreeFrameMemory() {
#ifdef ESP_PLATFORM
    return heap_caps_get_free_size(MALLOC_CAP_SPIRAM);
#else
    return SIZE_MAX;
#endif
}

struct Frame {
    CameraBuffer pixels;   // RGB565 little endian, w*h*2 bytes.
    uint16_t w = 0, h = 0, x = 0, y = 0;
    std::string tag;
    bool complete = false;
    size_t bytes() const { return size_t(w) * h * 2; }
};

enum class FrameBegin { Ready, Invalid, NoRoom };

class FrameBank {
public:
    using Allocate = CameraBuffer (*)(size_t);
    using FreeMemory = size_t (*)();
    explicit FrameBank(Allocate allocate = AllocateCameraBuffer, FreeMemory free = FreeFrameMemory,
                       size_t budget = kFrameBudget, size_t floor = kFrameFreeFloor)
        : allocate_(allocate), free_(free), budget_(budget), floor_(floor), frames_(new Frame[kFrameSlots]) {}

    // Replaces the slot (its old picture is dropped first). Pixels then arrive through Write.
    FrameBegin Begin(int slot, uint16_t w, uint16_t h, uint16_t x, uint16_t y, const std::string& tag) {
        if (slot < 0 || slot >= kFrameSlots || !ValidDisplayImage(w, h, x, y) || tag.size() != kFrameTagSize)
            return FrameBegin::Invalid;
        Drop(slot);
        const size_t bytes = size_t(w) * h * 2;
        if (used_ + bytes > budget_) return FrameBegin::NoRoom;
        const size_t available = free_();
        if (available < bytes || available - bytes < floor_) return FrameBegin::NoRoom;
        auto pixels = allocate_(bytes);
        if (!pixels) return FrameBegin::NoRoom;
        auto& frame = frames_[slot];
        frame.pixels = std::move(pixels);
        frame.w = w; frame.h = h; frame.x = x; frame.y = y; frame.tag = tag; frame.complete = false;
        used_ += bytes;
        return FrameBegin::Ready;
    }
    bool Write(int slot, uint32_t offset, const uint8_t* bytes, size_t size) {
        if (slot < 0 || slot >= kFrameSlots) return false;
        auto& frame = frames_[slot];
        if (!frame.pixels || frame.complete || offset > frame.bytes() || size > frame.bytes() - offset) return false;
        std::memcpy(frame.pixels.get() + offset, bytes, size);
        return true;
    }
    // Every byte arrived: the frame can be shown. Otherwise the slot is emptied.
    bool Finish(int slot, uint32_t received) {
        if (slot < 0 || slot >= kFrameSlots || !frames_[slot].pixels) return false;
        if (received != frames_[slot].bytes()) { Drop(slot); return false; }
        frames_[slot].complete = true;
        return true;
    }
    void Drop(int slot) {
        if (slot < 0 || slot >= kFrameSlots || !frames_[slot].pixels) return;
        used_ -= frames_[slot].bytes();
        frames_[slot] = Frame{};
    }
    void DropAll() { for (int slot = 0; slot < kFrameSlots; ++slot) Drop(slot); }
    // A complete frame, or nullptr.
    const Frame* Get(int slot) const {
        if (slot < 0 || slot >= kFrameSlots || !frames_[slot].complete) return nullptr;
        return &frames_[slot];
    }
    size_t used() const { return used_; }
    size_t budget() const { return budget_; }
private:
    Allocate allocate_;
    FreeMemory free_;
    size_t budget_, floor_, used_ = 0;
    // On the heap: the session lives on app_main's stack, which has no room for 48 entries (v75 boot loop).
    std::unique_ptr<Frame[]> frames_;
};
}
