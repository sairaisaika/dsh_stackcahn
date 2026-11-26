// SPDX-License-Identifier: MIT
// Emulator proof for the existing two-slot StackChan layout.
#include <stdio.h>
#include <string.h>
#include "esp_ota_ops.h"
#include "esp_system.h"
#include "reviewed_stock_digest.h"

_Static_assert(sizeof reviewed_stock_digest == 32, "Expected a SHA-256 digest");

static esp_err_t try_return_to_stock(void)
{
    const esp_partition_t* running = esp_ota_get_running_partition();
    const esp_partition_t* boot = esp_ota_get_boot_partition();
    if (!running || !boot || running->address != boot->address ||
        (running->subtype != ESP_PARTITION_SUBTYPE_APP_OTA_0 &&
         running->subtype != ESP_PARTITION_SUBTYPE_APP_OTA_1)) {
        return ESP_ERR_INVALID_STATE;
    }

    const esp_partition_t* stock = esp_ota_get_next_update_partition(running);
    esp_ota_img_states_t running_state, stock_state;
    if (!stock || stock->subtype != (running->subtype ^ 1) ||
        esp_ota_get_state_partition(running, &running_state) != ESP_OK ||
        (running_state != ESP_OTA_IMG_PENDING_VERIFY && running_state != ESP_OTA_IMG_VALID) ||
        esp_ota_get_state_partition(stock, &stock_state) != ESP_OK ||
        stock_state != ESP_OTA_IMG_VALID) {
        return ESP_ERR_INVALID_STATE;
    }

    uint8_t actual_digest[sizeof reviewed_stock_digest];
    if (esp_partition_get_sha256(stock, actual_digest) != ESP_OK ||
        memcmp(actual_digest, reviewed_stock_digest, sizeof actual_digest) != 0) {
        return ESP_ERR_INVALID_CRC;
    }

    // Retain the confirmed stock record. Reselecting stock would create a NEW
    // record and expose a working stock image to rollback on its next reboot.
    return esp_ota_mark_app_invalid_rollback();
}

void __attribute__((noinline)) sion_app_center_return_refused(void)
{
    asm volatile("" ::: "memory");
}

void app_main(void)
{
    const esp_err_t status = try_return_to_stock();
    if (status == ESP_OK) {
        puts("SION-APP-CENTER: official slot retained");
        fflush(stdout);
        esp_restart();
    }
    printf("SION-APP-CENTER: refused (%s)\n", esp_err_to_name(status));
    fflush(stdout);
    sion_app_center_return_refused();
}
