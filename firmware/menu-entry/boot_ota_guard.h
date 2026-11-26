// SPDX-License-Identifier: MIT
#pragma once

#include "bootloader_common.h"

static inline bool sion_menu_selected_ota_confirmed(const esp_partition_pos_t* ota)
{
    esp_ota_select_entry_t records[2];
    if (bootloader_common_read_otadata(ota, records) != ESP_OK) return false;
    const int active = bootloader_common_get_active_otadata(records);
    return active >= 0 && records[active].ota_state == ESP_OTA_IMG_VALID;
}
