"""Exercise StackChan launcher sources with isolated host fixtures."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile

def test_visibility(stock, stubs, fixture):
    stubs.mkdir()
    (stubs/'esp_log.h').write_text('''#pragma once
inline void fixture_log(const char*, const char*, ...) {}
inline const char* esp_err_to_name(int) { return "fixture error"; }
#define ESP_LOGW(tag, ...) fixture_log(tag, __VA_ARGS__)
''')
    (stubs/'nvs.h').write_text('''#pragma once
#include <stdint.h>
using esp_err_t = int;
using nvs_handle_t = int;
enum nvs_open_mode_t { NVS_READONLY, NVS_READWRITE };
enum { ESP_OK, ESP_ERR_NVS_NOT_FOUND, ESP_ERR_INVALID_STATE };
int nvs_open(const char*, nvs_open_mode_t, int*);
int nvs_get_u8(int, const char*, uint8_t*);
int nvs_set_u8(int, const char*, uint8_t);
int nvs_commit(int);
void nvs_close(int);
''')
    hal = stock/'hal'
    executable = stubs/'test-visibility'
    for enabled in (0, 1):
        (stubs/'sdkconfig.h').write_text(f'#pragma once\n#define CONFIG_STACKCHAN_DSH_MENU {enabled}\n')
        subprocess.run([
            'clang++', '-std=c++20', '-Wall', '-Wextra', '-Werror', '-fsanitize=address,undefined',
            '-I'+str(hal), '-I'+str(stubs), str(hal/'hal_toggles.cpp'), str(fixture), '-o', str(executable),
        ], check=True)
        subprocess.run([str(executable)], check=True, timeout=10)


def test_menu_sources(stock, selector, fixtures, *, include_visibility=True):
    selector = selector/'bootloader_components/main'
    source = selector/'bootloader_start.c'
    source_includes = (source.read_text()+ '\n'+ (selector/'rtc_menu_request.h').read_text()).splitlines()
    test_source = fixtures/'menu_selector_test.c'

    with tempfile.TemporaryDirectory(prefix='sion-menu-host-') as directory:
        stubs = Path(directory)
        for line in source_includes:
            if line.startswith('#include "'):
                name = line.split('"')[1]
                if not (selector/name).exists():
                    header = stubs/name
                    header.parent.mkdir(parents=True, exist_ok=True)
                    header.touch()
        executable = stubs/'menu-test'
        subprocess.run([
            'clang', '-std=c11', '-Wall', '-Wextra', '-Werror', '-fsanitize=address,undefined',
            '-I'+str(selector), '-I'+str(stubs), str(test_source), '-o', str(executable),
        ], check=True)
        subprocess.run([str(executable)], check=True, timeout=10)

        stock = stock/'firmware/main'
        if include_visibility:
            test_visibility(stock, stubs/'visibility', fixtures/'app_visibility_test.cc')
        main = (stock/'main.cpp').read_text()
        start = main.index('    const bool returned_from_dsh = ')
        returned = main[start:main.index('\n', start)]
        start = main.index('    const bool skip_mooncake = ')
        skip = main[start:main.index(';', start)+1]
        (stubs/'sdkconfig.h').write_text('''#pragma once
#define CONFIG_BOOTLOADER_CUSTOM_RESERVE_RTC 1
#define CONFIG_BOOTLOADER_CUSTOM_RESERVE_RTC_SIZE 8
#define CONFIG_BOOTLOADER_RESERVE_RTC_SIZE 0x10
''')
        (stubs/'bootloader_common.h').write_text('''#pragma once
#include <stdint.h>
struct retain { uint8_t custom[8]{}; };
retain* bootloader_common_get_rtc_retain_mem();
''')
        (stubs/'esp_cpu.h').write_text('#pragma once\nint esp_cpu_get_core_id();\n')
        (stubs/'esp_ota_ops.h').write_text('''#pragma once
#include <stdint.h>
constexpr int ESP_OK = 0;
struct esp_bootloader_desc_t { uint32_t version; };
int esp_ota_get_bootloader_description(const void*, esp_bootloader_desc_t*);
struct esp_partition_t { uint32_t address; };
enum esp_ota_img_states_t { ESP_OTA_IMG_NEW, ESP_OTA_IMG_PENDING_VERIFY, ESP_OTA_IMG_VALID,
                            ESP_OTA_IMG_INVALID, ESP_OTA_IMG_ABORTED, ESP_OTA_IMG_UNDEFINED };
const esp_partition_t* esp_ota_get_boot_partition();
int esp_ota_get_state_partition(const esp_partition_t*, esp_ota_img_states_t*);
''')
        cpp = stubs/'stock-startup.cc'
        cpp.write_text('''#include <cassert>
#include <cstdio>
#include <initializer_list>
#include "menu_device.h"
#include "menu_ota_status.h"
static const esp_partition_t first{0x20000}, second{0x510000};
static const esp_partition_t* selected = &first;
static esp_ota_img_states_t selected_state = ESP_OTA_IMG_VALID;
static bool ota_read_error = false;
const esp_partition_t* esp_ota_get_boot_partition() { return selected; }
int esp_ota_get_state_partition(const esp_partition_t* p, esp_ota_img_states_t* state) {
    assert(p == selected);
    *state = selected_state;
    return ota_read_error ? 1 : ESP_OK;
}
static retain rtc;
static int cpu = 0, descriptor_reads = 0;
static uint32_t boot_version = SION_MENU_BOOT_VERSION;
retain* bootloader_common_get_rtc_retain_mem() { assert(cpu == 0); return &rtc; }
int esp_cpu_get_core_id() { return cpu; }
int esp_ota_get_bootloader_description(const void*, esp_bootloader_desc_t* desc) {
    ++descriptor_reads; desc->version = boot_version; return ESP_OK;
}
struct Preferences {
    bool startAiAgentOnBoot = true;
    int warm_index = -1;
    Preferences getXiaozhiConfig() const { return *this; }
    int getWarmRebootTarget() const { return warm_index; }
};
static Preferences preferences;
Preferences& GetHAL() { return preferences; }
static bool skip_launcher() {
'''+returned+'\n'+skip+'''
    return skip_mooncake;
}
int main() {
    assert(!sion_menu_ota_launch_block(&first));
    for (auto state : {ESP_OTA_IMG_NEW, ESP_OTA_IMG_PENDING_VERIFY, ESP_OTA_IMG_INVALID,
                       ESP_OTA_IMG_ABORTED, ESP_OTA_IMG_UNDEFINED}) {
        selected_state = state;
        assert(sion_menu_ota_launch_block(&first));
    }
    selected_state = ESP_OTA_IMG_VALID;
    ota_read_error = true;
    assert(sion_menu_ota_launch_block(&first));
    ota_read_error = false;
    selected = &second;
    assert(sion_menu_ota_launch_block(&first) && !sion_menu_ota_launch_block(&second));
    selected = nullptr;
    assert(sion_menu_ota_launch_block(&first));
    std::puts("Actual menu OTA policy: unconfirmed and queued upgrades do not arm a DSH restart");
    assert(skip_launcher() && descriptor_reads == 0);
    sion_menu_arm(rtc.custom, SION_MENU_STOCK_READY);
    assert(!skip_launcher() && preferences.startAiAgentOnBoot);
    assert(skip_launcher() && descriptor_reads == 1);
    sion_menu_arm(rtc.custom, SION_MENU_RETURN_STOCK);
    assert(skip_launcher() && descriptor_reads == 1);
    boot_version = 1;
    sion_menu_arm(rtc.custom, SION_MENU_STOCK_READY);
    assert(skip_launcher() && descriptor_reads == 2);
    boot_version = SION_MENU_BOOT_VERSION;
    sion_menu_arm(rtc.custom, SION_MENU_STOCK_READY);
    cpu = 1;
    assert(skip_launcher() && descriptor_reads == 2 && rtc.custom[0] == 'S');
    cpu = 0;
    assert(!skip_launcher() && descriptor_reads == 3);
    preferences.warm_index = 0;
    assert(!skip_launcher());
    preferences.warm_index = -1;
    preferences.startAiAgentOnBoot = false;
    assert(!skip_launcher());
    std::puts("Actual stock startup decision: one return opens the main menu and preserves the original boot preference");
}
''')
        subprocess.run([
            'clang++', '-std=c++17', '-Wall', '-Wextra', '-Werror', '-fsanitize=address,undefined',
            '-I'+str(stock/'apps/app_dsh_entry'), '-I'+str(stubs), str(cpp), '-o', str(executable),
        ], check=True)
        subprocess.run([str(executable)], check=True, timeout=10)



def verify_export(stock, bundle):
    receipt = json.loads((bundle/'source-review.json').read_text())
    upstream = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=stock, text=True).strip()
    if upstream != receipt['upstream']:
        raise ValueError('Apply the launcher patch to the pinned StackChan commit')
    for base, files in ((stock, receipt['launcherPatchedFiles']), (bundle, receipt['files'])):
        for path, expected in files.items():
            if hashlib.sha256((base/path).read_bytes()).hexdigest() != expected:
                raise ValueError(f'Source differs from review bundle: {path}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stock', type=Path, required=True, help='Pinned StackChan checkout with launcher.patch applied')
    args = parser.parse_args()
    stock = args.stock.resolve()
    fixtures = Path(__file__).resolve().parent
    bundle = fixtures.parent
    verify_export(stock, bundle)
    test_menu_sources(stock, bundle/'selector', fixtures)
