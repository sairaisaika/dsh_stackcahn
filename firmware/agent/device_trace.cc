// SPDX-License-Identifier: MIT
#include "screen_touch.h"
#include "device_trace.h"

namespace sion::agent::diagnostics {
namespace {
uint16_t page_for_flush = 0;
constexpr uint32_t TouchCheckpointIntervalMs = 1000;
}

void SetPageForFlush(uint16_t revision) { page_for_flush = revision; }
uint16_t TakePageForFlush() {
    const auto revision = page_for_flush;
    page_for_flush = 0;
    return revision;
}

void Put(volatile Book& book, Lane lane, Event event, uint32_t ms, uint32_t detail, bool checkpoint) {
    // Each lane's writes are serialized by its owner. The debugger halts both cores
    // before reading. A zero sequence exposes an interrupted update.
    auto& stream = book.lanes[static_cast<uint32_t>(lane)];
    const uint32_t prior = checkpoint ? stream.checkpoint.sequence : stream.latest;
    const uint32_t sequence = prior == UINT32_MAX ? 1 : prior + 1;
    auto& entry = checkpoint ? stream.checkpoint : stream.entries[(sequence - 1) % Capacity];
    __atomic_store_n(&entry.sequence, 0, __ATOMIC_SEQ_CST);
    entry.boot = book.boot;
    entry.ms = ms;
    entry.event = static_cast<uint32_t>(event);
    entry.detail = detail;
    __atomic_store_n(&entry.sequence, sequence, __ATOMIC_RELEASE);
    if (!checkpoint) stream.latest = sequence;
}

void Begin(volatile Book& book, uint32_t reset_reason, bool cold) {
    if (cold || book.magic != Magic || book.schema != Schema || book.bytes != sizeof(Book) ||
        !book.boot || book.boot == UINT32_MAX) {
        book.magic = 0;
        book.schema = Schema;
        book.bytes = sizeof(Book);
        book.boot = 0;
        for (auto& lane : book.lanes) {
            lane.latest = 0;
            lane.checkpoint.sequence = 0;
            for (auto& entry : lane.entries) entry.sequence = 0;
        }
        __atomic_store_n(&book.magic, Magic, __ATOMIC_RELEASE);
    }
    book.boot = book.boot + 1;
    Put(book, Lane::Boot, Event::Boot, 0, reset_reason, false);
}

uint16_t TouchInputTrace::Sample(volatile Book& book, uint32_t ms, bool valid, bool pressed, int x, int y) {
    if (!valid) {
        if (!failing_) Put(book, Lane::Touch, Event::TouchReadError, ms, gesture_, false);
        failing_ = true;
        return gesture_;
    }
    if (failing_) Put(book, Lane::Touch, Event::TouchReadRecovered, ms, gesture_, false);
    failing_ = false;
    if (pressed != pressed_) {
        if (pressed) {
            gesture_ = NextTraceId(gesture_);
            Put(book, Lane::Touch, Event::TouchDown, ms, gesture_, false);
            Put(book, Lane::Touch, Event::TouchPosition, ms, TracePair(x, y), false);
        } else {
            Put(book, Lane::Touch, Event::TouchUp, ms, gesture_, false);
        }
        pressed_ = pressed;
    }
    if (!last_checkpoint_ms_ || ms - last_checkpoint_ms_ >= TouchCheckpointIntervalMs) {
        Put(book, Lane::Touch, Event::TouchDriverAlive, ms, gesture_, true);
        last_checkpoint_ms_ = ms;
    }
    return gesture_;
}

void LvglInputTrace::Sample(volatile Book& book, uint32_t ms, bool pressed, uint16_t gesture) {
    if (pressed && !pressed_) {
        gesture_ = gesture;
        Put(book, Lane::Lvgl, Event::TouchLvglDown, ms, gesture_, false);
    } else if (!pressed && pressed_) {
        Put(book, Lane::Lvgl, Event::TouchLvglUp, ms, gesture_, false);
    }
    pressed_ = pressed;
    if (!last_checkpoint_ms_ || ms - last_checkpoint_ms_ >= TouchCheckpointIntervalMs) {
        Put(book, Lane::Lvgl, Event::TouchLvglAlive, ms, gesture_, true);
        last_checkpoint_ms_ = ms;
    }
}
}

namespace sion::agent {
ScreenTouchLog& DeviceScreenTouch() { static ScreenTouchLog log; return log; }
}
#ifdef ESP_PLATFORM
#include "device_health.h"
#include <esp_attr.h>
#include <esp_heap_caps.h>
#include <esp_system.h>
#include <esp_timer.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>

extern "C" {
RTC_NOINIT_ATTR volatile sion::agent::diagnostics::Book sion_device_trace;
}

namespace sion::agent::diagnostics {
namespace {
TouchInputTrace driver_touch;
LvglInputTrace lvgl_touch;
uint32_t DeviceMillis() { return static_cast<uint32_t>(esp_timer_get_time() / 1000); }
}

void StartDeviceTrace() {
    const auto reason = esp_reset_reason();
    Begin(sion_device_trace, static_cast<uint32_t>(reason), reason == ESP_RST_POWERON);
}
void Record(Lane lane, Event event, uint32_t detail) {
    Put(sion_device_trace, lane, event, DeviceMillis(), detail, false);
}
void Checkpoint(Lane lane, Event event, uint32_t detail) {
    Put(sion_device_trace, lane, event, DeviceMillis(), detail, true);
}
uint16_t TrackDriverTouch(bool valid, bool pressed, int x, int y) {
    NoteTouchPoll(valid);
    if (valid) DeviceScreenTouch().Note(pressed, x, y, DeviceMillis());
    return driver_touch.Sample(sion_device_trace, DeviceMillis(), valid, pressed, x, y);
}
void TrackLvglTouch(bool pressed, uint16_t gesture) {
    NoteLvglProgress();
    lvgl_touch.Sample(sion_device_trace, DeviceMillis(), pressed, gesture);
}
uint16_t LvglTouchId() { return lvgl_touch.gesture(); }
void RecordUiHealth(uint32_t longest_gap_ms) {
    Record(Lane::Ui, Event::UiHeartbeat, longest_gap_ms);
    Checkpoint(Lane::Ui, Event::UiHealthSample);
    multi_heap_info_t internal{};
    heap_caps_get_info(&internal, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    Record(Lane::Ui, Event::UiInternalFree, internal.total_free_bytes);
    Record(Lane::Ui, Event::UiInternalLargest, internal.largest_free_block);
    Record(Lane::Ui, Event::UiInternalLowWater, internal.minimum_free_bytes);
    Record(Lane::Ui, Event::UiStackLowWater, uxTaskGetStackHighWaterMark(nullptr));
    Record(Lane::Ui, Event::UiExternalFree, heap_caps_get_free_size(MALLOC_CAP_SPIRAM));
}
}
#endif
