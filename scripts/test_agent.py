"""Compile and exercise the independent device lifecycle; never connects hardware."""
from pathlib import Path
import argparse
import json
import shutil
import subprocess
import tempfile
root = Path(__file__).resolve().parents[1]
import sys
subprocess.run([sys.executable,str(root/'scripts/test_agent_pairing_usb.py')],check=True)
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--prepared-source', type=Path, help='Optional prepared firmware directory for actual init error injection')
parser.add_argument('--pairing-probe-output', type=Path, help='Export the test-only C++ pairing peer before removing the temporary build')
parser.add_argument('--session-probe-output', type=Path, help='Export the test-only C++ session peer for the isolated DSH rehearsal')
args = parser.parse_args()
subprocess.run([sys.executable,str(root/'scripts/test_agent_display.py')],check=True)
subprocess.run([sys.executable,str(root/'scripts/test_agent_capacity.py')],check=True)
subprocess.run([sys.executable,str(root/'scripts/test_agent_camera.py')],check=True)
subprocess.run([sys.executable,str(root/'scripts/test_agent_motion.py')],check=True)
with tempfile.TemporaryDirectory(prefix='sion-agent-') as directory:
    binary = str(Path(directory) / 'agent-test')
    subprocess.run(['clang++', '-std=c++17', '-Wall', '-Wextra', '-Werror',
                    '-fsanitize=address,undefined', '-g',
                    str(root/'firmware/agent/session_lifecycle_test.cc'), '-o', binary], check=True)
    subprocess.run([binary], check=True)
    for sensor in ('ltr553', 'si12t', 'bmi270_agent', 'head_touch_gestures'):
        subprocess.run(['clang++', '-std=c++17', '-Wall', '-Wextra', '-Werror',
                        '-fsanitize=address,undefined', '-g',
                        str(root/f'firmware/agent/{sensor}_test.cc'), '-o', binary], check=True)
        subprocess.run([binary], check=True)
    out = Path(directory)
    (out/'nvs.h').write_text('''#pragma once
#include <cstddef>
#include <cstdint>
using esp_err_t=int; using nvs_handle_t=int;
struct nvs_stats_t {size_t used_entries=0,free_entries=0,total_entries=0,namespace_count=0;};
enum nvs_open_mode_t {NVS_READONLY=0,NVS_READWRITE=1};
constexpr int ESP_OK=0, ESP_ERR_NOT_SUPPORTED=0x106, ESP_ERR_NVS_NOT_FOUND=0x1102, ESP_ERR_NVS_NOT_ENOUGH_SPACE=0x1105;
extern "C" {
int nvs_open(const char*,nvs_open_mode_t,nvs_handle_t*);
int nvs_get_str(nvs_handle_t,const char*,char*,size_t*);
int nvs_open_from_partition(const char*,const char*,nvs_open_mode_t,nvs_handle_t*);
int nvs_get_blob(nvs_handle_t,const char*,void*,size_t*);
int nvs_set_blob(nvs_handle_t,const char*,const void*,size_t);
int nvs_commit(nvs_handle_t);
void nvs_close(nvs_handle_t);
int nvs_flash_init_partition(const char*);
int nvs_get_u8(nvs_handle_t,const char*,uint8_t*);
int nvs_set_u8(nvs_handle_t,const char*,uint8_t);
int nvs_erase_key(nvs_handle_t,const char*);
int nvs_get_stats(const char*,nvs_stats_t*);
}
''')
    (out/'nvs_flash.h').write_text('#pragma once\n#include "nvs.h"\n')
    (out/'esp_partition.h').write_text('''#pragma once
#include <cstddef>
#include <cstdint>
struct esp_partition_t {uint32_t address=0,size=0; int type=0,subtype=0; char label[17]={};};
constexpr int ESP_PARTITION_TYPE_APP=0,ESP_PARTITION_SUBTYPE_APP_TEST=0x20;
constexpr int ESP_PARTITION_TYPE_DATA=1,ESP_PARTITION_SUBTYPE_DATA_NVS=2;
extern "C" const esp_partition_t* esp_partition_find_first(int,int,const char*);
''')
    (out/'esp_ota_ops.h').write_text('#pragma once\n#include "esp_partition.h"\nusing esp_ota_handle_t=int;\nextern "C" const esp_partition_t* esp_ota_get_running_partition();\n')
    (out/'esp_system.h').write_text('#pragma once\nextern "C" [[noreturn]] void esp_restart();\n')
    (out/'mbedtls').mkdir()
    (out/'mbedtls/platform_util.h').write_text('''#pragma once
#include <cstring>
inline void mbedtls_platform_zeroize(void* bytes, size_t size){std::memset(bytes,0,size);}
''')
    (out/'mbedtls/x509_crt.h').write_text('''#pragma once
#include <cstddef>
#include <string_view>
struct mbedtls_x509_crt {};
inline void mbedtls_x509_crt_init(mbedtls_x509_crt*){}
inline void mbedtls_x509_crt_free(mbedtls_x509_crt*){}
inline int mbedtls_x509_crt_parse(mbedtls_x509_crt*,const unsigned char* pem,size_t size){
    if(!size||pem[size-1])return -1;
    return std::string_view(reinterpret_cast<const char*>(pem),size-1).find("fixture-cert-body")!=std::string_view::npos?0:-1;
}
''')
    def check(name, file, extra=()):
        target = str(out/name)
        subprocess.run(['clang++', '-std=c++17', '-Wall', '-Wextra', '-Werror',
                        '-fsanitize=address,undefined', '-g', '-pthread', '-I'+directory,
                        str(file), *extra, '-o', target], check=True)
        subprocess.run([target], check=True, timeout=20)
        return target
    check('audio', root/'firmware/agent/audio_engine_test.cc')
    trace_test=check('device-trace', root/'firmware/agent/device_trace_test.cc',
                     [str(root/'firmware/agent/device_trace.cc')])
    subprocess.run([sys.executable,str(root/'scripts/device_trace.py'),'--self-test',trace_test],check=True,timeout=15)
    health_test=check('device-health', root/'firmware/agent/device_health_test.cc')
    subprocess.run([sys.executable,str(root/'scripts/device_health.py'),'--self-test',health_test],check=True,timeout=15)
    check('ring-engine', root/'firmware/agent/ring_engine_test.cc')
    check('screen-touch', root/'firmware/agent/screen_touch_test.cc')
    check('ina226', root/'firmware/agent/ina226_test.cc')
    check('ir-nec', root/'firmware/agent/ir_nec_test.cc')
    check('nfc-st25r3916', root/'firmware/agent/nfc_st25r3916_test.cc')
    check('camera', root/'firmware/agent/camera_engine_test.cc')
    check('network-queue', root/'firmware/agent/agent_network_queue_test.cc')
    check('usb-frames', root/'firmware/agent/agent_usb_frames_test.cc')
    check('relay-stream', root/'firmware/agent/agent_relay_stream_test.cc')
    check('storage', root/'firmware/agent/storage_guard_test.cc')
    check('preferences', root/'firmware/agent/preferences_test.cc')
    whale_stub = out/'whale/stackchan/avatar/skins/default'
    whale_stub.mkdir(parents=True)
    (whale_stub/'default.h').write_text('#pragma once\n// Deliberately tiny host stub: no actual LVGL renderer or smooth runtime.\n#include <cstdint>\n#include <vector>\n#include <cassert>\nnamespace stackchan::avatar {\nenum class Emotion { Neutral, Happy, Angry, Sad, Doubt, Sleepy };\n}\nstruct lv_obj_t {\n    const void* source = nullptr;\n    int x = 0, y = 0;\n    unsigned flags = 0;\n    std::vector<lv_obj_t*> children;\n};\ninline unsigned writes = 0, allocations = 0;\nconstexpr unsigned LV_OBJ_FLAG_HIDDEN = 1, LV_OBJ_FLAG_CLICKABLE = 2;\ninline lv_obj_t* lv_image_create(lv_obj_t* parent) {\n    assert(parent); auto* child = new lv_obj_t;\n    parent->children.push_back(child); ++allocations; return child;\n}\ninline void lv_obj_set_style_border_width(lv_obj_t*, int, int) { ++writes; }\ninline void lv_obj_set_style_radius(lv_obj_t*, int, int) { ++writes; }\ninline void lv_obj_add_flag(lv_obj_t* o, unsigned f) { assert(o); o->flags |= f; ++writes; }\ninline void lv_obj_remove_flag(lv_obj_t* o, unsigned f) { assert(o); o->flags &= ~f; ++writes; }\ninline void lv_image_set_src(lv_obj_t* o, const void* s) { assert(o && s); o->source = s; ++writes; }\ninline void lv_obj_set_pos(lv_obj_t* o, int x, int y) { assert(o); o->x=x; o->y=y; ++writes; }\ninline void lv_obj_delete(lv_obj_t* o) {\n    for (auto* child : o->children) lv_obj_delete(child);\n    delete o;\n}\n')
    check('whale-avatar', root/'firmware/agent/whale_avatar_test.cc', ['-I'+str(out/'whale')])
    check('settings-store', root/'firmware/agent/settings_store_test.cc')
    cjson=root/'firmware/tests/vendor/cJSON'
    # Keep the pinned third-party code unchanged; Apple's libc deprecates its
    # bounded sprintf uses. Keep warnings visible, but not fatal for this C file.
    subprocess.run(['clang','-Wall','-Wextra','-Werror','-Wno-error=deprecated-declarations','-fsanitize=address,undefined','-g',
                    '-c',str(cjson/'cJSON.c'),'-o',str(out/'cJSON.o')],check=True)
    pairing_test=check('pairing-store',root/'firmware/agent/pairing_store_test.cc',
                       ['-I'+str(root/'firmware/overlay'),'-I'+str(cjson),str(out/'cJSON.o'),
                        str(root/'firmware/agent/agent_relay_config.cc')])
    # Generate only a temporary offline identity: no real device/profile or ports.
    subprocess.run(['node','--input-type=module','-e',
                    'const {createPairing}=await import(process.argv[1]);createPairing(process.argv[2],"wss://192.168.1.2:8766/audio");',
                    (root/'src/pairing.mjs').as_uri(),str(out/'pairing')],check=True)
    private_record=out/'pairing/record.json'
    with private_record.open('x') as stream:
        private_record.chmod(0o600)
        json.dump(json.loads((out/'pairing/pairing.json').read_text())['record'],stream)
    subprocess.run([pairing_test,str(private_record)],check=True,timeout=20)
    service_test=check('pairing-service',root/'firmware/agent/pairing_service_test.cc',
                       ['-I'+str(root/'firmware/overlay'),'-I'+str(cjson),str(out/'cJSON.o')])
    if args.pairing_probe_output:
        with args.pairing_probe_output.open('xb') as target, Path(service_test).open('rb') as source:
            shutil.copyfileobj(source, target)
        args.pairing_probe_output.chmod(0o700)
    (out/'network_sdk.h').write_text('''#pragma once
#include "nvs.h"
constexpr int ESP_ERR_WIFI_NOT_INIT=0x3001,ESP_ERR_INVALID_STATE=0x103;
constexpr int WIFI_STORAGE_RAM=1,WIFI_MODE_STA=1,WIFI_IF_STA=0;
constexpr int WIFI_EVENT_STA_DISCONNECTED=5,WIFI_EVENT_STA_CONNECTED=6,WIFI_EVENT_STA_STOP=7,IP_EVENT_STA_GOT_IP=8;
constexpr int IP_EVENT_STA_LOST_IP=9;
constexpr int WEBSOCKET_EVENT_ANY=-1,WEBSOCKET_EVENT_CONNECTED=1,WEBSOCKET_EVENT_DATA=2,
 WEBSOCKET_EVENT_ERROR=3,WEBSOCKET_EVENT_DISCONNECTED=4,WEBSOCKET_EVENT_CLOSED=5,WEBSOCKET_EVENT_FINISH=6;
extern const char *WIFI_EVENT,*IP_EVENT;
using esp_event_handler_t=void(*)(void*,const char*,int32_t,void*);
using esp_event_handler_instance_t=void*;
using wifi_mode_t=int;
struct esp_netif_t {};
struct ip_event_got_ip_t { esp_netif_t* esp_netif; struct {struct {uint32_t addr;} ip;} ip_info; bool ip_changed; };
struct wifi_config_t {struct {uint8_t ssid[32]{},password[64]{};} sta;};
struct wifi_init_config_t {bool nvs_enable;};
#define WIFI_INIT_CONFIG_DEFAULT() wifi_init_config_t{true}
struct esp_sntp_config_t {const char* servers[1];};
#define ESP_NETIF_SNTP_DEFAULT_CONFIG(server) esp_sntp_config_t{{server}}
using esp_websocket_client_handle_t=void*;
struct esp_websocket_client_config_t {
 const char *uri=nullptr,*cert_pem=nullptr,*cert_common_name=nullptr,*subprotocol=nullptr,*headers=nullptr;
 bool skip_cert_common_name_check=false,disable_auto_reconnect=false,enable_close_reconnect=false;
 int buffer_size=0,task_stack=0,task_prio=0,network_timeout_ms=0,ping_interval_sec=0,pingpong_timeout_sec=0;
};
struct esp_websocket_event_data_t {const char* data_ptr=nullptr;int data_len=0;bool fin=false;uint8_t op_code=0;int payload_len=0,payload_offset=0;};
constexpr int pdPASS=1;
#define pdMS_TO_TICKS(ms) (ms)
int xTaskCreate(void(*)(void*),const char*,unsigned,void*,unsigned,void*);
void vTaskDelete(void*);void vTaskDelay(unsigned);
int64_t esp_timer_get_time();void esp_fill_random(void*,size_t);
int esp_wifi_get_mode(wifi_mode_t*);int esp_wifi_init(const wifi_init_config_t*);
int esp_wifi_set_storage(int);int esp_wifi_set_mode(wifi_mode_t);
int esp_wifi_set_config(int,const wifi_config_t*);int esp_wifi_start();int esp_wifi_connect();int esp_wifi_stop();int esp_wifi_deinit();
int esp_netif_init();esp_netif_t* esp_netif_get_handle_from_ifkey(const char*);
esp_netif_t* esp_netif_create_default_wifi_sta();void esp_netif_destroy_default_wifi(void*);
int esp_event_loop_create_default();int esp_event_loop_delete_default();
int esp_event_handler_instance_register(const char*,int,esp_event_handler_t,void*,void**);
int esp_event_handler_instance_unregister(const char*,int,void*);
int esp_netif_sntp_init(const esp_sntp_config_t*);int esp_netif_sntp_sync_wait(unsigned);void esp_netif_sntp_deinit();
esp_websocket_client_handle_t esp_websocket_client_init(const esp_websocket_client_config_t*);
int esp_websocket_register_events(void*,int,esp_event_handler_t,void*);int esp_websocket_client_start(void*);
int esp_websocket_client_destroy(void*);
int esp_websocket_client_send_text(void*,const char*,int,unsigned);int esp_websocket_client_send_bin(void*,const char*,int,unsigned);
''')
    for header in ('esp_event.h','esp_netif.h','esp_netif_sntp.h','esp_random.h','esp_timer.h',
                   'esp_websocket_client.h','esp_wifi.h','esp_wifi_default.h','freertos/FreeRTOS.h','freertos/task.h'):
        path=out/header
        path.parent.mkdir(exist_ok=True)
        path.write_text('#pragma once\n#include "network_sdk.h"\n')
    (out/'mbedtls/ssl.h').write_text('''#pragma once
#include <cstddef>
#include <cstdint>
using mbedtls_ssl_send_t=int(void*, const unsigned char*, size_t);
using mbedtls_ssl_recv_t=int(void*, unsigned char*, size_t);
struct mbedtls_ssl_config {};
struct mbedtls_ssl_context {
    void* io=nullptr; mbedtls_ssl_send_t* send=nullptr; mbedtls_ssl_recv_t* receive=nullptr;
};
constexpr int MBEDTLS_ERR_SSL_WANT_READ=-1, MBEDTLS_ERR_SSL_WANT_WRITE=-2, MBEDTLS_ERR_SSL_INTERNAL_ERROR=-3;
inline int mbedtls_ssl_read(mbedtls_ssl_context* ctx,uint8_t* bytes,size_t size){return ctx->receive(ctx->io,bytes,size);}
inline int mbedtls_ssl_write(mbedtls_ssl_context* ctx,const uint8_t* bytes,size_t size){return ctx->send(ctx->io,bytes,size);}
inline void mbedtls_ssl_close_notify(mbedtls_ssl_context*){}
''')
    network_worker=check('network-worker',root/'firmware/agent/agent_network_test.cc',
          ['-I'+str(root/'firmware/overlay'),'-I'+str(cjson),str(out/'cJSON.o')])
    subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=localhost',
                    '-addext','subjectAltName=DNS:localhost','-keyout',str(out/'relay.key'),'-out',str(out/'relay.pem')],
                   check=True,stderr=subprocess.DEVNULL,timeout=10)
    relay_pair='a'*32
    relay_input=out/'relay-input.json'
    with relay_input.open('x') as stream:
        relay_input.chmod(0o600)
        json.dump(dict(endpoint='wss://localhost:8443/',pairId=relay_pair,certFile='relay.pem',keyFile='relay.key',
                       caFile='relay.pem',ssid='Sion fixture'),stream)
    generated=out/'generated-relay'
    subprocess.run(['node',str(root/'scripts/prepare_agent_relay.mjs'),str(relay_input),str(generated)],check=True,timeout=10)
    device_relay=json.loads((generated/'profile/.stackchan-relay-device.json').read_text())['record']
    record_file=out/'relay-record.json'
    with record_file.open('x') as stream:
        record_file.chmod(0o600)
        json.dump(device_relay,stream)
    subprocess.run([network_worker,str(record_file),relay_pair],check=True,timeout=20)
    agent_session=check('agent-session',root/'firmware/agent/agent_session_test.cc',
                       ['-I'+str(root/'firmware/overlay'),'-I'+str(cjson),str(out/'cJSON.o'),
                        str(root/'firmware/agent/agent_session.cc'),str(root/'firmware/agent/pairing_service.cc')])
    if args.session_probe_output:   # Exported first, so a failing end-to-end run can be repeated by hand.
        with args.session_probe_output.open('xb') as target, Path(agent_session).open('rb') as source:
            shutil.copyfileobj(source,target)
        args.session_probe_output.chmod(0o700)
    subprocess.run(['node',str(root/'scripts/test_agent_transport.mjs'),agent_session],check=True,timeout=20)
    subprocess.run([sys.executable,str(root/'scripts/test_agent_pairing_usb.py'),
                    '--service-executable',service_test],check=True,timeout=20)
    (out/'driver').mkdir()
    (out/'driver/i2s_common.h').write_text('#pragma once\n#include <cores3_audio_codec.h>\n')
    (out/'esp_attr.h').write_text('#pragma once\n#define IRAM_ATTR\n')
    (out/'settings.h').write_text('#pragma once\nclass Settings {public: Settings(const char*,bool); int GetInt(const char*,int);};\n')
    (out/'cores3_audio_codec.h').write_text('''#pragma once
#include <cstddef>
#include <cstdint>
#include <mutex>
struct portMUX_TYPE {std::mutex mutex;};
#define portENTER_CRITICAL(m) (m)->mutex.lock()
#define portEXIT_CRITICAL(m) (m)->mutex.unlock()
#define portENTER_CRITICAL_ISR(m) portENTER_CRITICAL(m)
#define portEXIT_CRITICAL_ISR(m) portEXIT_CRITICAL(m)
constexpr int ESP_OK=0, ESP_CODEC_DEV_OK=0, ESP_ERR_INVALID_STATE=0x103;
#define ESP_CODEC_DEV_MAKE_CHANNEL_MASK(x) (1 << (x))
struct audio_codec_if_t { int (*enable)(const audio_codec_if_t*,bool); };
struct esp_codec_dev_sample_info_t { int bits_per_sample=0,channel=0,channel_mask=0,sample_rate=0; };
int esp_codec_dev_open(void*,esp_codec_dev_sample_info_t*);
int esp_codec_dev_set_in_channel_gain(void*,int,float);
int esp_codec_dev_set_out_vol(void*,int);
int esp_codec_dev_set_out_mute(void*,bool);
int esp_codec_dev_close(void*);
int i2s_channel_disable(int);
int i2s_channel_preload_data(int,const void*,size_t,size_t*);
int i2s_channel_read(int,void*,size_t,size_t*,unsigned);
int i2s_channel_write(int,const void*,size_t,size_t*,unsigned);
using i2s_chan_handle_t=int;
struct i2s_event_data_t {void* dma_buf=nullptr;size_t size=0;};
struct i2s_chan_info_t {bool is_enabled=false;uint32_t total_dma_buf_size=0;};
int i2s_channel_get_info(int,i2s_chan_info_t*);
struct i2s_event_callbacks_t {
 bool (*on_recv_q_ovf)(i2s_chan_handle_t,i2s_event_data_t*,void*)=nullptr;
 bool (*on_sent)(i2s_chan_handle_t,i2s_event_data_t*,void*)=nullptr;
};
int i2s_channel_register_event_callback(int,const i2s_event_callbacks_t*,void*);
class CoreS3AudioCodec {
public:
 CoreS3AudioCodec();
 bool AgentOpen(int volume);bool AgentVolume(int volume);bool AgentClose();
 bool AgentRead(int16_t*,size_t);bool AgentWrite(const int16_t*,size_t);
 bool AgentRxOverflowed();
 bool AgentBeginPlaybackFence(bool);int AgentPollPlaybackFence();
 static bool AgentSent(i2s_chan_handle_t,i2s_event_data_t*,void*);
 static bool AgentReceiveOverflow(i2s_chan_handle_t,i2s_event_data_t*,void*);
 void Start();
 int input_sample_rate_=24000,output_sample_rate_=24000,input_channels_=2,output_volume_=60;
 float input_gain_=60;
 bool input_enabled_=false,output_enabled_=false;
 int tx_handle_=1,rx_handle_=2;
 void* input_dev_=reinterpret_cast<void*>(3);void* output_dev_=reinterpret_cast<void*>(4);
 const audio_codec_if_t *out_codec_if_,*in_codec_if_;
 portMUX_TYPE agent_rx_mux_{};bool agent_rx_overflow_=false;
 uint64_t agent_tx_bytes_=0,agent_tx_fence_=0;
 bool agent_tx_fault_=false,agent_tx_fencing_=false,agent_tx_muted_=false;
};
''')
    check('core-audio', root/'firmware/agent/core_audio_bridge_test.cc')
    (out/'hal').mkdir()
    (out/'apps/common/home_indicator').mkdir(parents=True)
    (out/'hal/hal.h').write_text('''#pragma once
#include <cstdint>
#include <string>
struct lv_event_t {void* data;};struct lv_indev_t {};
struct _lv_font_t {};
using lv_font_t = _lv_font_t;
using lv_color_t = uint32_t;
struct lv_obj_t {lv_obj_t* parent=nullptr; bool deleted=false, disabled=false, hidden=false; const void* source=nullptr; std::string text; int x=0,y=0,width=0,height=0; lv_color_t color=0; const lv_font_t* font=nullptr; void* data=nullptr;void(*callback)(lv_event_t*)=nullptr;int event=0;};
constexpr int LV_TEXT_ALIGN_CENTER=1,LV_ALIGN_TOP_MID=2,LV_OBJ_FLAG_SCROLLABLE=3,LV_EVENT_CLICKED=4,LV_OBJ_FLAG_CLICKABLE=5,LV_OPA_COVER=255,LV_OPA_TRANSP=0,LV_EVENT_SHORT_CLICKED=6,LV_OBJ_FLAG_HIDDEN=7;
constexpr int LV_FLEX_FLOW_COLUMN=1,LV_DIR_VER=2,LV_LABEL_LONG_MODE_WRAP=3,LV_ANIM_OFF=0;
constexpr int LV_STATE_DISABLED=1;
struct lv_image_header_t {uint32_t magic=0,cf=0,w=0,h=0,stride=0;};
struct lv_image_dsc_t {lv_image_header_t header; uint32_t data_size=0; const uint8_t* data=nullptr;};
constexpr uint32_t LV_IMAGE_HEADER_MAGIC=0x19,LV_COLOR_FORMAT_RGB565=0x12;
inline lv_color_t lv_color_hex(uint32_t rgb){return rgb;}
inline int lv_pct(int percent){return percent;}
void lv_obj_remove_style_all(lv_obj_t*);void lv_obj_set_style_radius(lv_obj_t*,int,int);
void lv_obj_set_style_bg_color(lv_obj_t*,lv_color_t,int);void lv_obj_set_style_bg_opa(lv_obj_t*,int,int);
lv_obj_t* lv_screen_active();lv_indev_t* lv_indev_active();lv_obj_t* lv_obj_create(lv_obj_t*);lv_obj_t* lv_label_create(lv_obj_t*);lv_obj_t* lv_button_create(lv_obj_t*);
lv_obj_t* lv_obj_get_parent(const lv_obj_t*);
lv_obj_t* lv_image_create(lv_obj_t*);void lv_image_set_src(lv_obj_t*,const void*);void lv_obj_set_style_border_width(lv_obj_t*,int,int);
void lv_obj_add_state(lv_obj_t*,int);void lv_obj_remove_state(lv_obj_t*,int);
void lv_obj_delete(lv_obj_t*);void lv_obj_set_size(lv_obj_t*,int,int);void lv_obj_set_width(lv_obj_t*,int);void lv_obj_set_pos(lv_obj_t*,int,int);
void lv_label_set_text(lv_obj_t*,const char*);void lv_obj_set_style_text_align(lv_obj_t*,int,int);void lv_obj_set_style_pad_all(lv_obj_t*,int,int);
void lv_obj_set_style_text_font(lv_obj_t*,const lv_font_t*,int);
const char* lv_label_get_text(lv_obj_t*);void lv_obj_set_flex_flow(lv_obj_t*,int);void lv_obj_set_scroll_dir(lv_obj_t*,int);
void lv_label_set_long_mode(lv_obj_t*,int);void lv_obj_scroll_to_y(lv_obj_t*,int,int);void lv_obj_scroll_to_view(lv_obj_t*,int);
void lv_obj_align(lv_obj_t*,int,int,int);void lv_obj_center(lv_obj_t*);void lv_obj_remove_flag(lv_obj_t*,int);void lv_obj_add_flag(lv_obj_t*,int);
void lv_obj_add_event_cb(lv_obj_t*,void(*)(lv_event_t*),int,void*);void* lv_event_get_user_data(lv_event_t*);
class Hal {public:void init();void delay(uint32_t);uint32_t millis();};Hal& GetHAL();
struct LvglLockGuard {LvglLockGuard(){} ~LvglLockGuard(){}};
''')
    (out/'apps/common/home_indicator/home_indicator.h').write_text('''#pragma once
#include <functional>
namespace view {void destroy_home_indicator();void create_home_indicator(std::function<void()>);void update_home_indicator();}
''')
    (out/'esp_timer.h').write_text('#pragma once\n#include <cstdint>\nint64_t esp_timer_get_time();\n')
    (out/'smooth_ui_toolkit.hpp').write_text('''#pragma once
namespace smooth_ui_toolkit::ui_hal {template<class T>void on_delay(T){} template<class T>void on_get_tick(T){}}
''')
    (out/'stackchan/avatar/skins/default').mkdir(parents=True)
    (out/'stackchan/avatar/skins/default/default.h').write_text('''#pragma once
#include <hal/hal.h>
#include <cassert>
#include <memory>
namespace stackchan::avatar {
enum class Emotion {Neutral,Happy,Angry,Sad,Doubt,Sleepy};
class DefaultAvatar {
 lv_obj_t* parent_=nullptr;Emotion emotion_=Emotion::Neutral;
public:
 void init(lv_obj_t* parent){parent_=parent;assert(parent&&!parent->deleted);}
 ~DefaultAvatar(){assert(parent_&&!parent_->deleted);}
 void setEmotion(Emotion value){assert(parent_&&!parent_->deleted);emotion_=value;}
 Emotion getEmotion()const{return emotion_;}
 void update(){assert(parent_&&!parent_->deleted);}
};
}
''')
    ui_links = ['-I'+str(root/'firmware/overlay'),'-I'+str(cjson),str(out/'cJSON.o'),
                str(root/'firmware/agent/agent_session.cc'),str(root/'firmware/agent/device_trace.cc')]
    check('device-ui', root/'firmware/agent/device_ui_test.cc', ui_links)
    (out/'menu').mkdir()
    (out/'menu/menu_device.h').write_text('''#pragma once
#include <menu_request.h>
bool sion_menu_selector_installed();
volatile uint8_t* sion_menu_memory();
''')
    check('device-ui-touch-menu', root/'firmware/agent/device_ui_test.cc',
          ['-DSION_MENU_RETURN','-I'+str(root/'firmware/menu-entry'),*ui_links])
    (out/'app_center').mkdir()
    (out/'app_center/return_to_stock.h').write_text('bool ReviewedStockCanResume();\nuint32_t ReviewedStockReturnAddress();\n')
    (out/'app_center/tail_storage.h').write_text('constexpr int ESP_OK=0;\nint RegisterReviewedTailStorage();\n')
    check('device-ui-app-center', root/'firmware/agent/device_ui_test.cc',
          ['-DSION_APP_CENTER',*ui_links])
    (out/'app_center/home_menu_request.h').write_text('''namespace sion::app_center {
void ClearHomeMenuRequest();
void RequestHomeMenu(uint32_t address);
}
''')
    check('device-ui-app-center-home', root/'firmware/agent/device_ui_test.cc',
          ['-DSION_APP_CENTER','-DSION_APP_CENTER_HOME',*ui_links])
    if args.prepared_source:
        text = (args.prepared_source/'main/hal/hal.cpp').read_text()
        start = text.index('void Hal::init()')
        end = text.index('\n/* -----', start)
        method = text[start:end]
        probe = out/'init.cc'
        probe.write_text('''#include <cassert>
#include <iostream>
using esp_err_t=int;
static int error=0, calls=0, board=0, display=0;
int nvs_flash_init(){++calls;return error;}
#define ESP_ERROR_CHECK(x) do {int e=(x);if(e)throw e;} while(0)
namespace mclog {void tagInfo(const char*,const char*){}}
const char* _tag="test";
class Hal {public: void init();
void xiaozhi_board_init(){++board;} void lvgl_init(){++display;}
};
'''+method+'''
int main(){for(int value:{0,1,2,3}){
error=value;calls=board=display=0;bool failed=false;
try{Hal().init();}catch(int e){failed=true;assert(e==value);}
assert(failed==(value!=0)&&calls==1);
assert(board==(value==0)&&display==(value==0));
}std::cout<<"Actual prepared HAL init: success and 3 failure injections passed; no erase/factory service dependencies\\n";}
''')
        check('init', probe)
