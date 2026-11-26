// SPDX-License-Identifier: MIT
#pragma once
#include "sdkconfig.h"
#include "bootloader_common.h"
#include "menu_request.h"

#if !CONFIG_BOOTLOADER_CUSTOM_RESERVE_RTC || CONFIG_BOOTLOADER_CUSTOM_RESERVE_RTC_SIZE != SION_MENU_REQUEST_BYTES || \
    CONFIG_BOOTLOADER_RESERVE_RTC_SIZE != 0x10 || CONFIG_BOOTLOADER_CUSTOM_RESERVE_RTC_IN_CRC || \
    CONFIG_SECURE_BOOT_ROM_FAST_WAKE_RESERVE_SIZE
#error "The menu prototype requires the same dedicated RTC reservation in both builds"
#endif
#if defined(BOOTLOADER_BUILD) && CONFIG_BOOTLOADER_PROJECT_VER != SION_MENU_BOOT_VERSION
#error "The bootloader descriptor must announce the same menu protocol as the applications"
#endif

static inline volatile uint8_t* sion_menu_memory(void)
{
    return bootloader_common_get_rtc_retain_mem()->custom;
}
