// SPDX-License-Identifier: MIT
#include "return_to_stock.h"
#include "tail_storage.h"
#include "reviewed_stock_digest.h"
#include <array>
#include <cstring>
#include <esp_ota_ops.h>

uint32_t ReviewedStockReturnAddress()
{
    if (!MatchesReviewedAppCenterLayout()) return 0;
    const auto* running = esp_ota_get_running_partition();
    const auto* selected = esp_ota_get_boot_partition();
    if (!running || !selected || selected->address != running->address ||
        (running->subtype != ESP_PARTITION_SUBTYPE_APP_OTA_0 &&
         running->subtype != ESP_PARTITION_SUBTYPE_APP_OTA_1)) {
        return 0;
    }

    // A restart rolls back only an unconfirmed execution. Both the normal
    // Home path and unexpected resets keep the manufacturer's VALID record.
    esp_ota_img_states_t state;
    if (esp_ota_get_state_partition(running, &state) != ESP_OK || state != ESP_OTA_IMG_PENDING_VERIFY) {
        return 0;
    }
    const auto* stock = esp_ota_get_next_update_partition(running);
    if (!stock || stock->subtype != (running->subtype ^ 1) ||
        esp_ota_get_state_partition(stock, &state) != ESP_OK || state != ESP_OTA_IMG_VALID) {
        return 0;
    }

    static_assert(sizeof reviewed_stock_digest == 32);
    std::array<uint8_t, sizeof reviewed_stock_digest> digest;
    if (esp_partition_get_sha256(stock, digest.data()) != ESP_OK ||
        std::memcmp(digest.data(), reviewed_stock_digest, digest.size()) != 0) return 0;
    return stock->address;
}

bool ReviewedStockCanResume()
{
    return ReviewedStockReturnAddress() != 0;
}
