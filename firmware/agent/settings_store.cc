// SPDX-License-Identifier: MIT
#include "preferences.h"
#include "storage_guard.h"
#include <nvs.h>
#include <nvs_flash.h>
namespace sion::agent {
PreferenceLoad NvsPreferenceStore::Load(Preferences& value) {
    ready_ = false;
    if (!AgentConfigPartition()) return PreferenceLoad::Unavailable;
    if (nvs_flash_init_partition("sion_cfg") != ESP_OK) return PreferenceLoad::Error;
    ready_ = true;
    nvs_handle_t handle = 0;
    const auto opened = nvs_open_from_partition("sion_cfg", "settings", NVS_READONLY, &handle);
    if (opened == ESP_ERR_NVS_NOT_FOUND) return PreferenceLoad::Missing;
    if (opened != ESP_OK) { ready_ = false; return PreferenceLoad::Error; }
    PreferenceRecord record{}; size_t size = record.size();
    const auto result = nvs_get_blob(handle, "preferences", record.data(), &size);
    nvs_close(handle);
    if (result == ESP_ERR_NVS_NOT_FOUND) return PreferenceLoad::Missing;
    if (result != ESP_OK || size != record.size() || !DecodePreferences(record, value)) {
        ready_ = false; return PreferenceLoad::Error;
    }
    return PreferenceLoad::Loaded;
}
bool NvsPreferenceStore::Save(const Preferences& value) {
    if (!ready_ || !AgentConfigPartition() || value.volume > 100) return false;
    const auto record = EncodePreferences(value);
    nvs_handle_t handle = 0;
    if (nvs_open_from_partition("sion_cfg", "settings", NVS_READWRITE, &handle) != ESP_OK) return false;
    bool ok = nvs_set_blob(handle, "preferences", record.data(), record.size()) == ESP_OK;
    if (ok) ok = nvs_commit(handle) == ESP_OK;
    PreferenceRecord actual{}; size_t size = actual.size();
    if (ok) ok = nvs_get_blob(handle, "preferences", actual.data(), &size) == ESP_OK &&
                 size == actual.size() && actual == record;
    nvs_close(handle);
    return ok;
}
}
