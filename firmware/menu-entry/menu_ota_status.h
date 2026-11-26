// SPDX-License-Identifier: MIT
#pragma once

#include <esp_ota_ops.h>

// Switching images requires a software restart. Keep that restart away from
// the factory updater's unconfirmed boot and from an update queued to boot.
inline const char* sion_menu_ota_launch_block(const esp_partition_t* running)
{
    const auto* next = esp_ota_get_boot_partition();
    if (!next || next->address != running->address)
        return "Finish the StackChan update before opening DSH.AGENT.";

    esp_ota_img_states_t state;
    if (esp_ota_get_state_partition(running, &state) != ESP_OK)
        return "Could not verify the StackChan startup state.";
    if (state == ESP_OTA_IMG_NEW || state == ESP_OTA_IMG_PENDING_VERIFY)
        return "StackChan is confirming an update. Return Home and try again.";
    if (state != ESP_OTA_IMG_VALID)
        return "The StackChan startup image is unconfirmed.";
    return nullptr;
}
