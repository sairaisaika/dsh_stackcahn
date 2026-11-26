// SPDX-License-Identifier: MIT
#include "tail_storage.h"
#include "reviewed_layout.h"
#include <algorithm>
#include <array>
#include <esp_flash.h>
#include <esp_flash_encrypt.h>
#include <esp_partition.h>
#include <sha/sha_core.h>

namespace {
constexpr uint32_t FlashSize = 0x1000000;
constexpr uint32_t SectorSize = 0x1000;
constexpr uint32_t ConfigAddress = 0xffc000;
constexpr uint32_t OwnerAddress = ConfigAddress - SectorSize;

bool IsErased(uint32_t address, size_t length)
{
    std::array<uint8_t, 256> bytes;
    for (size_t offset = 0; offset < length; offset += bytes.size()) {
        const size_t count = std::min(bytes.size(), length - offset);
        if (esp_flash_read(nullptr, bytes.data(), address + offset, count) != ESP_OK ||
            !std::all_of(bytes.begin(), bytes.begin() + count, [](uint8_t b) { return b == 0xff; })) {
            return false;
        }
    }
    return true;
}

}  // namespace

bool MatchesReviewedAppCenterLayout()
{
    uint32_t size = 0;
    std::array<uint8_t, SectorSize> table;
    std::array<uint8_t, 32> digest;
    if (esp_flash_encryption_enabled() ||
        esp_flash_get_physical_size(nullptr, &size) != ESP_OK || size != FlashSize ||
        esp_flash_read(nullptr, table.data(), CONFIG_PARTITION_TABLE_OFFSET, table.size()) != ESP_OK) {
        return false;
    }
    esp_sha(SHA2_256, table.data(), table.size(), digest.data());
    return digest == ReviewedTableDigest;
}

esp_err_t RegisterReviewedTailStorage()
{
    if (!MatchesReviewedAppCenterLayout()) return ESP_ERR_NOT_SUPPORTED;

    std::array<uint8_t, ReviewedOwnerRecord.size()> record;
    const auto read = esp_flash_read(nullptr, record.data(), OwnerAddress, record.size());
    if (read != ESP_OK) return read;

    const bool owned = record == ReviewedOwnerRecord &&
                       IsErased(OwnerAddress + record.size(), SectorSize - record.size());
    if (!owned && !IsErased(OwnerAddress, FlashSize - OwnerAddress)) {
        return ESP_ERR_INVALID_STATE;
    }

    const esp_partition_t* config = nullptr;
    auto status = esp_partition_register_external(nullptr, ConfigAddress, FlashSize - ConfigAddress,
                                                  "sion_cfg", ESP_PARTITION_TYPE_DATA,
                                                  ESP_PARTITION_SUBTYPE_DATA_NVS, &config);
    if (status != ESP_OK || owned) return status;

    // Claim the previously erased tail. NVS must not initialize until this
    // write is verified. A partial or foreign ownership record fails closed.
    status = esp_flash_write(nullptr, ReviewedOwnerRecord.data(), OwnerAddress, record.size());
    if (status == ESP_OK) status = esp_flash_read(nullptr, record.data(), OwnerAddress, record.size());
    if (status == ESP_OK && record == ReviewedOwnerRecord) return ESP_OK;
    esp_partition_deregister_external(config);
    return status == ESP_OK ? ESP_ERR_INVALID_CRC : status;
}
