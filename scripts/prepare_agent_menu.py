"""Prepare two isolated checkouts for the touch-menu entry experiment."""
import argparse
import json
from pathlib import Path
import re
import shutil

from prepare_firmware import ROOT, prepare, run, sha

MENU = ROOT/'firmware/menu-entry'
SELECTOR = ROOT/'firmware/boot-selector'
RTC_DEFAULTS = MENU/'sdkconfig.rtc.defaults'
MENU_OPTION = 'CONFIG_STACKCHAN_DSH_MENU'
VISIBILITY_FILES = ('hal/hal_toggles.h', 'hal/hal_toggles.cpp', 'apps/app_setup/workers/feature_toggle.cpp')


def replace(path, before, after):
    text = path.read_text()
    if text.count(before) != 1:
        raise ValueError('Pinned edit seam changed: '+str(path))
    path.write_text(text.replace(before, after))


def verify_menu(destination):
    receipt = json.loads((destination/'menu-prepared.json').read_text())
    pin = json.loads((ROOT/'firmware/upstream.lock.json').read_text())['official']['commit']
    if receipt['upstream'] != pin or run('git', 'rev-parse', 'HEAD', cwd=destination/'stock') != pin:
        raise ValueError('Prepared menu uses a different upstream commit')
    for path, expected in receipt['files'].items():
        if sha(destination/path) != expected:
            raise ValueError('Prepared source changed: '+path)
    return receipt


def prepare_menu(destination):
    destination.mkdir()
    stock = destination/'stock'
    prepare(stock)
    firmware = stock/'firmware'
    run('git', 'apply', str(MENU/'app_visibility.patch'), cwd=stock)
    main = firmware/'main/main.cpp'
    replace(main, '#include <apps/apps.h>', '''#include <apps/apps.h>
#include "sdkconfig.h"
#if CONFIG_STACKCHAN_DSH_MENU
#include "apps/app_dsh_entry/app_dsh_entry.h"
#include "apps/app_dsh_entry/menu_device.h"
#endif''')
    replace(main, '    // Setup logger', '''#if CONFIG_STACKCHAN_DSH_MENU
    const bool returned_from_dsh = sion_menu_once_at_stock_startup();
#else
    constexpr bool returned_from_dsh = false;
#endif
    // Setup logger''')
    replace(main, '    const bool skip_mooncake = GetHAL().getXiaozhiConfig().startAiAgentOnBoot && GetHAL().getWarmRebootTarget() < 0;',
            '''    const bool skip_mooncake = !returned_from_dsh && GetHAL().getXiaozhiConfig().startAiAgentOnBoot &&
        GetHAL().getWarmRebootTarget() < 0;''')
    # Keep existing Mooncake IDs and warm-return indices intact.
    setup = '        GetMooncake().installApp(std::make_unique<AppSetup>());'
    replace(main, setup, setup+'''
#if CONFIG_STACKCHAN_DSH_MENU
        hal_toggles::register_app_id(hal_toggles::App::DshAgent,
                                     GetMooncake().installApp(std::make_unique<AppDshEntry>()));
#endif''')
    cmake = firmware/'main/CMakeLists.txt'
    replace(cmake, 'set(STACK_CHAN_INCLUDE_DIRS ', '''if(NOT CONFIG_STACKCHAN_DSH_MENU)
    list(FILTER STACK_CHAN_SOURCES EXCLUDE REGEX "/app_dsh_entry/")
endif()

set(STACK_CHAN_INCLUDE_DIRS ''')
    kconfig = firmware/'main/Kconfig.projbuild'
    with kconfig.open('a') as stream:
        stream.write('''
menu "StackChan menu extensions"

config STACKCHAN_DSH_MENU
    bool "Enable DSH.AGENT launcher entry"
    default n
    depends on BOOTLOADER_CUSTOM_RESERVE_RTC && ESP_MAIN_TASK_AFFINITY_CPU0
    help
        Register the optional launcher and accept the one-time return request.
        Enable only with a matching bootloader, RTC layout and DSH image.

endmenu
''')
    app = firmware/'main/apps/app_dsh_entry'
    app.mkdir()
    for name in ('app_dsh_entry.cpp', 'app_dsh_entry.h', 'menu_request.h', 'rtc_menu_request.h',
                 'menu_device.h', 'menu_ota_status.h'):
        shutil.copyfile(MENU/name, app/name)
    defaults = firmware/'sdkconfig.defaults'
    with defaults.open('a') as stream:
        stream.write(RTC_DEFAULTS.read_text()+'CONFIG_ESP_MAIN_TASK_AFFINITY_CPU0=y\n'+MENU_OPTION+'=y\n')

    selector = destination/'selector'
    shutil.copytree(SELECTOR, selector)
    shutil.copyfile(firmware/'partitions.csv', selector/'partitions.csv')
    boot = selector/'bootloader_components/main'
    boot_headers = ('menu_request.h', 'rtc_menu_request.h', 'boot_ota_guard.h')
    for name in boot_headers:
        shutil.copyfile(MENU/name, boot/name)
    entry = boot/'bootloader_start.c'
    replace(entry, '#include "bootloader_utility.h"', '#include "bootloader_utility.h"\n'
            '#include "rtc_menu_request.h"\n#include "boot_ota_guard.h"')
    original = entry.read_text()
    entry.write_text(original[:original.index('enum {\n    SELECT_PIN')] + original[original.index('static bool layout_matches'):])
    replace(entry, 'void __attribute__((noreturn)) call_start_cpu0(void)', '''static bool return_to_stock_menu;

void __real_bootloader_common_update_rtc_retain_mem(esp_partition_pos_t* partition, bool count);

void __wrap_bootloader_common_update_rtc_retain_mem(esp_partition_pos_t* partition, bool count)
{
    __real_bootloader_common_update_rtc_retain_mem(partition, count);
    // ESP-IDF may clear invalid RTC retention while loading the stock image.
    // Publish the ready request only after the verified stock image passes this step.
    if (return_to_stock_menu && count) {
        return_to_stock_menu = false;
        sion_menu_arm(sion_menu_memory(), SION_MENU_STOCK_READY);
    }
}

void __attribute__((noreturn)) call_start_cpu0(void)''')
    replace(entry, '    if (bootloader_init() != ESP_OK || !bootloader_utility_load_partition_table(&bs)) {',
            '''    const esp_err_t init = bootloader_init();
    const int reset = esp_rom_get_reset_reason(0);
    const sion_menu_request_t request = sion_menu_consume(sion_menu_memory(),
        reset == RESET_REASON_CPU0_SW || reset == RESET_REASON_CORE_SW);
    if (init != ESP_OK || !bootloader_utility_load_partition_table(&bs)) {''')
    replace(entry, '''    if (layout_matches(&bs) && esp_rom_get_reset_reason(0) == RESET_REASON_CHIP_POWER_ON &&
        read_entry_gesture()) {''', '''    const bool menu_layout = layout_matches(&bs);
    if (request == SION_MENU_ENTER_DSH && menu_layout && sion_menu_selected_ota_confirmed(&bs.ota_info)) {''')
    replace(entry, '''            // If this second check fails, the SDK resets. A software reset
            // cannot re-enter the cold-start gesture branch.''',
            '''            // If the SDK resets, the one-time request has already been cleared.''')
    replace(entry, '    bootloader_utility_load_boot_image(&bs, index);',
            '''    return_to_stock_menu = request == SION_MENU_RETURN_STOCK && menu_layout;
    bootloader_utility_load_boot_image(&bs, index);''')
    boot_cmake = boot/'CMakeLists.txt'
    with boot_cmake.open('a') as stream:
        stream.write('target_link_libraries(${COMPONENT_LIB} INTERFACE '
                     '"-Wl,--wrap=bootloader_common_update_rtc_retain_mem")\n')
    selector_defaults = selector/'sdkconfig.stock.defaults'
    version = re.search(r'^#define SION_MENU_BOOT_VERSION (\d+)u$', (MENU/'menu_request.h').read_text(), re.M)
    if version is None:
        raise ValueError('Shared menu-descriptor version is missing')
    with selector_defaults.open('a') as stream:
        stream.write(RTC_DEFAULTS.read_text()+f'CONFIG_BOOTLOADER_PROJECT_VER={version[1]}\n')

    paths = [main, cmake, kconfig, defaults, entry, boot_cmake, selector_defaults,
             firmware/'partitions.csv', selector/'partitions.csv',
             *(firmware/'main'/name for name in VISIBILITY_FILES),
             *sorted(app.iterdir()), *(boot/name for name in boot_headers)]
    receipt = {
        'upstream': json.loads((ROOT/'firmware/upstream.lock.json').read_text())['official']['commit'],
        'files': {str(path.relative_to(destination)): sha(path) for path in paths},
        'deviceAccess': False,
        'installable': False,
    }
    (destination/'menu-prepared.json').write_text(json.dumps(receipt, indent=2)+'\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--destination', type=Path, required=True)
    args = parser.parse_args()
    prepare_menu(args.destination.resolve())
    print('Prepared menu and selector sources for offline builds.')
