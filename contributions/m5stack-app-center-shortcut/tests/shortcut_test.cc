// SPDX-License-Identifier: MIT
#include "app_center_dsh_shortcut.h"
#include <cassert>
#include <cstdio>
#include <string>

using namespace app_center;

namespace {
esp_partition_t slots[] = {{0x20000, ESP_PARTITION_SUBTYPE_APP_OTA_0, 0x4f0000},
                             {0x510000, ESP_PARTITION_SUBTYPE_APP_OTA_1, 0x4f0000}};
constexpr size_t factory_image_size = 8192 + 16;
uint8_t factory_image_seed;
bool fail_factory_read;
int aborted_hashes;
int factory, selected, selections, writes;
bool has_record, refuse_select, wrong_app;
size_t blob_size;
ImageDigest digests[2];
esp_ota_img_states_t states[2];
DshShortcutRecord saved{};
}

const esp_partition_t* esp_ota_get_running_partition() { return &slots[factory]; }
const esp_partition_t* esp_ota_get_boot_partition() { return &slots[selected]; }
const esp_partition_t* esp_ota_get_next_update_partition(const esp_partition_t* slot)
{
    return &slots[(slot - slots) ^ 1];
}
int esp_ota_get_app_partition_count() { return 2; }
esp_err_t esp_ota_get_state_partition(const esp_partition_t* slot, esp_ota_img_states_t* state)
{
    *state = states[slot - slots];
    return ESP_OK;
}
esp_err_t esp_ota_set_boot_partition(const esp_partition_t* slot)
{
    if (refuse_select) return 1;
    selections++;
    selected = static_cast<int>(slot - slots);
    states[selected] = ESP_OTA_IMG_NEW;
    return ESP_OK;
}
esp_err_t esp_partition_get_sha256(const esp_partition_t* slot, uint8_t* value)
{
    assert(slot != &slots[factory]);
    std::memcpy(value, digests[slot - slots].data(), 32);
    return ESP_OK;
}
esp_err_t esp_image_get_metadata(const esp_partition_pos_t* position, esp_image_metadata_t* image)
{
    assert(position->offset == slots[factory].address && position->size == slots[factory].size);
    image->image.hash_appended = true;
    image->image_len = factory_image_size + sizeof(image->image_digest);
    std::memcpy(image->image_digest, digests[factory].data(), sizeof(image->image_digest));
    return ESP_OK;
}

esp_err_t esp_partition_read(const esp_partition_t* slot, size_t start, void* buffer, size_t size)
{
    assert(slot == &slots[factory] && size && size <= 4096 && start + size <= factory_image_size);
    if (fail_factory_read && start != 0) return 1;
    std::memset(buffer, 0, size);
    if (start == 0) static_cast<uint8_t*>(buffer)[0] = factory_image_seed;
    return ESP_OK;
}

// The firmware probe exercises the actual SDK SHA. Here the stub verifies
// that every byte before the trailer reaches the hash and failures abort it.
int psa_hash_setup(psa_hash_operation_t* hash, int algorithm)
{
    assert(algorithm == PSA_ALG_SHA_256 && hash->consumed == 0);
    return PSA_SUCCESS;
}
int psa_hash_update(psa_hash_operation_t* hash, const uint8_t* data, size_t size)
{
    hash->consumed += size;
    for (size_t i = 0; i < size; ++i) hash->sample ^= data[i];
    return PSA_SUCCESS;
}
int psa_hash_finish(psa_hash_operation_t* hash, uint8_t* digest, size_t size, size_t* written)
{
    assert(hash->consumed == factory_image_size && size == 32);
    std::memset(digest, hash->sample, size);
    *written = size;
    return PSA_SUCCESS;
}
int psa_hash_abort(psa_hash_operation_t*)
{
    ++aborted_hashes;
    return PSA_SUCCESS;
}

esp_err_t esp_ota_get_partition_description(const esp_partition_t*, esp_app_desc_t* description)
{
    std::strcpy(description->project_name, "stack-chan");
    std::strcpy(description->version, wrong_app ? "1.6.2" : "dsh-agent-v53-home-ota");
    return ESP_OK;
}
int nvs_open(const char* ns, nvs_open_mode_t mode, nvs_handle_t* handle)
{
    assert(std::strcmp(ns, "app_dsh_menu") == 0);
    if (mode == NVS_READONLY && !has_record) return 1;
    *handle = mode == NVS_READWRITE ? 2 : 1;
    return ESP_OK;
}
int nvs_get_blob(nvs_handle_t handle, const char* key, void* data, size_t* size)
{
    assert(handle == 1 && std::strcmp(key, "launch_v1") == 0 && *size >= blob_size);
    std::memcpy(data, &saved, blob_size);
    *size = blob_size;
    return ESP_OK;
}
int nvs_set_blob(nvs_handle_t handle, const char* key, const void* data, size_t size)
{
    assert(handle == 2 && std::strcmp(key, "launch_v1") == 0 && size == sizeof(saved));
    blob_size = size;
    std::memcpy(&saved, data, size);
    return ESP_OK;
}
int nvs_commit(nvs_handle_t handle)
{
    assert(handle == 2);
    has_record = true;
    writes++;
    return ESP_OK;
}
void nvs_close(nvs_handle_t) {}

int main()
{
    const std::string valid_digest(64, '2');
    for (int running : {0, 1}) {
        factory = selected = running;
        const int agent = running ^ 1;
        has_record = false;
        selections = writes = 0;
        states[factory] = ESP_OTA_IMG_VALID;
        states[agent] = ESP_OTA_IMG_ABORTED;
        factory_image_seed = 0x11;
        digests[factory].fill(factory_image_seed);
        aborted_hashes = 0;
        digests[agent].fill(0x22);
        assert(selectDshShortcut() == DshShortcutResult::SetupRequired);
        rememberDshShortcut(valid_digest);
        assert(!writes);

        assert(selectInstalledApp(valid_digest));
        assert(selectDshShortcut() == DshShortcutResult::UpdateInProgress);
        rememberDshShortcut(std::string(64, '3'));
        wrong_app = true;
        rememberDshShortcut(valid_digest);
        wrong_app = false;
        assert(!writes);
        rememberDshShortcut(valid_digest);
        assert(writes == 1 && selections == 1);

        selected = factory;
        states[agent] = ESP_OTA_IMG_ABORTED;
        states[factory] = ESP_OTA_IMG_PENDING_VERIFY;
        assert(selectDshShortcut() == DshShortcutResult::UpdateInProgress);
        states[factory] = ESP_OTA_IMG_VALID;
        fail_factory_read = true;
        assert(selectDshShortcut() == DshShortcutResult::SetupRequired && aborted_hashes == 1);
        fail_factory_read = false;
        factory_image_seed ^= 1;
        assert(selectDshShortcut() == DshShortcutResult::SetupRequired);  // Bytes disagree with the trailer.
        digests[factory].fill(factory_image_seed);
        assert(selectDshShortcut() == DshShortcutResult::SetupRequired);  // A different, valid factory build.
        factory_image_seed ^= 1;
        digests[factory].fill(factory_image_seed);
        blob_size--;
        assert(selectDshShortcut() == DshShortcutResult::SetupRequired);
        blob_size++;
        digests[agent][0] ^= 1;
        assert(selectDshShortcut() == DshShortcutResult::ImageUnavailable);
        digests[agent][0] ^= 1;
        refuse_select = true;
        assert(selectDshShortcut() == DshShortcutResult::ImageUnavailable);
        refuse_select = false;
        assert(selectDshShortcut() == DshShortcutResult::Selected);
        assert(selected == agent && writes == 1 && selections == 2);
    }
    std::puts("Both slots: explicit enrollment, exact digests, pending updates, stale records and offline Open passed");
}
