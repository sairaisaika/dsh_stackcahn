"""Prepare a separate, pinned DSH device entry checkout. No device access."""
import argparse
import json
from pathlib import Path
import shutil
from prepare_firmware import ROOT, prepare, sha, run

PROFILE = 'independent-ip-change-v55'
APP_VERSION = 'dsh-agent-v78-nfc-retry'
MENU_PROFILE = 'independent-ip-change-menu-v55'
MENU_VERSION = 'dsh-agent-v78-nfc-retry-menu'
MENU_INPUTS = ('menu_request.h', 'rtc_menu_request.h', 'menu_device.h', 'sdkconfig.rtc.defaults')
APP_CENTER_PROFILE = 'independent-ip-change-app-center-v55'
APP_CENTER_VERSION = 'dsh-agent-v78-nfc-retry-ota'
APP_CENTER_SOURCES = ('tail_storage.cc', 'tail_storage.h', 'return_to_stock.cc', 'return_to_stock.h')
APP_CENTER_HOME_PROFILE = 'independent-app-center-home-v55'
APP_CENTER_HOME_VERSION = 'dsh-agent-v78-nfc-retry-home-ota'


def inputs(menu_return=False, app_center=False, app_center_home=False):
    paths = [ROOT/'firmware/upstream.lock.json', ROOT/'firmware/agent-dependencies.lock',
             Path(__file__), ROOT/'scripts/prepare_firmware.py', ROOT/'scripts/build_agent.py']
    paths += sorted(p for p in (ROOT/'firmware/agent').iterdir()
                    if p.is_file() and not p.name.endswith('_test.cc'))
    paths += [ROOT/'firmware/overlay/sion'/name for name in ('pairing_config.h','endpoint_policy.h')]
    if menu_return:
        paths += [ROOT/'firmware/menu-entry'/name for name in MENU_INPUTS]
    if app_center:
        paths += [ROOT/'firmware/app-center'/name for name in APP_CENTER_SOURCES]
        paths += [ROOT/'scripts'/name for name in ('app_center_baseline.py', 'check_agent_preflight.py',
                                                 'inspect_backup.py', 'prepare_installation.py',
                                                 'prepare_agent_bundle.py')]
    if app_center_home:
        paths.append(ROOT/'firmware/app-center/home_menu_request.h')
    return {str(p.relative_to(ROOT)): sha(p) for p in paths}


def replace(path, old, new, *, count=1):
    text = path.read_text()
    if text.count(old) != count:
        raise RuntimeError('Upstream edit seam changed: ' + str(path))
    path.write_text(text.replace(old, new))


def verify(target):
    receipt = json.loads((target/'.agent-prepared.json').read_text())
    if receipt['inputs'] != inputs(receipt.get('menuReturn', False), receipt.get('appCenter', False),
                                   receipt.get('appCenterHome', False)):
        raise RuntimeError('Agent inputs changed; preserve this checkout and use a new destination')
    for path, digest in receipt['files'].items():
        if not (target/path).is_file() or sha(target/path) != digest:
            raise RuntimeError('Prepared source changed: ' + path)
    for path, revision in receipt['heads'].items():
        if run('git', 'rev-parse', 'HEAD', cwd=target/path) != revision:
            raise RuntimeError('Upstream checkout changed: ' + path)
    return receipt


def app_center_headers(backup, home_receiver=None):
    from check_agent_preflight import read_snapshot
    return app_center_headers_from_flash(read_snapshot(backup).data, home_receiver)


def app_center_headers_from_flash(data, home_receiver=None):
    from app_center_baseline import digest_header, layout_header, require_app_center_storage, review_app_center
    from prepare_agent_bundle import EXPECTED_PARTITIONS
    from prepare_installation import image_info
    baseline = review_app_center(data)
    require_app_center_storage(data, baseline)
    stock = baseline.stock
    if home_receiver is not None:
        paired = home_receiver.read_bytes()
        info = image_info(paired)
        if (info['imageBytes'] != len(paired) or len(paired) > EXPECTED_PARTITIONS[baseline.stock_slot][3] or
                info.get('project') != 'stack-chan' or info.get('version') != '1.6.2' or
                info.get('idf') != image_info(stock)['idf'] or b'SION_APP_CENTER_HOME_V1\0' not in paired):
            raise ValueError('Expected the paired StackChan v1.6.2 Home receiver image')
        stock = paired
    return {'reviewed_layout.h': layout_header(baseline.table),
            'reviewed_stock_digest.h': digest_header(stock)}


def prepare_agent(target, menu_return=False, app_center_baseline=None, app_center_home_stock=None):
    app_center = app_center_baseline is not None
    app_center_home = app_center_home_stock is not None
    if menu_return and app_center:
        raise ValueError('Select one entry variant')
    if app_center_home and not app_center:
        raise ValueError('The paired Home variant also requires --app-center-baseline')
    headers = app_center_headers(app_center_baseline, app_center_home_stock) if app_center else {}
    if (target/'.agent-prepared.json').is_file():
        receipt = verify(target)
        if receipt.get('menuReturn', False) != menu_return or receipt.get('appCenter', False) != app_center:
            raise RuntimeError('Prepared folder uses a different entry mode')
        if receipt.get('appCenterHome', False) != app_center_home:
            raise RuntimeError('Prepared folder uses a different Home mode')
        for name, expected in headers.items():
            if (target/'firmware/main/agent/app_center'/name).read_text() != expected:
                raise RuntimeError('Prepared folder uses a different baseline')
        print('Agent source receipt verified. No device access.')
        return
    if target.exists():
        raise RuntimeError('Use a new destination; refusing an existing/partial checkout')
    prepare(target, sion=False)
    fw = target/'firmware'
    profile = MENU_PROFILE if menu_return else PROFILE
    app_version = MENU_VERSION if menu_return else APP_VERSION
    if app_center:
        profile, app_version = ((APP_CENTER_HOME_PROFILE, APP_CENTER_HOME_VERSION) if app_center_home else
                                (APP_CENTER_PROFILE, APP_CENTER_VERSION))
    # The custom image must not identify itself as the original factory release.
    replace(fw/'CMakeLists.txt', 'set(PROJECT_VER "1.6.2")',
            f'set(PROJECT_VER "{app_version}")')
    overlay = fw/'main/agent'
    overlay.mkdir()
    for path in (ROOT/'firmware/agent').iterdir():
        if path.is_file() and not path.name.endswith('_test.cc'):
            shutil.copy2(path, overlay/path.name)
    (overlay/'sion').mkdir()
    for name in ('pairing_config.h','endpoint_policy.h'):
        shutil.copy2(ROOT/'firmware/overlay/sion'/name,overlay/'sion'/name)
    # Only the executable entry is replaced; pinned upstream licenses stay intact.
    entry = '#include "agent/device_main.cc"\n'
    if menu_return:
        entry = '#define SION_MENU_RETURN 1\n' + entry
        menu = overlay/'menu'
        menu.mkdir()
        for name in MENU_INPUTS:
            shutil.copy2(ROOT/'firmware/menu-entry'/name, menu/name)
        with (overlay/'sdkconfig.defaults').open('a') as stream:
            stream.write((menu/'sdkconfig.rtc.defaults').read_text()+'CONFIG_ESP_MAIN_TASK_AFFINITY_CPU0=y\n')
    elif app_center:
        entry = '#define SION_APP_CENTER 1\n'+entry
        center = overlay/'app_center'
        center.mkdir()
        for name in APP_CENTER_SOURCES:
            shutil.copy2(ROOT/'firmware/app-center'/name, center/name)
        for name, contents in headers.items():
            (center/name).write_text(contents)
        if app_center_home:
            entry = '#define SION_APP_CENTER_HOME 1\n'+entry
            shutil.copy2(ROOT/'firmware/app-center/home_menu_request.h', center/'home_menu_request.h')
            with (overlay/'sdkconfig.defaults').open('a') as stream:
                stream.write('\nCONFIG_ULP_COPROC_ENABLED=y\nCONFIG_ULP_COPROC_RESERVE_MEM=32\n')
        with (overlay/'component.cmake').open('a') as stream:
            stream.write('\ntarget_sources(${COMPONENT_LIB} PRIVATE "agent/app_center/tail_storage.cc" '
                         '"agent/app_center/return_to_stock.cc")\n')
    (fw/'main/main.cpp').write_text(entry)
    # Pin the official client used by the independent network worker.
    replace(fw/'main/idf_component.yml', 'dependencies:\n', '''dependencies:
  espressif/esp_websocket_client:
    git: https://github.com/espressif/esp-protocols.git
    path: components/esp_websocket_client
    version: 70bf122fc8bc74622dcf7e15233b5b2af9088df5
''')
    # Manifest-compatible lock: retain all original component versions and add
    # only the pinned official WebSocket client. Resolver drift fails verification.
    shutil.copy2(ROOT/'firmware/agent-dependencies.lock',fw/'dependencies.lock')
    replace(fw/'main/hal/hal.cpp', '''    if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ret = nvs_flash_init();
    }
''', '')
    replace(fw/'main/hal/hal.cpp', '''    xiaozhi_mcp_init();
    head_touch_init();
    io_expander_init();
    rtc_init();
    imu_init();
    servo_init();
''', '    // DSH entry: resource services are attached explicitly, not by factory startup.\n')
    # The board owns the same physical drivers. Its factory network vtable was
    # retaining an unused cloud stack even though AgentNetwork owns the radio.
    board = fw/'main/hal/board/stackchan.cc'
    replace(board, '#include "wifi_board.h"', '#include "board.h"\n#include <cstdlib>')
    replace(board, 'class M5StackCoreS3Board : public WifiBoard {',
            'class M5StackCoreS3Board : public Board {')
    replace(board, '''    // All fallback paths (no saved SSID, timeout, explicit reconfiguration) use
    // the same BLE App setup flow. Never start the upstream configuration AP.
    void StartWifiConfigMode() override
    {
        ESP_LOGW(TAG, "WiFi setup required; opening StackChan App setup");
        GetHAL().requestAppSetup();
    }
''', '''    std::string GetBoardType() override { return "wifi"; }

    // Only the independent AgentNetwork may start networking. A future
    // accidental factory call must fail before provisioning or cloud I/O.
    NetworkInterface* GetNetwork() override { UnsupportedFactoryNetwork(); }
    void StartNetwork() override { UnsupportedFactoryNetwork(); }
    const char* GetNetworkStateIcon() override { UnsupportedFactoryNetwork(); }
    std::string GetBoardJson() override { UnsupportedFactoryNetwork(); }
    std::string GetDeviceStatusJson() override { UnsupportedFactoryNetwork(); }
    std::string GetSystemInfoJson() override { UnsupportedFactoryNetwork(); }

private:
    [[noreturn]] static void UnsupportedFactoryNetwork()
    {
        ESP_LOGE(TAG, "Factory network is unavailable in DSH.AGENT");
        std::abort();
    }

public:
''')
    # The factory timer polls Application::CanEnterSleepMode(). In this entry
    # that singleton never leaves Unknown. Keep the independent PMIC sampling
    # cadence and avoid constructing the unrelated Xiaozhi application.
    for line in ('#include "power_save_timer.h"',
                 '    static constexpr int kPowerSaveSleepDelaySeconds  = 300;',
                 '    PowerSaveTimer* power_save_timer_;',
                 '    hal_bridge::XiaozhiConfig_t xiaozhi_config_;',
                 '    bool last_power_save_enabled_             = false;'):
        replace(board, line+'\n', '')
    for first, following in (
        ('    bool ShouldEnablePowerSave(', '    void RefreshPowerState()'),
        ('    void InitializePowerSaveTimer()', '    void InitializeI2c()'),
    ):
        source = board.read_text()
        start = source.index(first)
        replace(board, source[start:source.index(following, start)], '')
    replace(board, '''        if (status_err == ESP_OK) {
            UpdatePowerSaveEnabled(has_external_power, discharging);
        }

''', '')
    replace(board, '    void PollPowerSaveState()', '    void PollPowerState()')
    replace(board, '                    board->PollPowerSaveState();', '                    board->PollPowerState();')
    replace(board, '        InitializePowerSaveTimer();', '        RefreshPowerState();')
    replace(board, '''    virtual void SetPowerSaveLevel(PowerSaveLevel level) override
    {
        if (level != PowerSaveLevel::LOW_POWER) {
            power_save_timer_->WakeUp();
        }
        WifiBoard::SetPowerSaveLevel(level);
    }''', '    void SetPowerSaveLevel(PowerSaveLevel) override {}')
    # Avatar image lookup retains the upstream Assets strategy vtable. Keep
    # its existing image and font paths without the factory wake model loader.
    assets = fw/'xiaozhi-esp32/main/assets.cc'
    replace(assets, '    Assets::LoadSrmodelsFromIndex(assets, root.get());\n\n', '')
    replace(assets, '    Assets::LoadSrmodelsFromIndex(assets);\n\n', '')
    # This live diagnostic path is the independent entry's only remaining
    # consumer of Mooncake's fmt formatter and its locale dependencies.
    image_assets = fw/'main/assets/assets.cpp'
    replace(image_assets, '#include <mooncake_log.h>', '#include <esp_log.h>')
    replace(image_assets, 'static const std::string_view _tag = "Assets";',
            'static constexpr const char* _tag = "Assets";')
    for original, diagnostic in (
        ('mclog::tagError(_tag, "get image asset {} failed: not found", name);',
         'ESP_LOGE(_tag, "get image asset %s failed: not found", key.c_str());'),
        ('mclog::tagError(_tag, "bin asset {} size too small", name);',
         'ESP_LOGE(_tag, "bin asset %s size too small", key.c_str());'),
        ('mclog::tagWarn(_tag, "unknown asset type for {}, treating as raw", name);',
         'ESP_LOGW(_tag, "unknown asset type for %s, treating as raw", key.c_str());'),
    ):
        replace(image_assets, original, diagnostic)
    # This UUID is unrelated to Sion's eFuse-based identity. Preserve an
    # existing value for the board ABI without creating a factory record.
    replace(fw/'xiaozhi-esp32/main/boards/common/board.cc', '''    Settings settings("board", true);
    uuid_ = settings.GetString("uuid");
    if (uuid_.empty()) {
        uuid_ = GenerateUuid();
        settings.SetString("uuid", uuid_);
    }
''', '''    Settings settings("board", false);
    uuid_ = settings.GetString("uuid");
''')
    # These reachable startup notices bypassed the ESP-IDF Warn threshold via
    # the factory logger and retained fmt and locale in the independent entry.
    hal = fw/'main/hal/hal.cpp'
    for statement in ('creating hal instance', 'init', 'xiaozhi board init',
                      'lvgl init', 'create lvgl touchpad indev'):
        indent = 8 if statement == 'creating hal instance' else 4
        replace(hal, ' ' * indent + f'mclog::tagInfo(_tag, "{statement}");\n', '')
    replace(fw/'main/hal/board/stackchan.cc', '        InitializeCamera();\n',
            '        // Camera is acquired explicitly by the DSH resource service.\n')
    replace(fw/'main/hal/board/stackchan.cc', '    StackChanCamera* camera_;',
            '    StackChanCamera* camera_ = nullptr; // Original AI camera is not constructed.');
    replace(fw/'main/hal/board/stackchan.cc', '    void InitializeCamera()\n',
            'public:\n    bool InitializeAgentCameraVideo()\n')
    replace(fw/'main/hal/board/stackchan.cc', '''        camera_ = new StackChanCamera(video_config);
        camera_->SetHMirror(false);''',
            '        return esp_video_init_with_flags(&video_config, ESP_VIDEO_INIT_FLAGS_DVP) == ESP_OK;')
    replace(board, '    PowerState power_state_;', '''    PowerState power_state_;
    int64_t agent_battery_sample_us_ = 0;''')
    replace(board, '''            if (status_err == ESP_OK) {
                power_state_.has_external_power''', '''            agent_battery_sample_us_ = status_err == ESP_OK && level_err == ESP_OK ? esp_timer_get_time() : 0;
            if (status_err == ESP_OK) {
                power_state_.has_external_power''')
    replace(board, '    i2c_master_bus_handle_t GetI2cBus()', '''    bool ReadAgentBattery(int& percent, bool& charging, bool& discharging)
    {
        std::lock_guard<std::mutex> lock(power_state_mutex_);
        if (!agent_battery_sample_us_ || esp_timer_get_time() - agent_battery_sample_us_ > 2500000) return false;
        percent = power_state_.battery_level;
        charging = power_state_.charging;
        discharging = power_state_.discharging;
        return true;
    }

    i2c_master_bus_handle_t GetI2cBus()''')
    replace(fw/'main/hal/board/stackchan.cc', 'DECLARE_BOARD(M5StackCoreS3Board);', '''DECLARE_BOARD(M5StackCoreS3Board);
bool ReadAgentBattery(int& percent, bool& charging, bool& discharging) {
    return static_cast<M5StackCoreS3Board&>(Board::GetInstance()).ReadAgentBattery(percent, charging, discharging);
}
bool InitializeAgentCameraVideo() {
    return static_cast<M5StackCoreS3Board&>(Board::GetInstance()).InitializeAgentCameraVideo();
}''')
    for file in ('stackchan.cc', 'hal_bridge.cc'):
        replace(fw/'main/hal/board'/file, '#include "stackchan_display.h"',
                '#include "agent/agent_display.h"')
    bridge = fw/'main/hal/board/hal_bridge.cc'
    replace(bridge, '#include "hal_bridge.h"\n', '#include "hal_bridge.h"\n#include "agent/device_trace.h"\n')
    replace(fw/'main/hal/board/hal_bridge.h', '    int y   = -1;\n',
            '    int y   = -1;\n    uint16_t agent_trace_gesture = 0;\n')
    replace(bridge, '    _data.touchPoint.y   = y;\n', '''    _data.touchPoint.y   = y;
    _data.touchPoint.agent_trace_gesture = sion::agent::diagnostics::TrackDriverTouch(true, num > 0, x, y);
''')
    replace(board, '#include "agent/agent_display.h"\n',
            '#include "agent/agent_display.h"\n#include "agent/device_trace.h"\n')
    replace(board, '        if (!ft6336_->UpdateTouchPoint()) {\n            return;\n', '''        if (!ft6336_->UpdateTouchPoint()) {
            sion::agent::diagnostics::TrackDriverTouch(false);
            return;
''')
    touch_reader = '#include <stackchan/stackchan.h>\n\nstatic void lvgl_read_cb'
    replace(hal, touch_reader, '#include "agent/device_trace.h"\n'+touch_reader)
    replace(hal, '    auto& bridge_data = hal_bridge::get_data();\n', '''    auto& bridge_data = hal_bridge::get_data();
    sion::agent::diagnostics::TrackLvglTouch(bridge_data.touchPoint.num > 0,
                                          bridge_data.touchPoint.agent_trace_gesture);
''')
    replace(fw/'main/hal/board/stackchan.cc', '    LvglDisplay* display_;',
            '    sion::agent::AgentDisplay* display_;')
    replace(fw/'main/hal/board/stackchan.cc', 'new StackChanAvatarDisplay(',
            'new sion::agent::AgentDisplay(')
    replace(fw/'main/hal/board/hal_bridge.cc', '#define DISPLAY_TYPE StackChanAvatarDisplay',
            '#define DISPLAY_TYPE sion::agent::AgentDisplay')
    replace(fw/'xiaozhi-esp32/main/boards/m5stack/core-s3/cores3_audio_codec.h',
            '    virtual ~CoreS3AudioCodec();', '''    virtual ~CoreS3AudioCodec();
    // Independent Agent: single I/O owner, explicit errors, bounded I2S calls.
    bool AgentOpen(int volume);
    bool AgentVolume(int volume);
    bool AgentRead(int16_t* pcm, size_t samples);
    bool AgentWrite(const int16_t* pcm, size_t samples);
    bool AgentClose();
    bool AgentBeginPlaybackFence(bool discard);
    int AgentPollPlaybackFence();
    static bool AgentSent(i2s_chan_handle_t, i2s_event_data_t*, void*);
    bool AgentRxOverflowed();
    static bool AgentReceiveOverflow(i2s_chan_handle_t, i2s_event_data_t*, void*);''')
    replace(fw/'xiaozhi-esp32/main/boards/m5stack/core-s3/cores3_audio_codec.h',
            'private:\n', '''private:
    portMUX_TYPE agent_rx_mux_ = portMUX_INITIALIZER_UNLOCKED;
    bool agent_rx_overflow_ = false;
    uint64_t agent_tx_bytes_ = 0, agent_tx_fence_ = 0;
    bool agent_tx_fault_ = false, agent_tx_fencing_ = false, agent_tx_muted_ = false;
''')
    # Factory sources may remain link dependencies of HAL; the new entry never
    # installs them or runs their startup callbacks. Keep the official widgets.
    cmake = fw/'main/CMakeLists.txt'
    # The factory build packages its UI sound effects as Flash data even when
    # the independent entry never plays them. Calculate each cue's length at
    # the point of use. This lets the linker discard unused cues instead of
    # retaining them through global initializers in shared translation units.
    generator = fw/'xiaozhi-esp32/scripts/gen_lang.py'
    replace(generator, '    namespace Sounds {{\n',
            '    namespace Sounds {{\n        using sion::agent::SoundCue;\n')
    replace(generator, '#include <string_view>\n', '#include <string_view>\n#include "agent/sound_cue.h"\n')
    replace(generator, '''        static const std::string_view OGG_{base_name.upper()} {{
        static_cast<const char*>(ogg_{base_name}_start),
        static_cast<size_t>(ogg_{base_name}_end - ogg_{base_name}_start)
        }};''', '''        static constexpr SoundCue OGG_{base_name.upper()} {{
        ogg_{base_name}_start, ogg_{base_name}_end
        }};''', count=2)
    cues = fw/'main/assets/assets.h'
    replace(cues, '#include <string_view>\n', '#include <string_view>\n#include "agent/sound_cue.h"\n')
    for name in ('camera_shutter', 'new_notification'):
        replace(cues, f'''static const std::string_view OGG_{name.upper()}{{
    static_cast<const char*>(ogg_{name}_start),
    static_cast<size_t>(ogg_{name}_end - ogg_{name}_start)}};''',
                f'static constexpr sion::agent::SoundCue OGG_{name.upper()}{{ogg_{name}_start, ogg_{name}_end}};')
    # A retained playback path must link successfully without dummy sound data.
    replace(cmake, '                    EMBED_FILES ${LANG_SOUNDS} ${COMMON_SOUNDS}\n', '')
    # Infrared send/receive (IR_SEND G5, IR_REC G10) uses the RMT peripheral.
    replace(cmake, '                        esp_driver_i2s\n', '                        esp_driver_i2s\n                        esp_driver_rmt\n')
    with cmake.open('a') as stream:
        stream.write('\ninclude("${CMAKE_CURRENT_LIST_DIR}/agent/component.cmake")\n')
    receipt = json.loads((target/'.sion-prepared.json').read_text())
    files = {path: sha(target/path) for path in receipt['files']}
    files.update({str(p.relative_to(target)): sha(p) for p in overlay.rglob('*') if p.is_file()})
    (target/'.agent-prepared.json').write_text(json.dumps({
        'profile': profile, 'appVersion': app_version, 'inputs': inputs(menu_return, app_center, app_center_home),
        **({'menuReturn': True} if menu_return else {}),
        **({'appCenter': True} if app_center else {}),
        **({'appCenterHome': True} if app_center_home else {}),
        'heads': receipt['heads'], 'files': files,
        'installable': False, 'hardwareValidated': False,
    }, indent=2)+'\n')
    print('Independent entry sources prepared. No device access; not an installation package.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--destination', type=Path, required=True)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--menu-return', action='store_true', help='Build the paired touch-menu experiment')
    mode.add_argument('--app-center-baseline', type=Path,
                      help='Build an offline OTA trial pinned to a verified factory backup')
    parser.add_argument('--app-center-home-stock', type=Path,
                        help='Pair the offline OTA trial with the public Home receiver build')
    args = parser.parse_args()
    prepare_agent(args.destination.resolve(), args.menu_return, args.app_center_baseline, args.app_center_home_stock)
