"""Exercise the actual candidate entry with controlled ESP-IDF/ROM calls."""
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
ENTRY = ROOT/'firmware/boot-selector/bootloader_components/main/bootloader_start.c'

HARNESS = r'''
#include <assert.h>
#include <setjmp.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>

typedef struct { uint32_t offset, size; } esp_partition_pos_t;
typedef struct {
    uint32_t app_count;
    esp_partition_pos_t factory, ota_info, ota[2], test;
} bootloader_state_t;
typedef struct {
    struct { bool hash_appended; } image;
    uint32_t image_len;
} esp_image_metadata_t;
enum { ESP_OK, ESP_IMAGE_VERIFY, RESET_REASON_CHIP_POWER_ON };
enum { INVALID_INDEX = -99, TEST_APP_INDEX = -2, ROM_SW = 3, ROM_SLEEP = 5 };
enum Trace { IDLE, PRESS_RELEASE, SHORT_PRESS, STUCK, BOUNCE };
enum Exit { RESET = 1, LOAD };
#define ESP_LOG_ATTR_TAG(tag, str) static const char tag[] = str
#define ESP_LOGW(tag, ...) ((void)(tag))
#define IO_MUX_GPIO9_REG 9
#define REG_READ(reg) (assert((reg) == 9), mux_register)
#define REG_WRITE(reg, value) do { assert((reg) == 9); mux_register = (value); } while (0)
static int GPIO;
static const uint32_t old_mux = 471;
static uint32_t mux_register, elapsed;
static unsigned samples, verified, selected, loaded;
static int reset_reason, init_error, selected_index, load_index;
static bool table_ok, layout_ok, image_good, digest_good, second_load_fail;
static enum Trace trace;
static jmp_buf leave;

static int bootloader_init(void) { return init_error; }
static bool bootloader_utility_load_partition_table(bootloader_state_t *bs)
{
    *bs = (bootloader_state_t){
        .app_count = 2,
        .ota_info = {0xd000, 0x2000},
        .ota = {{0x20000, 0x4f0000}, {0x510000, 0x4f0000}},
        .test = {0xe10000, layout_ok ? 0x1ec000 : 0x1ed000},
    };
    return table_ok;
}
static int esp_rom_get_reset_reason(int cpu) { assert(cpu == 0); return reset_reason; }
static void esp_rom_gpio_pad_select_gpio(unsigned pin) { assert(pin == 9); mux_register = 1; }
static void gpio_ll_input_enable(int *hw, unsigned pin) { assert(hw == &GPIO && pin == 9); mux_register = 2; }
static void esp_rom_gpio_pad_pullup_only(unsigned pin) { assert(pin == 9); mux_register = 3; }
static void esp_rom_delay_us(unsigned us) { elapsed += us; assert(elapsed <= 2102000); }
static bool gpio_ll_get_level(int *hw, unsigned pin)
{
    assert(hw == &GPIO && pin == 9 && mux_register == 3);
    ++samples;
    switch (trace) {
        case IDLE: return true;
        case PRESS_RELEASE: return elapsed >= 710000;
        case SHORT_PRESS: return elapsed >= 595000;
        case STUCK: return false;
        case BOUNCE: return elapsed >= 710000 && (elapsed / 10000u) % 5 != 0;
    }
    assert(false);
    return false;
}
static int esp_image_verify(int mode, const esp_partition_pos_t *part, esp_image_metadata_t *meta)
{
    assert(mux_register == old_mux && mode == ESP_IMAGE_VERIFY && part->offset == 0xe10000);
    assert(part->size == 0x1ec000 && selected == 0);
    ++verified;
    *meta = (esp_image_metadata_t){ .image = {digest_good}, .image_len = 100000 };
    return image_good ? ESP_OK : 1;
}
static int bootloader_utility_get_selected_boot_partition(const bootloader_state_t *bs)
{
    assert(!bs->test.offset && !bs->test.size && mux_register == old_mux);
    ++selected;
    return selected_index;
}
static void __attribute__((noreturn)) bootloader_reset(void) { longjmp(leave, RESET); }
static void __attribute__((noreturn)) bootloader_utility_load_boot_image(const bootloader_state_t *bs, int index)
{
    assert(mux_register == old_mux);
    if (index == TEST_APP_INDEX) {
        assert(bs->test.offset == 0xe10000 && bs->test.size == 0x1ec000 && verified == 1 && !selected);
        if (second_load_fail) {
            // The pinned loader resets if the second validation fails.
            bootloader_reset();
        }
    } else {
        assert(selected == 1 && index == selected_index && !bs->test.offset && !bs->test.size);
    }
    ++loaded;
    load_index = index;
    longjmp(leave, LOAD);
}

#include "bootloader_start.c"

static void defaults(void)
{
    mux_register = old_mux;
    elapsed = samples = verified = selected = loaded = 0;
    init_error = 0;
    table_ok = layout_ok = image_good = digest_good = true;
    second_load_fail = false;
    selected_index = 1;
    reset_reason = RESET_REASON_CHIP_POWER_ON;
    trace = IDLE;
}
static int run(void)
{
    const int result = setjmp(leave);
    if (!result) call_start_cpu0();
    assert(mux_register == old_mux);
    return result;
}
static void factory(void) { assert(run() == LOAD && selected == 1 && loaded == 1 && load_index == 1); }

int main(void)
{
    defaults(); factory(); assert(verified == 0 && elapsed == 2000);
    defaults(); trace = PRESS_RELEASE; assert(run() == LOAD && selected == 0 && load_index == TEST_APP_INDEX);
    defaults(); trace = SHORT_PRESS; factory(); assert(verified == 0 && elapsed <= 602000);
    defaults(); trace = STUCK; factory(); assert(verified == 0 && elapsed == 2102000);
    defaults(); trace = BOUNCE; factory(); assert(verified == 0 && elapsed == 2102000);
    defaults(); trace = PRESS_RELEASE; image_good = false; factory(); assert(verified == 1);
    defaults(); trace = PRESS_RELEASE; digest_good = false; factory(); assert(verified == 1);
    defaults(); trace = PRESS_RELEASE; layout_ok = false; factory(); assert(verified == 0 && samples == 0);
    defaults(); trace = PRESS_RELEASE; reset_reason = ROM_SW; factory(); assert(samples == 0);
    defaults(); trace = PRESS_RELEASE; reset_reason = ROM_SLEEP; factory(); assert(samples == 0);
    defaults(); trace = PRESS_RELEASE; second_load_fail = true; assert(run() == RESET && verified == 1 && selected == 0);
    defaults(); trace = STUCK; reset_reason = ROM_SW; factory(); assert(samples == 0);
    defaults(); selected_index = INVALID_INDEX; assert(run() == RESET && selected == 1 && !loaded);
    defaults(); table_ok = false; assert(run() == RESET && !selected && !samples);
    defaults(); init_error = 1; assert(run() == RESET && !selected && !samples);
    puts("15 selector cases: explicit verified test, release timing, no early OTA select, fail closed and normal fallback");
}
'''


if __name__ == '__main__':
    with tempfile.TemporaryDirectory(prefix='sion-boot-test-') as temp:
        folder = Path(temp)
        # Actual production entry is included. These headers are only distinct
        # for the includes; the harness above supplies the integration ABI.
        for line in ENTRY.read_text().splitlines():
            if not line.startswith('#include "'):
                continue
            header = folder/line.split('"')[1]
            header.parent.mkdir(parents=True, exist_ok=True)
            header.touch()
        c = folder/'test.c'
        c.write_text(HARNESS)
        binary = folder/'selector-tests'
        subprocess.run(['clang', '-std=c11', '-Wall', '-Wextra', '-Werror',
                        '-fsanitize=address,undefined', '-I'+str(ENTRY.parent), '-I'+str(folder),
                        str(c), '-o', str(binary)], check=True)
        subprocess.run([str(binary)], check=True, timeout=10)
