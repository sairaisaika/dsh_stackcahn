// SPDX-License-Identifier: MIT
// CPU share uses FreeRTOS run-time stats (esp_timer microseconds in this
// build, CONFIG_FREERTOS_RUN_TIME_STATS_USING_ESP_TIMER) and the ESP-IDF
// per-core idle counters. Die temperature uses the esp_driver_tsens API.
#include "device_health.h"
#include "device_trace.h"
#include <array>
#include <cstdint>
#include <driver/temperature_sensor.h>
#include <esp_attr.h>
#include <esp_timer.h>
#include <freertos/FreeRTOS.h>
#include <freertos/idf_additions.h>
#include <freertos/task.h>

bool ReadAgentBattery(int& percent, bool& charging, bool& discharging);
namespace hal_bridge { uint8_t board_get_backlight_brightness(); }

extern "C" {
RTC_NOINIT_ATTR volatile sion::agent::diagnostics::HealthBook sion_device_health;
extern volatile sion::agent::diagnostics::Book sion_device_trace;
}

namespace sion::agent::diagnostics {
namespace {
constexpr uint32_t FirstSampleMs = 10000, IntervalMs = 30000;
constexpr size_t MaxTasks = 40;
GapWindow touch_window, lvgl_window, ui_window;
std::atomic<uint32_t> mouth_ticks{0};
uint32_t Millis() { return static_cast<uint32_t>(esp_timer_get_time() / 1000); }

struct TaskUsage {
    std::array<TaskStatus_t, MaxTasks> now{};
    std::array<TaskHandle_t, MaxTasks> handles{};
    std::array<uint32_t, MaxTasks> counters{};
    size_t known = 0;
};
TaskUsage usage;  // Sampler task only; kept off its stack.

// Busiest task other than the two idle tasks since the previous sample.
void BusiestTask(uint32_t elapsed_us, HealthSample& out) {
    const UBaseType_t count = uxTaskGetSystemState(usage.now.data(), usage.now.size(), nullptr);
    if (count == 0) out.flags |= TaskTableFull;  // More tasks than the table holds.
    const TaskHandle_t idle0 = xTaskGetIdleTaskHandleForCore(0), idle1 = xTaskGetIdleTaskHandleForCore(1);
    uint32_t best = 0;
    for (UBaseType_t i = 0; i < count; ++i) {
        const auto& task = usage.now[i];
        if (task.xHandle == idle0 || task.xHandle == idle1) continue;
        uint32_t previous = task.ulRunTimeCounter;
        for (size_t k = 0; k < usage.known; ++k)
            if (usage.handles[k] == task.xHandle) { previous = usage.counters[k]; break; }
        const uint32_t delta = static_cast<uint32_t>(task.ulRunTimeCounter) - previous;
        if (delta >= best) { best = delta; out.top_name = PackName(task.pcTaskName); }
    }
    out.top_permille = usage.known ? Permille(best, elapsed_us) : HealthUnknown;
    usage.known = count;
    for (UBaseType_t i = 0; i < count; ++i) {
        usage.handles[i] = usage.now[i].xHandle;
        usage.counters[i] = usage.now[i].ulRunTimeCounter;
    }
}

void Sampler(void*) {
    temperature_sensor_handle_t sensor = nullptr;
    temperature_sensor_config_t config = TEMPERATURE_SENSOR_CONFIG_DEFAULT(20, 100);
    const bool sensor_ready = temperature_sensor_install(&config, &sensor) == ESP_OK &&
        temperature_sensor_enable(sensor) == ESP_OK;
    uint32_t last_us = static_cast<uint32_t>(esp_timer_get_time());
    uint32_t idle0 = ulTaskGetIdleRunTimeCounterForCore(0), idle1 = ulTaskGetIdleRunTimeCounterForCore(1);
    HealthSample seed{};
    BusiestTask(1, seed);  // Seeds the per-task counters; the result is discarded.
    vTaskDelay(pdMS_TO_TICKS(FirstSampleMs));
    for (;;) {
        HealthSample sample{};
        sample.boot = sion_device_trace.boot;
        sample.ms = Millis();
        const uint32_t now_us = static_cast<uint32_t>(esp_timer_get_time());
        const uint32_t elapsed = now_us - last_us;
        const uint32_t next0 = ulTaskGetIdleRunTimeCounterForCore(0), next1 = ulTaskGetIdleRunTimeCounterForCore(1);
        const uint16_t idle_share0 = Permille(next0 - idle0, elapsed), idle_share1 = Permille(next1 - idle1, elapsed);
        sample.busy0 = idle_share0 == HealthUnknown ? HealthUnknown : static_cast<uint16_t>(1000 - idle_share0);
        sample.busy1 = idle_share1 == HealthUnknown ? HealthUnknown : static_cast<uint16_t>(1000 - idle_share1);
        BusiestTask(elapsed, sample);
        idle0 = next0; idle1 = next1; last_us = now_us;
        float celsius = 0;
        if (sensor_ready && temperature_sensor_get_celsius(sensor, &celsius) == ESP_OK)
            sample.chip_decicelsius = static_cast<int16_t>(celsius * 10);
        else {
            sample.chip_decicelsius = HealthNoTemperature;
            sample.flags |= TemperatureFailed;
        }
        uint8_t touch_errors = 0, unused = 0;
        touch_window.Take(sample.ms, sample.touch_gap_ms, touch_errors);
        lvgl_window.Take(sample.ms, sample.lvgl_gap_ms, unused);
        ui_window.Take(sample.ms, sample.ui_gap_ms, unused);
        sample.touch_errors = touch_errors;
        sample.mouth_ticks = Clip16(mouth_ticks.exchange(0, std::memory_order_relaxed));
        int percent = 0;
        bool charging = false, discharging = false;
        if (ReadAgentBattery(percent, charging, discharging) && percent >= 0 && percent <= 100) {
            sample.battery = static_cast<uint8_t>(percent);
            sample.flags |= BatteryValid | (charging ? Charging : 0) | (discharging ? Discharging : 0);
        } else sample.battery = 0xff;
        sample.brightness = hal_bridge::board_get_backlight_brightness();
        PutHealth(sion_device_health, sample);
        vTaskDelay(pdMS_TO_TICKS(IntervalMs));
    }
}
}

bool StartDeviceHealth() {
    static bool started = false;
    if (started) return true;
    BeginHealth(sion_device_health, sion_device_trace.boot <= 1);
    // Above the application tasks so a busy one cannot hide itself by starving the sampler.
    started = xTaskCreate(Sampler, "sion_health", 4096, nullptr, 15, nullptr) == pdPASS;
    return started;
}
bool LatestHealth(HealthSample& out) { return LatestHealthIn(sion_device_health, out); }
void NoteTouchPoll(bool ok) { touch_window.Note(Millis(), ok); }
void NoteLvglProgress() { lvgl_window.Note(Millis()); }
void NoteUiProgress() { ui_window.Note(Millis()); }
void NoteMouthOpen() { mouth_ticks.fetch_add(1, std::memory_order_relaxed); }
}  // namespace sion::agent::diagnostics
