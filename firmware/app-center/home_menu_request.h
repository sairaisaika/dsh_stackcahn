// SPDX-License-Identifier: MIT
#pragma once

#include <cstdint>
#include "esp_ota_ops.h"
#include "esp_system.h"
#include "sdkconfig.h"
#include "soc/soc.h"

#if !CONFIG_IDF_TARGET_ESP32S3 || !CONFIG_ULP_COPROC_ENABLED || CONFIG_ULP_COPROC_RESERVE_MEM != 32
#error "App Center Home requires the paired 32-byte ESP32-S3 RTC slow memory reservation"
#endif

namespace sion::app_center {

inline constexpr uint32_t home_request_magic = 0x53484d31; // SHM1

// The linker reserves these first words in both applications. Neither may
// load a ULP program into the reservation while this handoff is enabled.
inline volatile uint32_t* HomeRequestWords() {
    return reinterpret_cast<volatile uint32_t*>(SOC_RTC_DATA_LOW);
}

inline void OrderHomeRequestWrites() {
    asm volatile("memw" ::: "memory");
}

inline void ClearHomeMenuRequest() {
    HomeRequestWords()[0] = 0;
    OrderHomeRequestWrites();
}

inline void RequestHomeMenu(uint32_t confirmed_app_address) {
    auto* words = HomeRequestWords();
    ClearHomeMenuRequest();
    words[1] = confirmed_app_address;
    words[2] = ~confirmed_app_address;
    words[3] = ~home_request_magic;
    OrderHomeRequestWrites();
    words[0] = home_request_magic;
    OrderHomeRequestWrites();
}

// Run once on application entry. Invalidate the ticket even if reset or OTA
// state rejects it. Consuming a ticket only changes this boot's UI choice.
inline bool TakeHomeMenuRequest() {
    const auto* words = HomeRequestWords();
    const auto marker = words[0];
    const auto address = words[1];
    const auto inverted_address = words[2];
    const auto inverted_marker = words[3];
    ClearHomeMenuRequest();
    if (esp_reset_reason() != ESP_RST_SW || marker != home_request_magic ||
        inverted_marker != ~marker || inverted_address != ~address) return false;

    const auto* running = esp_ota_get_running_partition();
    const auto* selected = esp_ota_get_boot_partition();
    if (!running || !selected || running->address != address || selected->address != address) return false;
    esp_ota_img_states_t state;
    if (esp_ota_get_state_partition(running, &state) != ESP_OK || state != ESP_OTA_IMG_VALID) return false;

    const auto* previous = esp_ota_get_next_update_partition(running);
    return previous && esp_ota_get_state_partition(previous, &state) == ESP_OK && state == ESP_OTA_IMG_ABORTED;
}

} // namespace sion::app_center
