// SPDX-License-Identifier: MIT
#pragma once
#include <atomic>
#include <cstdint>

// Periodic body-health samples for diagnosing heat and touch freezes. Kept in
// RTC memory beside the event trace and read by the Mac over JTAG without a
// reset. Nothing here changes behaviour; it only observes.
namespace sion::agent::diagnostics {
constexpr uint32_t HealthMagic = 0x484c5448;  // "HTLH" little-endian on the wire
constexpr uint32_t HealthSchema = 1;
constexpr uint32_t HealthCapacity = 40;       // 20 minutes at one sample per 30 s
constexpr uint16_t HealthUnknown = 0xffff;
constexpr int16_t HealthNoTemperature = INT16_MIN;
enum HealthFlag : uint8_t { BatteryValid = 1, Charging = 2, Discharging = 4, TemperatureFailed = 8, TaskTableFull = 16 };

struct HealthSample {
    uint32_t sequence, boot, ms;
    int16_t chip_decicelsius;        // ESP32-S3 die temperature, 0.1 °C
    uint16_t busy0, busy1;           // Per-core share not spent in the idle task, permille
    uint16_t top_permille;           // Busiest non-idle task, permille of the window
    uint32_t top_name;               // First four bytes of that task's name
    uint16_t touch_gap_ms;           // Longest wait between touch-panel polls (20 ms timer)
    uint16_t lvgl_gap_ms;            // Longest wait between LVGL pointer reads
    uint16_t ui_gap_ms;              // Longest wait between application loop passes
    uint8_t touch_errors;            // Failed touch-panel reads in the window
    uint8_t battery;                 // Percent, 0xff unknown
    uint8_t flags;                   // HealthFlag
    uint8_t brightness;              // Backlight setting, 0xff unknown
    uint16_t mouth_ticks;            // Application loop passes with the avatar mouth open
};
static_assert(sizeof(HealthSample) == 36);

struct HealthBook {
    uint32_t magic, schema, bytes, latest;
    HealthSample samples[HealthCapacity];
};
static_assert(sizeof(HealthBook) == 16 + 36 * HealthCapacity);

inline void BeginHealth(volatile HealthBook& book, bool cold) {
    if (!cold && book.magic == HealthMagic && book.schema == HealthSchema && book.bytes == sizeof(HealthBook)) return;
    book.magic = 0;
    book.schema = HealthSchema;
    book.bytes = sizeof(HealthBook);
    book.latest = 0;
    for (auto& sample : book.samples) sample.sequence = 0;
    __atomic_store_n(&book.magic, HealthMagic, __ATOMIC_RELEASE);
}

// One writer. A zero sequence marks a sample the debugger caught mid-update.
inline void PutHealth(volatile HealthBook& book, const HealthSample& value) {
    const uint32_t sequence = book.latest == UINT32_MAX ? 1 : book.latest + 1;
    auto& slot = book.samples[(sequence - 1) % HealthCapacity];
    __atomic_store_n(&slot.sequence, 0, __ATOMIC_SEQ_CST);
    slot.boot = value.boot;
    slot.ms = value.ms;
    slot.chip_decicelsius = value.chip_decicelsius;
    slot.busy0 = value.busy0;
    slot.busy1 = value.busy1;
    slot.top_permille = value.top_permille;
    slot.top_name = value.top_name;
    slot.touch_gap_ms = value.touch_gap_ms;
    slot.lvgl_gap_ms = value.lvgl_gap_ms;
    slot.ui_gap_ms = value.ui_gap_ms;
    slot.touch_errors = value.touch_errors;
    slot.battery = value.battery;
    slot.flags = value.flags;
    slot.brightness = value.brightness;
    slot.mouth_ticks = value.mouth_ticks;
    __atomic_store_n(&slot.sequence, sequence, __ATOMIC_RELEASE);
    book.latest = sequence;
}

// Latest complete sample, or false when none is committed yet.
inline bool LatestHealthIn(const volatile HealthBook& book, HealthSample& out) {
    const uint32_t latest = book.latest;
    if (book.magic != HealthMagic || book.schema != HealthSchema || !latest) return false;
    const auto& slot = book.samples[(latest - 1) % HealthCapacity];
    if (__atomic_load_n(&slot.sequence, __ATOMIC_ACQUIRE) != latest) return false;
    out.sequence = latest; out.boot = slot.boot; out.ms = slot.ms;
    out.chip_decicelsius = slot.chip_decicelsius; out.busy0 = slot.busy0; out.busy1 = slot.busy1;
    out.top_permille = slot.top_permille; out.top_name = slot.top_name;
    out.touch_gap_ms = slot.touch_gap_ms; out.lvgl_gap_ms = slot.lvgl_gap_ms; out.ui_gap_ms = slot.ui_gap_ms;
    out.touch_errors = slot.touch_errors; out.battery = slot.battery; out.flags = slot.flags; out.brightness = slot.brightness;
    out.mouth_ticks = slot.mouth_ticks;
    // A sample overwritten while it was being copied is not reported.
    return __atomic_load_n(&slot.sequence, __ATOMIC_ACQUIRE) == latest;
}

inline uint16_t Clip16(uint64_t value) { return value > 0xfffe ? 0xfffe : static_cast<uint16_t>(value); }
inline uint16_t Permille(uint64_t part, uint64_t whole) {
    if (!whole) return HealthUnknown;
    const uint64_t value = part * 1000 / whole;
    return value > 1000 ? 1000 : static_cast<uint16_t>(value);
}
inline uint32_t PackName(const char* name) {
    uint32_t packed = 0;
    for (int i = 0; i < 4 && name && name[i]; ++i) packed |= static_cast<uint32_t>(static_cast<uint8_t>(name[i])) << (8 * i);
    return packed;
}

// Longest interval between Note calls since the last Take, and how many of
// them reported a failure. Note runs on the producer's task; Take on the
// sampler. A producer that has stopped shows up as the time since its last Note.
class GapWindow {
public:
    void Note(uint32_t ms, bool ok = true) {
        const uint32_t last = last_.exchange(ms, std::memory_order_relaxed);
        if (last) {
            const uint32_t gap = ms - last;
            uint32_t longest = longest_.load(std::memory_order_relaxed);
            while (gap > longest && !longest_.compare_exchange_weak(longest, gap, std::memory_order_relaxed)) {}
        }
        if (!ok) errors_.fetch_add(1, std::memory_order_relaxed);
    }
    void Take(uint32_t now, uint16_t& gap_ms, uint8_t& errors) {
        const uint32_t last = last_.load(std::memory_order_relaxed);
        uint32_t longest = longest_.exchange(0, std::memory_order_relaxed);
        const uint32_t since = last ? now - last : now;
        if (since > longest) longest = since;
        gap_ms = Clip16(longest);
        const uint32_t failed = errors_.exchange(0, std::memory_order_relaxed);
        errors = failed > 255 ? 255 : static_cast<uint8_t>(failed);
    }
private:
    std::atomic<uint32_t> last_{0}, longest_{0}, errors_{0};
};

#ifdef ESP_PLATFORM
// Starts the sampler task once. Call after the board is initialised.
bool StartDeviceHealth();
bool LatestHealth(HealthSample& out);
void NoteTouchPoll(bool ok);
void NoteLvglProgress();
void NoteUiProgress();
// Once per application loop pass while the avatar shows an open mouth.
void NoteMouthOpen();
#else
inline bool StartDeviceHealth() { return true; }
inline bool LatestHealth(HealthSample&) { return false; }
inline void NoteTouchPoll(bool) {}
inline void NoteLvglProgress() {}
inline void NoteUiProgress() {}
inline void NoteMouthOpen() {}
#endif
}  // namespace sion::agent::diagnostics
