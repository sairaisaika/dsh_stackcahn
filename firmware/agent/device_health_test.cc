// SPDX-License-Identifier: MIT
#include "device_health.h"
#include <cassert>
#include <cstdio>
#include <cstring>
using namespace sion::agent::diagnostics;

namespace {
HealthBook book;
HealthSample sample(uint32_t ms, int16_t temperature) {
    HealthSample value{};
    value.boot = 3; value.ms = ms; value.chip_decicelsius = temperature;
    value.busy0 = 120; value.busy1 = 980; value.top_permille = 975; value.top_name = PackName("sion_audio");
    value.touch_gap_ms = 21; value.lvgl_gap_ms = 40; value.ui_gap_ms = 9000;
    value.touch_errors = 2; value.battery = 87; value.flags = BatteryValid | Charging; value.brightness = 70; value.mouth_ticks = 33;
    return value;
}
}

int main(int argc, char** argv) {
    BeginHealth(book, true);
    assert(book.magic == HealthMagic && book.schema == HealthSchema && book.bytes == sizeof(HealthBook) && book.latest == 0);
    PutHealth(book, sample(10000, 412));
    assert(book.latest == 1 && book.samples[0].sequence == 1 && book.samples[0].chip_decicelsius == 412);
    BeginHealth(book, false);  // A warm restart keeps the history.
    assert(book.latest == 1 && book.samples[0].sequence == 1);
    for (uint32_t i = 1; i < HealthCapacity + 5; ++i) PutHealth(book, sample(10000 + 30000 * i, static_cast<int16_t>(412 + i)));
    assert(book.latest == HealthCapacity + 5);
    assert(book.samples[4].sequence == HealthCapacity + 5 && book.samples[5].sequence == 6);  // Oldest overwritten first.
    assert(book.samples[4].chip_decicelsius == 412 + HealthCapacity + 4);
    assert(book.samples[4].mouth_ticks == 33);
    book.schema = 99; BeginHealth(book, false);  // A different layout is cleared, not misread.
    assert(book.schema == HealthSchema && book.latest == 0 && book.samples[4].sequence == 0);

    assert(Permille(25, 100) == 250 && Permille(200, 100) == 1000 && Permille(1, 0) == HealthUnknown);
    assert(Clip16(70000) == 0xfffe && Clip16(12) == 12);
    { HealthSample latest{}; assert(LatestHealthIn(book, latest) == false); }  // Cleared ring: nothing to report.
    assert(PackName("ab") == 0x6261 && PackName("sion_audio") == 0x6e6f6973 && PackName(nullptr) == 0);

    GapWindow gaps;
    uint16_t gap = 0; uint8_t errors = 0;
    gaps.Take(500, gap, errors);
    assert(gap == 500 && errors == 0);  // Never noted: the whole time since boot.
    gaps.Note(1000); gaps.Note(1020); gaps.Note(1100, false); gaps.Note(1120);
    gaps.Take(1130, gap, errors);
    assert(gap == 80 && errors == 1);
    gaps.Take(1140, gap, errors);
    assert(gap == 20 && errors == 0);    // Window reset; still the time since the last note.
    gaps.Take(9120, gap, errors);
    assert(gap == 8000);                 // A producer that stopped is visible without a new note.
    for (int i = 0; i < 300; ++i) gaps.Note(10000 + i, false);
    gaps.Take(10300, gap, errors);
    assert(errors == 255);

    if (argc > 1) {  // Fixture for the Python decoder: four samples, one torn.
        BeginHealth(book, true);
        for (uint32_t i = 0; i < 4; ++i) PutHealth(book, sample(10000 + 30000 * i, static_cast<int16_t>(400 + 10 * i)));
        book.samples[2].sequence = 0;
        book.samples[3].chip_decicelsius = HealthNoTemperature;
        book.samples[3].flags |= TemperatureFailed;
        FILE* out = std::fopen(argv[1], "wb");
        assert(out && std::fwrite(&book, sizeof(book), 1, out) == 1 && std::fclose(out) == 0);
    }
    std::puts("Device health: ring order, warm keep, layout reset, permille, gap windows and decoder fixture passed");
}
