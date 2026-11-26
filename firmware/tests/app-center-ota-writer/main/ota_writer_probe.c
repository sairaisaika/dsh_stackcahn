// SPDX-License-Identifier: MIT
#include "esp_flash.h"
#include "esp_ota_ops.h"

#include <assert.h>
#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>

// This header and application payload exist only in the emulator fixture.
enum { fixture_address = 0xe10000, fixture_bound = 0xffb000, fixture_marker = 0x544f4953 };
typedef struct {
    uint32_t marker, image_bytes, stream_bytes;
} stream_fixture_t;

esp_err_t __real_esp_partition_erase_range(const esp_partition_t *partition, size_t offset, size_t size);
esp_err_t __wrap_esp_partition_erase_range(const esp_partition_t *partition, size_t offset, size_t size)
{
    esp_err_t result = __real_esp_partition_erase_range(partition, offset, size);
    if (result == ESP_OK) {
        printf("SION-OTA ERASE %08" PRIx32 " %zu\n", partition->address + (uint32_t)offset, size);
    }
    return result;
}

__attribute__((noinline, used, noreturn)) void sion_ota_writer_probe_done(void)
{
    for (;;) __asm__ volatile("nop");
}

void app_main(void)
{
    stream_fixture_t fixture;
    ESP_ERROR_CHECK(esp_flash_read(NULL, &fixture, fixture_address, sizeof(fixture)));
    assert(fixture.marker == fixture_marker);
    assert(fixture.image_bytes <= fixture_bound - fixture_address - sizeof(fixture));
    assert(fixture.image_bytes > 0 && fixture.stream_bytes <= fixture.image_bytes);

    const esp_partition_t *running = esp_ota_get_running_partition();
    const esp_partition_t *target = esp_ota_get_next_update_partition(NULL);
    assert(running && (running->subtype == ESP_PARTITION_SUBTYPE_APP_OTA_0 ||
                       running->subtype == ESP_PARTITION_SUBTYPE_APP_OTA_1));
    assert(target && target->subtype == (running->subtype ^ 1));
    esp_ota_handle_t handle;
    ESP_ERROR_CHECK(esp_ota_begin(target, OTA_WITH_SEQUENTIAL_WRITES, &handle));

    // Fixed unaligned chunks exercise writes within a sector and across boundaries.
    static uint8_t buffer[1021];
    for (uint32_t offset = 0; offset < fixture.stream_bytes;) {
        size_t size = fixture.stream_bytes - offset;
        if (size > sizeof(buffer)) size = sizeof(buffer);
        ESP_ERROR_CHECK(esp_flash_read(NULL, buffer, fixture_address + sizeof(fixture) + offset, size));
        ESP_ERROR_CHECK(esp_ota_write(handle, buffer, size));
        offset += size;
    }

    if (fixture.stream_bytes < fixture.image_bytes) {
        ESP_ERROR_CHECK(esp_ota_abort(handle));
        puts("SION-OTA RESULT partial");
    } else {
        esp_err_t result = esp_ota_end(handle);
        if (result == ESP_ERR_OTA_VALIDATE_FAILED) {
            puts("SION-OTA RESULT rejected");
        } else {
            ESP_ERROR_CHECK(result);
            ESP_ERROR_CHECK(esp_ota_set_boot_partition(target));
            puts("SION-OTA RESULT selected");
        }
    }
    fflush(stdout);
    sion_ota_writer_probe_done();
}
