// SPDX-License-Identifier: MIT
#include "app_center_reopen.h"
#include <esp_flash.h>
#include <assert.h>
#include <cstdio>

namespace {
constexpr uint32_t FixtureAddress = 0xe10000;
constexpr uint32_t Marker = 0x4f50454e;
struct Fixture {
    uint32_t marker, queue_update;
    char digest[64];
};
unsigned selections = 0;
}

extern "C" esp_err_t __real_esp_ota_set_boot_partition(const esp_partition_t*);
extern "C" esp_err_t __wrap_esp_ota_set_boot_partition(const esp_partition_t* target)
{
    ++selections;
    return __real_esp_ota_set_boot_partition(target);
}

extern "C" __attribute__((noinline, used, noreturn)) void sion_reopen_probe_done()
{
    for (;;) asm volatile("nop");
}

extern "C" void app_main()
{
    Fixture request;
    ESP_ERROR_CHECK(esp_flash_read(nullptr, &request, FixtureAddress, sizeof(request)));
    assert(request.marker == Marker);
    if (request.queue_update) {
        // Model a selection made by Setup before the App Center action.
        ESP_ERROR_CHECK(__real_esp_ota_set_boot_partition(esp_ota_get_next_update_partition(nullptr)));
    }
    const bool selected = app_center::selectInstalledApp({request.digest, sizeof(request.digest)});
    printf("SION-REOPEN result=%d selectCalls=%u\n", selected, selections);
    fflush(stdout);
    sion_reopen_probe_done();
}
