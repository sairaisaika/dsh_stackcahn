// SPDX-License-Identifier: MIT
#include "preservation_policy.h"
#include <sdkconfig.h>
#include <nvs.h>
#include <nvs_flash.h>
// Linker wrappers also cover managed components that bypass Settings (notably
// SsidManager's channel/save paths). NVS itself enforces read-only handles.
extern "C" {
esp_err_t __real_nvs_open(const char*, nvs_open_mode_t, nvs_handle_t*);
esp_err_t __real_nvs_open_from_partition(const char*, const char*, nvs_open_mode_t, nvs_handle_t*);
esp_err_t __real_nvs_flash_erase(void);
esp_err_t __real_nvs_flash_erase_partition(const char*);
esp_err_t __wrap_nvs_open(const char* name, nvs_open_mode_t mode, nvs_handle_t* handle) {
#if CONFIG_SION_DUAL_BACKEND
    if (name && sion::ProtectedNamespace(name)) mode = NVS_READONLY;
#endif
    return __real_nvs_open(name, mode, handle);
}
esp_err_t __wrap_nvs_open_from_partition(const char* partition, const char* name,
                                       nvs_open_mode_t mode, nvs_handle_t* handle) {
#if CONFIG_SION_DUAL_BACKEND
    if (name && sion::ProtectedNamespace(name)) mode = NVS_READONLY;
#endif
    return __real_nvs_open_from_partition(partition, name, mode, handle);
}
esp_err_t __wrap_nvs_flash_erase(void) {
#if CONFIG_SION_DUAL_BACKEND
    return ESP_ERR_NOT_SUPPORTED;
#else
    return __real_nvs_flash_erase();
#endif
}
esp_err_t __wrap_nvs_flash_erase_partition(const char* partition) {
#if CONFIG_SION_DUAL_BACKEND
    (void)partition;
    return ESP_ERR_NOT_SUPPORTED;
#else
    return __real_nvs_flash_erase_partition(partition);
#endif
}
}
