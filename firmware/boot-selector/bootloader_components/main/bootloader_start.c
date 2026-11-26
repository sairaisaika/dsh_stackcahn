// Bootloader entry derived from ESP-IDF's bootloader override example.
// SPDX-FileCopyrightText: 2015-2024 Espressif Systems (Shanghai) CO LTD
// SPDX-License-Identifier: Apache-2.0

#include <stdbool.h>
#include <stdint.h>
#include "sdkconfig.h"
#include "bootloader_init.h"
#include "bootloader_utility.h"
#include "esp_image_format.h"
#include "esp_log.h"
#include "esp_rom_gpio.h"
#include "esp_rom_sys.h"
#include "hal/gpio_ll.h"
#include "soc/io_mux_reg.h"
#include "soc/soc.h"

#if defined(CONFIG_BOOTLOADER_APP_TEST) || defined(CONFIG_BOOTLOADER_FACTORY_RESET) || \
    defined(CONFIG_BOOTLOADER_SKIP_VALIDATE_IN_DEEP_SLEEP) || \
    defined(CONFIG_BOOTLOADER_SKIP_VALIDATE_ON_POWER_ON) || defined(CONFIG_BOOTLOADER_SKIP_VALIDATE_ALWAYS) || \
    defined(CONFIG_SECURE_ENABLE_TEE) || defined(CONFIG_BOOTLOADER_APP_ANTI_ROLLBACK)
#error "This prototype requires the pinned ESP32-S3 Sion boot policy"
#endif

#ifdef ESP_LOG_ATTR_TAG
ESP_LOG_ATTR_TAG(TAG, "sion-boot");
#else
static const char *const TAG = "sion-boot";
#endif

enum {
    SELECT_PIN = 9,             // StackChan Grove Port B, candidate input
    SAMPLE_US = 10000,
    HELD_SAMPLES = 60,          // 600 ms continuously low after settling
    RELEASE_SAMPLES = 5,        // Four full intervals between high samples
    RELEASE_WINDOW = 150,      // 1.5 s maximum to release
};

static bool read_entry_gesture(void)
{
    const uint32_t mux = REG_READ(IO_MUX_GPIO9_REG);
    esp_rom_gpio_pad_select_gpio(SELECT_PIN);
    gpio_ll_input_enable(&GPIO, SELECT_PIN);
    esp_rom_gpio_pad_pullup_only(SELECT_PIN);
    esp_rom_delay_us(2000); // Let the pull-up settle before treating a low as input.

    bool accepted = false;
    if (gpio_ll_get_level(&GPIO, SELECT_PIN)) {
        goto restore;
    }
    for (unsigned i = 0; i < HELD_SAMPLES; ++i) {
        esp_rom_delay_us(SAMPLE_US);
        if (gpio_ll_get_level(&GPIO, SELECT_PIN)) {
            goto restore;
        }
    }
    unsigned released = 0;
    for (unsigned i = 0; i < RELEASE_WINDOW; ++i) {
        esp_rom_delay_us(SAMPLE_US);
        released = gpio_ll_get_level(&GPIO, SELECT_PIN) ? released + 1 : 0;
        if (released == RELEASE_SAMPLES) {
            accepted = true;
            break;
        }
    }
restore:
    REG_WRITE(IO_MUX_GPIO9_REG, mux);
    return accepted;
}

static bool layout_matches(const bootloader_state_t *bs)
{
    return bs->app_count == 2 && bs->factory.size == 0 &&
           bs->ota_info.offset == 0xd000 && bs->ota_info.size == 0x2000 &&
           bs->ota[0].offset == 0x20000 && bs->ota[0].size == 0x4f0000 &&
           bs->ota[1].offset == 0x510000 && bs->ota[1].size == 0x4f0000 &&
           bs->test.offset == 0xe10000 && bs->test.size == 0x1ec000;
}

static bool agent_image_valid(const esp_partition_pos_t *part)
{
    esp_image_metadata_t image = {0};
    return esp_image_verify(ESP_IMAGE_VERIFY, part, &image) == ESP_OK &&
           image.image.hash_appended && image.image_len > 0 && image.image_len <= part->size;
}

void __attribute__((noreturn)) call_start_cpu0(void)
{
    bootloader_state_t bs = {0};
    if (bootloader_init() != ESP_OK || !bootloader_utility_load_partition_table(&bs)) {
        bootloader_reset();
    }

    // Never run the OTA selector during a successful explicit DSH boot.
    if (layout_matches(&bs) && esp_rom_get_reset_reason(0) == RESET_REASON_CHIP_POWER_ON &&
        read_entry_gesture()) {
        if (agent_image_valid(&bs.test)) {
            // SDK test branch loads and verifies, without OTA sequence writes.
            // If this second check fails, the SDK resets. A software reset
            // cannot re-enter the cold-start gesture branch.
            bootloader_utility_load_boot_image(&bs, TEST_APP_INDEX);
        }
        ESP_LOGW(TAG, "DSH image did not verify; choosing factory OTA");
    }

    // Hide test from the stock loader's implicit last-resort fallback.
    bs.test = (esp_partition_pos_t){0};
    const int index = bootloader_utility_get_selected_boot_partition(&bs);
    if (index == INVALID_INDEX) {
        bootloader_reset();
    }
    bootloader_utility_load_boot_image(&bs, index);
}
