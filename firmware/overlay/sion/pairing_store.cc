// SPDX-License-Identifier: MIT
#include "pairing_store.h"
#include <nvs.h>
#include <nvs_flash.h>
namespace sion {
static bool Read(nvs_handle_t handle, const char* key, std::string& data) {
    size_t length = 0;
    if (nvs_get_blob(handle, key, nullptr, &length) != ESP_OK || length > 4096)
        return false;
    data.resize(length);
    return nvs_get_blob(handle, key, data.data(), &length) == ESP_OK;
}
bool PairingStore::Load(PairingConfig& config, std::string* raw) {
    nvs_handle_t h;
    if (nvs_open("sion_pair", NVS_READONLY, &h) != ESP_OK)
        return false;
    uint8_t slot = 0;
    std::string data;
    bool ok = nvs_get_u8(h, "active", &slot) == ESP_OK && slot < 2 &&
              Read(h, slot ? "slot1" : "slot0", data);
    nvs_close(h);
    // A tombstone must never fall back to the previous pairing.
    ok = ok && ParsePairing(data, config);
    if (ok && raw)
        *raw = std::move(data);
    return ok;
}
bool PairingStore::Replace(const std::string& expected, const std::string& record) {
    PairingConfig parsed;
    return ParsePairing(record, parsed) && Save(expected, record);
}
bool PairingStore::Remove(const std::string& expected) { return Save(expected, "{}"); }
bool PairingStore::Save(const std::string& expected, const std::string& record) {
    PairingConfig current;
    bool paired = Load(current);
    if ((paired ? current.id : "") != expected)
        return false;
    nvs_stats_t stats{};
    // Reserve blob pages plus marker. No attempt to erase/compact factory data.
    if (nvs_get_stats(nullptr, &stats) != ESP_OK ||
        stats.free_entries < (record.size() + 31) / 32 + 12)
        return false;
    nvs_handle_t h;
    if (nvs_open("sion_pair", NVS_READWRITE, &h) != ESP_OK)
        return false;
    uint8_t active = 0;
    esp_err_t marker = nvs_get_u8(h, "active", &active);
    if (marker != ESP_OK && marker != ESP_ERR_NVS_NOT_FOUND) {
        nvs_close(h);
        return false;
    }
    if (active > 1) {
        nvs_close(h);
        return false;
    }
    uint8_t next = 1 - active;
    const char* key = next ? "slot1" : "slot0";
    bool ok =
        nvs_set_blob(h, key, record.data(), record.size()) == ESP_OK && nvs_commit(h) == ESP_OK;
    std::string readback;
    ok = ok && Read(h, key, readback) && readback == record;
    if (ok)
        ok = nvs_set_u8(h, "active", next) == ESP_OK && nvs_commit(h) == ESP_OK;
    uint8_t verify = 0;
    ok = ok && nvs_get_u8(h, "active", &verify) == ESP_OK && verify == next;
    // Logical revocation: remove the old blob only AFTER tombstone is active.
    // Flash wear levelling may retain old bytes; this is not secure erasure.
    if (ok && record == "{}") {
        nvs_erase_key(h, active ? "slot1" : "slot0");
        nvs_commit(h);
    }
    nvs_close(h);
    return ok;
}
}  // namespace sion
