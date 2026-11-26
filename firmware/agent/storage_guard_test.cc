// SPDX-License-Identifier: MIT
#include <cassert>
#include <cstring>
#include <iostream>
#include "storage_guard.cc"

static esp_partition_t owned{0xe10000,0x4000};
static bool present=true;
static int writes=0,erases=0;
extern "C" const esp_partition_t* esp_partition_find_first(int type,int subtype,const char* name) {
    assert(type==ESP_PARTITION_TYPE_DATA && subtype==ESP_PARTITION_SUBTYPE_DATA_NVS);
    assert(!std::strcmp(name,"sion_cfg")); return present?&owned:nullptr;
}
extern "C" esp_err_t __real_esp_partition_write(const esp_partition_t* part,size_t,const void*,size_t) {
    assert(part==&owned); ++writes; return 31;
}
extern "C" esp_err_t __real_esp_partition_write_raw(const esp_partition_t* p,size_t o,const void* d,size_t s){return __real_esp_partition_write(p,o,d,s);}
extern "C" esp_err_t __real_esp_partition_erase_range(const esp_partition_t* part,size_t,size_t) {
    assert(part==&owned); ++erases; return 32;
}
static nvs_open_mode_t observed = NVS_READWRITE;
static const char* partition_seen = nullptr;
extern "C" esp_err_t __real_nvs_open(const char* name, nvs_open_mode_t mode, nvs_handle_t* out) {
    observed = mode;
    if (!std::strcmp(name, "missing")) return 123;
    *out = 17;
    return 0;
}
extern "C" esp_err_t __real_nvs_open_from_partition(const char* partition, const char* name,
                                                  nvs_open_mode_t mode, nvs_handle_t* out) {
    partition_seen = partition;
    return __real_nvs_open(name, mode, out);
}
int main() {
    for (const char* name : {"board", "account", "wifi", "warm_boot", "sion_pair", "future_namespace"}) {
        nvs_handle_t handle = 0;
        assert(__wrap_nvs_open(name, NVS_READWRITE, &handle) == 0);
        assert(observed == NVS_READONLY && handle == 17);
        assert(__wrap_nvs_open_from_partition("another", name, NVS_READWRITE, &handle) == 0);
        assert(observed == NVS_READONLY && !std::strcmp(partition_seen, "another"));
    }
    nvs_handle_t handle = 0;
    assert(__wrap_nvs_open("missing", NVS_READWRITE, &handle) == 123 && handle == 0);
    assert(__wrap_nvs_flash_erase() == ESP_ERR_NOT_SUPPORTED);
    assert(__wrap_nvs_flash_erase_partition("nvs") == ESP_ERR_NOT_SUPPORTED);
    esp_ota_handle_t update = 0;
    assert(__wrap_esp_ota_begin(nullptr, 4096, &update) == ESP_ERR_NOT_SUPPORTED && update == 0);
    assert(__wrap_esp_ota_write(0, nullptr, 0) == ESP_ERR_NOT_SUPPORTED);
    assert(__wrap_esp_ota_set_boot_partition(nullptr) == ESP_ERR_NOT_SUPPORTED);
    assert(__wrap_esp_ota_mark_app_valid_cancel_rollback() == ESP_ERR_NOT_SUPPORTED);
    assert(__wrap_esp_ota_mark_app_invalid_rollback_and_reboot() == ESP_ERR_NOT_SUPPORTED);
    assert(__wrap_esp_partition_write(nullptr, 0, nullptr, 0) == ESP_ERR_NOT_SUPPORTED);
    assert(__wrap_esp_partition_erase_range(nullptr, 0, 0) == ESP_ERR_NOT_SUPPORTED);
    assert(__wrap_nvs_open_from_partition("sion_cfg","settings",NVS_READWRITE,&handle)==0);
    assert(observed==NVS_READWRITE);
    assert(__wrap_nvs_open_from_partition("sion_cfg","pairing",NVS_READWRITE,&handle)==0);
    assert(observed==NVS_READWRITE);
    assert(__wrap_nvs_open_from_partition("nvs","pairing",NVS_READWRITE,&handle)==0);
    assert(observed==NVS_READONLY);
    assert(__wrap_nvs_open_from_partition("sion_cfg","sion_pair",NVS_READWRITE,&handle)==0);
    assert(observed==NVS_READONLY);
    assert(__wrap_nvs_open_from_partition("sion_cfg","account",NVS_READWRITE,&handle)==0);
    assert(observed==NVS_READONLY);
    assert(__wrap_nvs_open("settings",NVS_READWRITE,&handle)==0 && observed==NVS_READONLY);
    assert(__wrap_esp_partition_write(&owned,0,nullptr,0)==31 && writes==1);
    assert(__wrap_esp_partition_erase_range(&owned,0,4096)==32 && erases==1);
    assert(__wrap_esp_partition_write_raw(&owned,0,nullptr,0)==31 && writes==2);
    esp_partition_t forged=owned;
    assert(__wrap_esp_partition_write(&forged,0,nullptr,0)==ESP_ERR_NOT_SUPPORTED);
    assert(__wrap_esp_partition_write_raw(&forged,0,nullptr,0)==ESP_ERR_NOT_SUPPORTED);
    for(auto address:{0x9000u,0xe00000u,0xe10001u,0x1000000u}) {
        owned.address=address;
        assert(!sion::agent::AgentConfigPartition());
        assert(__wrap_esp_partition_erase_range(&owned,0,4096)==ESP_ERR_NOT_SUPPORTED);
    }
    owned.address=0xe10000; owned.size=0x3000; assert(!sion::agent::AgentConfigPartition());
    owned.size=0x4000; present=false;
    assert(__wrap_nvs_open_from_partition("sion_cfg","settings",NVS_READWRITE,&handle)==0 && observed==NVS_READONLY);
    assert(__wrap_nvs_open_from_partition("sion_cfg","pairing",NVS_READWRITE,&handle)==0 && observed==NVS_READONLY);
    std::cout << "Storage guard: original partitions read-only; dedicated settings/pairing and raw page writes scoped\n";
}
