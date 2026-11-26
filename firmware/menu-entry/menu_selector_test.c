// SPDX-License-Identifier: MIT
#include <assert.h>
#include <setjmp.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <menu_request.h>

#define CONFIG_BOOTLOADER_CUSTOM_RESERVE_RTC 1
#define CONFIG_BOOTLOADER_CUSTOM_RESERVE_RTC_SIZE SION_MENU_REQUEST_BYTES
#define CONFIG_BOOTLOADER_RESERVE_RTC_SIZE 0x10
#define ESP_LOG_ATTR_TAG(name, text) static const char name[] = text
#define ESP_LOGW(tag, ...) ((void)tag)
enum { ESP_OK, ESP_IMAGE_VERIFY, RESET_REASON_CPU0_SW, RESET_REASON_CORE_SW, POWER_ON, SLEEP, WATCHDOG };
enum { INVALID_INDEX = -1, TEST_APP_INDEX = -2, STOCK = 1, RESTART = 2 };
typedef int esp_err_t;
typedef struct { uint32_t offset, size; } esp_partition_pos_t;
typedef struct {
    unsigned app_count;
    esp_partition_pos_t factory, ota_info, ota[2], test;
} bootloader_state_t;
typedef struct { struct { bool hash_appended; } image; unsigned image_len; } esp_image_metadata_t;
typedef struct { uint8_t custom[SION_MENU_REQUEST_BYTES]; } rtc_retain_mem_t;
typedef struct { uint32_t ota_state; } esp_ota_select_entry_t;
enum { ESP_OTA_IMG_NEW, ESP_OTA_IMG_PENDING_VERIFY, ESP_OTA_IMG_VALID };

static rtc_retain_mem_t retained;
static jmp_buf launch;
static int reset_reason, requested_slot;
static bool layout_ok, digest_ok, image_ok, table_ok, init_ok, second_check_fails, rtc_header_valid;
static unsigned image_checks, ota_calls, rtc_initializations;
static bool ota_read_ok, ota_selection_ok;
static uint32_t current_ota_state;

static rtc_retain_mem_t* bootloader_common_get_rtc_retain_mem(void) { return &retained; }
static esp_err_t bootloader_common_read_otadata(const esp_partition_pos_t* p, esp_ota_select_entry_t* records)
{
    assert(p->offset == 0xd000 && p->size == 0x2000 && ota_calls == 0);
    records[0] = (esp_ota_select_entry_t){current_ota_state};
    records[1] = (esp_ota_select_entry_t){ESP_OTA_IMG_VALID};
    return ota_read_ok ? ESP_OK : 1;
}
static int bootloader_common_get_active_otadata(esp_ota_select_entry_t* records)
{
    assert(records[0].ota_state == current_ota_state);
    return ota_selection_ok ? 0 : -1;
}
void __wrap_bootloader_common_update_rtc_retain_mem(esp_partition_pos_t* position, bool count);
void __real_bootloader_common_update_rtc_retain_mem(esp_partition_pos_t* position, bool count)
{
    assert(!position && count);
    if (!rtc_header_valid) {
        memset(&retained, 0, sizeof retained);
        ++rtc_initializations;
        rtc_header_valid = true;
    }
}
static esp_err_t bootloader_init(void) { return init_ok ? ESP_OK : 1; }
static int esp_rom_get_reset_reason(int cpu) { assert(cpu == 0); return reset_reason; }
static bool bootloader_utility_load_partition_table(bootloader_state_t* state)
{
    *state = (bootloader_state_t){
        .app_count = 2,
        .ota_info = {0xd000, 0x2000},
        .ota = {{0x20000, 0x4f0000}, {0x510000, 0x4f0000}},
        .test = {0xe10000, layout_ok ? 0x1ec000 : 0x1ed000},
    };
    return table_ok;
}
static esp_err_t esp_image_verify(int mode, const esp_partition_pos_t* position, esp_image_metadata_t* metadata)
{
    assert(mode == ESP_IMAGE_VERIFY && position->offset == 0xe10000 && ota_calls == 0);
    ++image_checks;
    *metadata = (esp_image_metadata_t){.image = {digest_ok}, .image_len = 2000000};
    return image_ok ? ESP_OK : 1;
}
static int bootloader_utility_get_selected_boot_partition(const bootloader_state_t* state)
{
    assert(state->test.offset == 0 && state->test.size == 0);
    ++ota_calls;
    return requested_slot;
}
static void __attribute__((noreturn)) bootloader_reset(void) { longjmp(launch, RESTART); }
static void __attribute__((noreturn)) bootloader_utility_load_boot_image(const bootloader_state_t* state, int index)
{
    if (index == TEST_APP_INDEX) {
        assert(state->test.offset == 0xe10000 && image_checks == 1 && ota_calls == 0);
        if (second_check_fails) bootloader_reset();
    } else {
        assert(index == STOCK && ota_calls == 1 && state->test.offset == 0);
        __wrap_bootloader_common_update_rtc_retain_mem(NULL, true);
    }
    longjmp(launch, index);
}

#include "bootloader_start.c"

static void reset_fixtures(void)
{
    assert(memcmp(retained.custom, (uint8_t[SION_MENU_REQUEST_BYTES]){0}, sizeof retained.custom) == 0);
    assert(!return_to_stock_menu);
    reset_reason = RESET_REASON_CPU0_SW;
    requested_slot = STOCK;
    layout_ok = digest_ok = image_ok = table_ok = init_ok = true;
    second_check_fails = false;
    rtc_header_valid = true;
    ota_read_ok = ota_selection_ok = true;
    current_ota_state = ESP_OTA_IMG_VALID;
    ota_calls = image_checks = rtc_initializations = 0;
}
static int boot(void)
{
    const int result = setjmp(launch);
    if (!result) call_start_cpu0();
    return result;
}
static void expect_stock(unsigned checks)
{
    assert(boot() == STOCK && ota_calls == 1 && image_checks == checks);
    reset_fixtures();
}

int main(void)
{
    reset_fixtures();
    expect_stock(0);
    sion_menu_arm(retained.custom, SION_MENU_ENTER_DSH);
    assert(boot() == TEST_APP_INDEX && ota_calls == 0 && image_checks == 1);
    reset_fixtures();
    expect_stock(0); // Software reset from DSH must not re-enter it.
    reset_reason = RESET_REASON_CORE_SW;
    sion_menu_arm(retained.custom, SION_MENU_ENTER_DSH);
    assert(boot() == TEST_APP_INDEX && ota_calls == 0 && image_checks == 1);
    reset_fixtures();

    const int other_resets[] = {POWER_ON, SLEEP, WATCHDOG};
    for (size_t i = 0; i < sizeof other_resets / sizeof other_resets[0]; ++i) {
        reset_reason = other_resets[i];
        sion_menu_arm(retained.custom, SION_MENU_ENTER_DSH);
        expect_stock(0);
    }
    for (size_t i = 0; i < SION_MENU_REQUEST_BYTES; ++i) {
        sion_menu_arm(retained.custom, SION_MENU_ENTER_DSH);
        retained.custom[i] ^= 1;
        expect_stock(0);
    }
    layout_ok = false;
    sion_menu_arm(retained.custom, SION_MENU_ENTER_DSH);
    expect_stock(0);
    digest_ok = false;
    sion_menu_arm(retained.custom, SION_MENU_ENTER_DSH);
    expect_stock(1);
    image_ok = false;
    sion_menu_arm(retained.custom, SION_MENU_ENTER_DSH);
    expect_stock(1);
    const uint32_t unsettled[] = {ESP_OTA_IMG_NEW, ESP_OTA_IMG_PENDING_VERIFY, UINT32_MAX};
    for (size_t i = 0; i < sizeof unsettled / sizeof unsettled[0]; ++i) {
        current_ota_state = unsettled[i];
        sion_menu_arm(retained.custom, SION_MENU_ENTER_DSH);
        expect_stock(0);
    }
    ota_read_ok = false;
    sion_menu_arm(retained.custom, SION_MENU_ENTER_DSH);
    expect_stock(0);
    ota_selection_ok = false;
    sion_menu_arm(retained.custom, SION_MENU_ENTER_DSH);
    expect_stock(0);
    table_ok = false;
    sion_menu_arm(retained.custom, SION_MENU_ENTER_DSH);
    assert(boot() == RESTART && ota_calls == 0 && image_checks == 0);
    reset_fixtures();
    init_ok = false;
    sion_menu_arm(retained.custom, SION_MENU_ENTER_DSH);
    assert(boot() == RESTART && ota_calls == 0 && image_checks == 0);
    reset_fixtures();
    second_check_fails = true;
    sion_menu_arm(retained.custom, SION_MENU_ENTER_DSH);
    assert(boot() == RESTART && ota_calls == 0 && image_checks == 1);
    reset_fixtures();
    expect_stock(0);
    requested_slot = INVALID_INDEX;
    assert(boot() == RESTART && ota_calls == 1 && image_checks == 0);
    reset_fixtures();

    for (int valid_header = 0; valid_header <= 1; ++valid_header) {
        rtc_header_valid = valid_header != 0;
        sion_menu_arm(retained.custom, SION_MENU_RETURN_STOCK);
        assert(boot() == STOCK && ota_calls == 1 && image_checks == 0);
        assert(rtc_initializations == (valid_header ? 0 : 1));
        assert(sion_menu_consume(retained.custom, true) == SION_MENU_STOCK_READY);
        assert(sion_menu_consume(retained.custom, true) == SION_MENU_NONE);
        reset_fixtures();
    }
    reset_reason = POWER_ON;
    sion_menu_arm(retained.custom, SION_MENU_RETURN_STOCK);
    expect_stock(0);
    layout_ok = false;
    sion_menu_arm(retained.custom, SION_MENU_RETURN_STOCK);
    expect_stock(0);
    sion_menu_arm(retained.custom, SION_MENU_STOCK_READY);
    expect_stock(0); // An interrupted stock launch cannot repeat the return.
    sion_menu_arm(retained.custom, (sion_menu_request_t)0xff);
    expect_stock(0);
    sion_menu_arm(retained.custom, SION_MENU_RETURN_STOCK);
    requested_slot = INVALID_INDEX;
    assert(boot() == RESTART && ota_calls == 1 && image_checks == 0);
    reset_fixtures();
    sion_menu_arm(retained.custom, SION_MENU_ENTER_DSH);
    assert(boot() == TEST_APP_INDEX && ota_calls == 0);
    reset_fixtures();
    puts("36 touch-menu selector cases: entry, return, one-shot cleanup, invalid RTC recovery and OTA confirmation");
}
