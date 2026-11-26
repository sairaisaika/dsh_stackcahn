// SPDX-License-Identifier: MIT
#include <nvs.h>
#include <nvs_flash.h>
#include <esp_ota_ops.h>
#include "storage_guard.h"
#include <cstring>

namespace sion::agent {
const esp_partition_t* AgentConfigPartition() {
    const auto* part = esp_partition_find_first(ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_DATA_NVS, "sion_cfg");
    if (!part || part->size != 0x4000 || part->address % 0x1000 ||
        part->address < 0xe10000 || part->address > 0x1000000 - part->size) return nullptr;
    return part;
}
}
// Original partitions remain read-only. Only the separately installed sion_cfg
// partition may receive NVS page writes/reclamation. Never create/erase it here.
// Keep these linker wrappers active for dependencies as well as our own code.
extern "C" {
esp_err_t __real_nvs_open(const char*, nvs_open_mode_t, nvs_handle_t*);
esp_err_t __real_nvs_open_from_partition(const char*, const char*, nvs_open_mode_t, nvs_handle_t*);
esp_err_t __wrap_nvs_open(const char* name, nvs_open_mode_t, nvs_handle_t* handle) {
    return __real_nvs_open(name, NVS_READONLY, handle);
}
esp_err_t __wrap_nvs_open_from_partition(const char* partition, const char* name,
                                       nvs_open_mode_t mode, nvs_handle_t* handle) {
    const bool own = partition && name && !std::strcmp(partition, "sion_cfg") &&
                     (!std::strcmp(name, "settings") || !std::strcmp(name, "pairing")) &&
                     sion::agent::AgentConfigPartition();
    return __real_nvs_open_from_partition(partition, name,
        own && mode == NVS_READWRITE ? NVS_READWRITE : NVS_READONLY, handle);
}
esp_err_t __wrap_nvs_flash_erase() { return ESP_ERR_NOT_SUPPORTED; }
esp_err_t __wrap_nvs_flash_erase_partition(const char*) { return ESP_ERR_NOT_SUPPORTED; }
esp_err_t __wrap_esp_ota_begin(const esp_partition_t*, size_t, esp_ota_handle_t*) {
    return ESP_ERR_NOT_SUPPORTED;
}
esp_err_t __wrap_esp_ota_write(esp_ota_handle_t, const void*, size_t) { return ESP_ERR_NOT_SUPPORTED; }
esp_err_t __wrap_esp_ota_set_boot_partition(const esp_partition_t*) { return ESP_ERR_NOT_SUPPORTED; }
esp_err_t __wrap_esp_ota_mark_app_valid_cancel_rollback() { return ESP_ERR_NOT_SUPPORTED; }
esp_err_t __wrap_esp_ota_mark_app_invalid_rollback_and_reboot() { return ESP_ERR_NOT_SUPPORTED; }
esp_err_t __real_esp_partition_write(const esp_partition_t*, size_t, const void*, size_t);
esp_err_t __real_esp_partition_write_raw(const esp_partition_t*, size_t, const void*, size_t);
esp_err_t __real_esp_partition_erase_range(const esp_partition_t*, size_t, size_t);
esp_err_t __wrap_esp_partition_write(const esp_partition_t* part, size_t offset, const void* data, size_t size) {
    if (!part || part != sion::agent::AgentConfigPartition()) return ESP_ERR_NOT_SUPPORTED;
    return __real_esp_partition_write(part, offset, data, size);
}
esp_err_t __wrap_esp_partition_write_raw(const esp_partition_t* part, size_t offset, const void* data, size_t size) {
    if (!part || part != sion::agent::AgentConfigPartition()) return ESP_ERR_NOT_SUPPORTED;
    return __real_esp_partition_write_raw(part, offset, data, size);
}
esp_err_t __wrap_esp_partition_erase_range(const esp_partition_t* part, size_t offset, size_t size) {
    if (!part || part != sion::agent::AgentConfigPartition()) return ESP_ERR_NOT_SUPPORTED;
    return __real_esp_partition_erase_range(part, offset, size);
}
}
