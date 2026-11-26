// Power-key boot selector for Sion (wiki/boot-selector-power-key.md).
//
// Stock ESP-IDF v5.5.4 bootloader, unchanged; this file only defines the after-init hook the
// stock bootloader calls once before it selects a partition. On a cold power-on it gives the
// owner about 1.5 s (charge LED blinking fast) to press the power key twice. Accepted, it
// writes the same one-time "boot ota_0" OTA record that scripts/enter_dsh.py and the reviewed
// trial install write, after checking the partition table, the factory record and the DSH
// image; then the stock selection continues and starts DSH once. Anything unexpected: write
// nothing and let the stock bootloader start the factory firmware.
// SPDX-License-Identifier: MIT
#include <stdbool.h>
#include <stdint.h>
#include <string.h>
#include "sdkconfig.h"
#include "bootloader_common.h"
#include "bootloader_flash_priv.h"
#include "bootloader_utility.h"
#include "esp_app_desc.h"
#include "esp_flash_partitions.h"
#include "esp_image_format.h"
#include "esp_log.h"
#include "esp_rom_gpio.h"
#include "esp_rom_sys.h"
#include "hal/gpio_ll.h"
#include "soc/io_mux_reg.h"
#include "soc/soc.h"
#include "pek_logic.h"

static const char *const TAG = "sion-pek";

// Makes the stock bootloader link this component (ESP-IDF bootloader_hooks example).
void bootloader_hooks_include(void) {}

enum {
    SDA = 12, SCL = 11,                 // CoreS3 internal I2C (stock hal/board/config.h)
    AXP = 0x34,                         // AXP2101
    REG_ID = 0x03, ID_AXP2101 = 0x4A,
    REG_PEK_STATUS = 0x49, REG_CHGLED = 0x69,
    WINDOW_MS = 1500, POLL_MS = 10, HALF_US = 5,
    OTADATA = 0xd000, SECTOR = 0x1000, OTA0 = 0x20000, OTA0_SIZE = 0x4f0000,
};
// --- Bit-banged I2C, open drain: a line is released (pulled up on the board) or driven low.
static void line(int pin, bool high)
{
    if (high) gpio_ll_output_disable(&GPIO, pin);
    else { gpio_ll_set_level(&GPIO, pin, 0); gpio_ll_output_enable(&GPIO, pin); }
    esp_rom_delay_us(HALF_US);
}
static bool sda(void) { return gpio_ll_get_level(&GPIO, SDA); }
static void start(void) { line(SDA, true); line(SCL, true); line(SDA, false); line(SCL, false); }
static void stop(void) { line(SDA, false); line(SCL, true); line(SDA, true); }
static bool put(uint8_t byte)
{
    for (int i = 7; i >= 0; --i) { line(SDA, (byte >> i) & 1); line(SCL, true); line(SCL, false); }
    line(SDA, true); line(SCL, true);
    const bool ack = !sda();
    line(SCL, false);
    return ack;
}
static uint8_t get(void)
{
    uint8_t byte = 0;
    line(SDA, true);
    for (int i = 0; i < 8; ++i) { line(SCL, true); byte = (byte << 1) | sda(); line(SCL, false); }
    line(SDA, true); line(SCL, true); line(SCL, false);    // NACK: one byte only
    return byte;
}
static bool reg_read(uint8_t reg, uint8_t *value)
{
    start();
    bool ok = put(AXP << 1) && put(reg);
    if (ok) { start(); ok = put((AXP << 1) | 1); if (ok) *value = get(); }
    stop();
    return ok;
}
static bool reg_write(uint8_t reg, uint8_t value)
{
    start();
    const bool ok = put(AXP << 1) && put(reg) && put(value);
    stop();
    return ok;
}

// Not inlined: the QEMU check (scripts/audit_pek_selector_qemu.py) returns 1 from it under gdb.
static __attribute__((noinline)) bool read_gesture(void)
{
    const uint32_t mux_sda = REG_READ(IO_MUX_GPIO12_REG), mux_scl = REG_READ(IO_MUX_GPIO11_REG);
    for (int pin = SCL; pin <= SDA; ++pin) {
        esp_rom_gpio_pad_select_gpio(pin);
        gpio_ll_input_enable(&GPIO, pin);
        gpio_ll_od_enable(&GPIO, pin);
        gpio_ll_output_disable(&GPIO, pin);
    }
    esp_rom_delay_us(100);
    bool accepted = false;
    uint8_t id = 0, led = 0, status = 0;
    if (!reg_read(REG_ID, &id) || id != ID_AXP2101 || !reg_read(REG_CHGLED, &led)) goto restore;
    reg_write(REG_CHGLED, (uint8_t)((led & 0xC8) | 0x05 | (2 << 4)));    // manual, blink 4 Hz
    if (reg_read(REG_PEK_STATUS, &status) && (status & (PEK_SHORT_BIT | PEK_LONG_BIT)))
        reg_write(REG_PEK_STATUS, status & (PEK_SHORT_BIT | PEK_LONG_BIT));   // forget earlier presses
    unsigned presses = 0;
    for (unsigned t = 0; t < WINDOW_MS / POLL_MS && presses < PEK_PRESSES_NEEDED; ++t) {
        esp_rom_delay_us(POLL_MS * 1000);
        if (!reg_read(REG_PEK_STATUS, &status)) continue;
        const uint8_t clear = pek_poll(status, &presses);
        if (clear) reg_write(REG_PEK_STATUS, clear);
    }
    accepted = presses >= PEK_PRESSES_NEEDED;
    reg_write(REG_CHGLED, led);
restore:
    for (int pin = SCL; pin <= SDA; ++pin) { gpio_ll_output_disable(&GPIO, pin); gpio_ll_od_disable(&GPIO, pin); }
    REG_WRITE(IO_MUX_GPIO12_REG, mux_sda);
    REG_WRITE(IO_MUX_GPIO11_REG, mux_scl);
    return accepted;
}

// Sion's partition table, read with the stock loader's own function (as the earlier selector
// did): two OTA slots and otadata where the factory layout puts them.
static bool table_is_sions(void)
{
    bootloader_state_t bs = {0};
    return bootloader_utility_load_partition_table(&bs) && bs.app_count == 2 && bs.factory.size == 0 &&
           bs.ota_info.offset == OTADATA && bs.ota_info.size == 2 * SECTOR &&
           bs.ota[0].offset == OTA0 && bs.ota[0].size == OTA0_SIZE &&
           bs.ota[1].offset == 0x510000 && bs.ota[1].size == OTA0_SIZE;
}

// Reads through the flash cache mapping, as the stock loader reads otadata and the partition
// table. (The ROM read path returned data 2 bytes early in QEMU with the stock QIO setting.)
static bool mapped_read(uint32_t address, void *out, uint32_t size)
{
    const void *p = bootloader_mmap(address, size);
    if (!p) return false;
    memcpy(out, p, size);
    bootloader_munmap(p);
    return true;
}

static bool ota0_is_dsh(void)
{
    esp_app_desc_t desc;
    const uint32_t at = OTA0 + sizeof(esp_image_header_t) + sizeof(esp_image_segment_header_t);
    if (!mapped_read(at, &desc, sizeof desc) || desc.magic_word != ESP_APP_DESC_MAGIC_WORD ||
        !pek_version_is_dsh(desc.version, sizeof desc.version)) {
        ESP_LOGW(TAG, "ota_0 descriptor is not DSH (magic %08x)", (unsigned)desc.magic_word);
        return false;
    }
    const esp_partition_pos_t part = {.offset = OTA0, .size = OTA0_SIZE};
    esp_image_metadata_t image = {0};
    const esp_err_t verified = esp_image_verify(ESP_IMAGE_VERIFY, &part, &image);
    if (verified != ESP_OK || !image.image.hash_appended) {
        ESP_LOGW(TAG, "ota_0 image does not verify (%d)", (int)verified);
        return false;
    }
    return true;
}

static void select_dsh_once(void)
{
    if (!table_is_sions()) { ESP_LOGW(TAG, "partition table is not Sion's; starting factory"); return; }
    if (!ota0_is_dsh()) { ESP_LOGW(TAG, "ota_0 holds no valid DSH image; starting factory"); return; }
    esp_ota_select_entry_t sel[2];
    if (!mapped_read(OTADATA, &sel[0], sizeof sel[0]) || !mapped_read(OTADATA + SECTOR, &sel[1], sizeof sel[1])) return;
    pek_record_t rec[2];
    for (int i = 0; i < 2; ++i)
        rec[i] = (pek_record_t){sel[i].ota_seq, sel[i].ota_state, bootloader_common_ota_select_valid(&sel[i])};
    const pek_plan_t plan = pek_plan(rec);
    if (plan.kind == PEK_PLAN_REFUSE) { ESP_LOGW(TAG, "factory is not the confirmed running slot"); return; }
    if (plan.kind == PEK_PLAN_ALREADY) return;
    esp_ota_select_entry_t entry;
    memset(&entry, 0xff, sizeof entry);
    entry.ota_seq = plan.seq;
    entry.ota_state = PEK_OTA_NEW;
    entry.crc = bootloader_common_ota_select_crc(&entry);
    const uint32_t sector = OTADATA + (uint32_t)plan.target * SECTOR;
    if (bootloader_flash_erase_sector(sector / SECTOR) != ESP_OK ||
        bootloader_flash_write(sector, &entry, sizeof entry, false) != ESP_OK) {
        ESP_LOGE(TAG, "otadata write failed");
        return;
    }
    esp_ota_select_entry_t back;
    if (!mapped_read(sector, &back, sizeof back) || memcmp(&back, &entry, sizeof entry) != 0)
        ESP_LOGE(TAG, "otadata readback differs");
    else
        ESP_LOGI(TAG, "DSH selected once (seq %u)", (unsigned)plan.seq);
}

void bootloader_after_init(void)
{
    if (esp_rom_get_reset_reason(0) != RESET_REASON_CHIP_POWER_ON) return;
    if (read_gesture()) select_dsh_once();
}
