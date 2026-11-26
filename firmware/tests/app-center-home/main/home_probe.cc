// SPDX-License-Identifier: MIT
#include <cstdio>
#include <cstdlib>
#include "esp_flash.h"
#include "home_menu_request.h"

using namespace sion::app_center;

namespace {
// Test mode comes from virtual flash. The probe never writes to flash itself.
constexpr uint32_t fixture_offset = 0xe10000;
}

extern "C" __attribute__((noinline, used, noreturn)) void sion_home_probe_done() {
    for (;;) asm volatile("nop");
}

extern "C" void app_main() {
    uint8_t fixture;
    if (esp_flash_read(nullptr, &fixture, fixture_offset, sizeof(fixture)) != ESP_OK) std::abort();
    const auto reason = esp_reset_reason();
    const auto* running = esp_ota_get_running_partition();
    if (!running) std::abort();
    if (running->subtype == ESP_PARTITION_SUBTYPE_APP_OTA_0) {
        const auto* stock = esp_ota_get_next_update_partition(running);
        esp_ota_img_states_t state;
        if (!stock || esp_ota_get_state_partition(running, &state) != ESP_OK || state != ESP_OTA_IMG_PENDING_VERIFY)
            std::abort();
        ClearHomeMenuRequest();
        if (fixture != 'N') RequestHomeMenu(fixture == 'W' ? running->address : stock->address);
        if (fixture == 'T') {
            HomeRequestWords()[3] = 0;
            OrderHomeRequestWrites();
        }
        std::printf("SION-HOME: sender pending, fixture=%c\n", fixture);
        std::fflush(stdout);
        esp_restart();
    }
    if (fixture == 'C' && reason == ESP_RST_POWERON) RequestHomeMenu(running->address);
    const bool menu = TakeHomeMenuRequest();
    std::printf("SION-HOME: receiver software=%d menu=%d clear=%d\n", reason == ESP_RST_SW, menu,
                HomeRequestWords()[0] == 0);
    std::fflush(stdout);
    if (menu || (fixture == 'C' && reason == ESP_RST_POWERON)) esp_restart();
    sion_home_probe_done();
}
