// SPDX-License-Identifier: MIT
#include "app_center_dsh_shortcut.h"
#include "esp_flash.h"
#include "nvs_flash.h"
#include <cstdio>
#include <cstdlib>

extern "C" __attribute__((noinline, used, noreturn)) void sion_shortcut_probe_done()
{
    for (;;) asm volatile("nop");
}

namespace {

void checkFactorySettings(bool seed)
{
    nvs_handle_t handle;
    ESP_ERROR_CHECK(nvs_open("fixture_stock", seed ? NVS_READWRITE : NVS_READONLY, &handle));
    if (seed) {
        ESP_ERROR_CHECK(nvs_set_u8(handle, "voice", 17));
        ESP_ERROR_CHECK(nvs_set_u8(handle, "binding", 31));
        ESP_ERROR_CHECK(nvs_commit(handle));
    } else {
        uint8_t voice, binding;
        ESP_ERROR_CHECK(nvs_get_u8(handle, "voice", &voice));
        ESP_ERROR_CHECK(nvs_get_u8(handle, "binding", &binding));
        if (voice != 17 || binding != 31) std::abort();
    }
    nvs_close(handle);
}

} // namespace

extern "C" void app_main()
{
    // The caller represents the already verified App Center catalog action.
    constexpr uint32_t fixture_address = 0xe10000;
    char command[65];
    ESP_ERROR_CHECK(esp_flash_read(nullptr, &command, fixture_address, sizeof(command)));
    ESP_ERROR_CHECK(nvs_flash_init());
    const bool seed = command[0] == 'S';
    checkFactorySettings(seed);
    using namespace app_center;
    if (seed) {
        std::puts("SION-SHORTCUT seeded");
    } else if (command[0] == 'I') {
        const std::string_view digest(command+1, 64);
        if (!selectInstalledApp(digest)) std::abort();
        rememberDshShortcut(digest);
        std::puts("SION-SHORTCUT enrolled");
    } else if (command[0] == 'O') {
        switch (selectDshShortcut()) {
        case DshShortcutResult::Selected: std::puts("SION-SHORTCUT opened"); break;
        case DshShortcutResult::SetupRequired: std::puts("SION-SHORTCUT absent"); break;
        case DshShortcutResult::UpdateInProgress: std::puts("SION-SHORTCUT guarded"); break;
        case DshShortcutResult::ImageUnavailable: std::puts("SION-SHORTCUT mismatch"); break;
        }
    } else {
        std::abort();
    }
    std::fflush(stdout);
    sion_shortcut_probe_done();
}
