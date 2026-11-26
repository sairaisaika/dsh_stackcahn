// SPDX-License-Identifier: MIT
#include "firmware_trial.h"
#include "preservation_policy.h"
#include <sdkconfig.h>
#include <cJSON.h>
#include <esp_log.h>
#include <esp_ota_ops.h>
#include <esp_random.h>
#include <esp_timer.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <memory>
#include <mutex>

namespace sion {
static std::mutex lock;
static std::unique_ptr<TrialPolicy> trial;
static bool restricted = false;
static bool inspection_failed = false;
static int64_t Now() { return esp_timer_get_time() / 1000; }
void StartFirmwareTrial() {
#if CONFIG_SION_DUAL_BACKEND
    std::lock_guard<std::mutex> guard(lock);
    const auto* partition = esp_ota_get_running_partition();
    esp_ota_img_states_t state;
    if (!partition || esp_ota_get_state_partition(partition, &state) != ESP_OK) {
        inspection_failed = restricted = true;
        ESP_LOGE("SionTrial", "Cannot inspect OTA state; pairing and local control disabled");
        return;
    }
    if (state == ESP_OTA_IMG_VALID)
        return;
    // Never silently accept NEW/UNDEFINED or an unknown deployed bootloader.
    restricted = true;
    if (state != ESP_OTA_IMG_PENDING_VERIFY) {
        inspection_failed = true;
        return;
    }
    uint8_t digest[32];
    if (esp_partition_get_sha256(partition, digest) != ESP_OK) {
        inspection_failed = true;
        return;
    }
    char nonce[33], hash[65];
    for (int i = 0; i < 4; ++i)
        snprintf(nonce + i * 8, 9, "%08lx", static_cast<unsigned long>(esp_random()));
    for (int i = 0; i < 32; ++i)
        snprintf(hash + i * 2, 3, "%02x", digest[i]);
    trial = std::make_unique<TrialPolicy>(nonce, hash, Now());
    if (xTaskCreate([](void*) {
        for (;;) {
            vTaskDelay(pdMS_TO_TICKS(1000));
            std::lock_guard<std::mutex> guard(lock);
            if (trial && trial->Expire(Now())) {
                ESP_LOGE("SionTrial", "Trial expired; requesting original application rollback");
                // Returns only on failure. This is not a substitute for USB rescue.
                esp_ota_mark_app_invalid_rollback_and_reboot();
                trial->Fault();
                ESP_LOGE("SionTrial", "Rollback unconfirmed; use reviewed USB recovery");
            }
        }
    }, "sion_trial", 4096, nullptr, 2, nullptr) != pdPASS) {
        trial->Fault();
    }
#endif
}
bool FirmwareTrialRestricted() {
    std::lock_guard<std::mutex> guard(lock);
    return restricted;
}
bool ConfirmFirmwareTrial(const std::string& nonce, const std::string& image, bool observed) {
    std::lock_guard<std::mutex> guard(lock);
    if (!trial)
        return false;
    return trial->Confirm(nonce, image, observed, Now(), [] {
        if (esp_ota_mark_app_valid_cancel_rollback() != ESP_OK)
            return false;
        const auto* partition = esp_ota_get_running_partition();
        esp_ota_img_states_t state;
        return partition && esp_ota_get_state_partition(partition, &state) == ESP_OK &&
               state == ESP_OTA_IMG_VALID;
    });
}
std::string FirmwareTrialStatus() {
    std::lock_guard<std::mutex> guard(lock);
    auto* json = cJSON_CreateObject();
    const char* state = inspection_failed ? "fault" : "not_in_trial";
    if (trial) {
        switch (trial->state()) {
            case TrialPolicy::State::Pending: state = "pending"; break;
            case TrialPolicy::State::Confirmed: state = "confirmed_restart_required"; break;
            case TrialPolicy::State::Expired: state = "expired"; break;
            default: state = "fault";
        }
        cJSON_AddStringToObject(json, "boot_nonce", trial->nonce().c_str());
        cJSON_AddStringToObject(json, "image_sha256", trial->image().c_str());
        cJSON_AddNumberToObject(json, "remaining_ms", trial->Remaining(Now()));
    }
    cJSON_AddStringToObject(json, "state", state);
    cJSON_AddBoolToObject(json, "restricted", restricted);
    char* raw = cJSON_PrintUnformatted(json);
    std::string result = raw ? raw : "{}";
    cJSON_free(raw);
    cJSON_Delete(json);
    return result;
}
[[noreturn]] void RefuseProvisioningDuringPreservation() {
    ESP_LOGE("SionTrial", "Provisioning unavailable: preserve existing identity; return to original firmware");
    // Do not set setup markers, confirm the image, clear credentials or unbind.
    // The independent trial timer remains active while this caller is stopped.
    for (;;)
        vTaskDelay(pdMS_TO_TICKS(1000));
}
}  // namespace sion
