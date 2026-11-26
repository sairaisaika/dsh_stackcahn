"""Run the shortcut policy on the host with an explicit OTA and NVS fixture."""
import argparse
from pathlib import Path
import subprocess
import tempfile


HEADERS = {
    'sdkconfig.h': '#define CONFIG_STACKCHAN_DSH_CATALOG_ID 31337\n',
    'esp_log.h': '#define ESP_LOGW(...) ((void)0)\n',
    'esp_ota_ops.h': '''#pragma once
#include <cstdint>
#include <cstddef>
using esp_err_t = int;
constexpr int ESP_OK = 0;
constexpr int ESP_PARTITION_SUBTYPE_APP_OTA_0 = 0x10, ESP_PARTITION_SUBTYPE_APP_OTA_1 = 0x11;
struct esp_partition_t { uint32_t address; int subtype; uint32_t size; };
enum esp_ota_img_states_t { ESP_OTA_IMG_NEW, ESP_OTA_IMG_PENDING_VERIFY, ESP_OTA_IMG_VALID,
                           ESP_OTA_IMG_INVALID, ESP_OTA_IMG_ABORTED };
struct esp_app_desc_t { char project_name[32]; char version[32]; };
const esp_partition_t* esp_ota_get_running_partition();
const esp_partition_t* esp_ota_get_boot_partition();
const esp_partition_t* esp_ota_get_next_update_partition(const esp_partition_t*);
int esp_ota_get_app_partition_count();
esp_err_t esp_ota_get_state_partition(const esp_partition_t*, esp_ota_img_states_t*);
esp_err_t esp_ota_set_boot_partition(const esp_partition_t*);
esp_err_t esp_partition_get_sha256(const esp_partition_t*, uint8_t*);
esp_err_t esp_partition_read(const esp_partition_t*, std::size_t, void*, std::size_t);
esp_err_t esp_ota_get_partition_description(const esp_partition_t*, esp_app_desc_t*);
''',
    'esp_image_format.h': '''#pragma once
#include "esp_ota_ops.h"
struct esp_partition_pos_t { uint32_t offset, size; };
struct esp_image_metadata_t {
    struct { bool hash_appended; } image;
    uint32_t image_len;
    uint8_t image_digest[32];
};
esp_err_t esp_image_get_metadata(const esp_partition_pos_t*, esp_image_metadata_t*);
''',
    'psa/crypto.h': '''#pragma once
#include <cstddef>
#include <cstdint>
constexpr int PSA_SUCCESS = 0, PSA_ALG_SHA_256 = 1;
struct psa_hash_operation_t { std::size_t consumed; uint8_t sample; };
inline psa_hash_operation_t psa_hash_operation_init() { return {}; }
int psa_hash_setup(psa_hash_operation_t*, int);
int psa_hash_update(psa_hash_operation_t*, const uint8_t*, std::size_t);
int psa_hash_finish(psa_hash_operation_t*, uint8_t*, std::size_t, std::size_t*);
int psa_hash_abort(psa_hash_operation_t*);
''',
    'nvs.h': '''#pragma once
#include <cstddef>
using nvs_handle_t = unsigned;
enum nvs_open_mode_t { NVS_READONLY, NVS_READWRITE };
int nvs_open(const char*, nvs_open_mode_t, nvs_handle_t*);
int nvs_get_blob(nvs_handle_t, const char*, void*, size_t*);
int nvs_set_blob(nvs_handle_t, const char*, const void*, size_t);
int nvs_commit(nvs_handle_t);
void nvs_close(nvs_handle_t);
''',
}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stock', type=Path, required=True, help='Public checkout with all three patches applied')
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='stackchan-shortcut-test-') as folder:
        path = Path(folder)
        for name, source in HEADERS.items():
            header = path/name
            header.parent.mkdir(parents=True, exist_ok=True)
            header.write_text(source)
        program = path/'shortcut-test'
        subprocess.run(['clang++', '-std=c++20', '-Wall', '-Wextra', '-Werror', '-fsanitize=address,undefined',
                        '-I', str(path), '-I', str(args.stock/'firmware/main/hal'),
                        str(Path(__file__).with_name('shortcut_test.cc')), '-o', str(program)], check=True)
        subprocess.run([program], check=True)
