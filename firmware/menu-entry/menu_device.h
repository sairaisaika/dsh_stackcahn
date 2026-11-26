// SPDX-License-Identifier: MIT
#pragma once
#include "rtc_menu_request.h"
#include <esp_cpu.h>
#include <esp_ota_ops.h>

inline bool sion_menu_selector_installed()
{
    esp_bootloader_desc_t selector{};
    return esp_cpu_get_core_id() == 0 && esp_ota_get_bootloader_description(nullptr, &selector) == ESP_OK &&
        selector.version == SION_MENU_BOOT_VERSION;
}

inline bool sion_menu_once_at_stock_startup()
{
    if (esp_cpu_get_core_id() != 0) return false;
    return sion_menu_consume(sion_menu_memory(), true) == SION_MENU_STOCK_READY &&
        sion_menu_selector_installed();
}
