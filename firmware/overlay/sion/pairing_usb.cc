// SPDX-License-Identifier: MIT
#include "pairing_usb.h"
#include <driver/usb_serial_jtag.h>
#include <esp_mac.h>
#include <esp_timer.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <future>
#include "application.h"
#include "backend_runtime.h"
#include "pairing_store.h"
#include "firmware_trial.h"

namespace sion {
static void Process(const std::string& line) {
    if (line.rfind("SION1 ", 0) != 0)
        return;
    const char* end = nullptr;
    cJSON* request = cJSON_ParseWithLengthOpts(line.c_str() + 6, line.size() - 6 + 1, &end, true);
    auto field = [&](const char* name) -> std::string {
        auto* item = cJSON_GetObjectItemCaseSensitive(request, name);
        return cJSON_IsString(item) ? item->valuestring : "";
    };
    std::string id = field("request_id"), action = field("action");
    if (!Hex(id, 32)) {
        cJSON_Delete(request);
        return;
    }
    PairingStore store;
    PairingConfig config;
    bool paired = store.Load(config), ok = false;
    bool mutation = action == "install" || action == "remove";
    bool reserved = false;
    if (action == "confirm_firmware") {
        auto* observed = cJSON_GetObjectItemCaseSensitive(request, "voice_and_app_verified");
        ok = ConfirmFirmwareTrial(field("boot_nonce"), field("image_sha256"),
                                  cJSON_IsTrue(observed));
    } else if (mutation && !FirmwareTrialRestricted()) {
        // Flash work stays on this worker; main task grants an original-mode-only
        // maintenance reservation. A successful change takes effect on next boot.
        auto promise = std::make_shared<std::promise<bool>>();
        auto result = promise->get_future();
        Application::GetInstance().Schedule(
            [promise] { promise->set_value(BackendRuntime::Get().ReservePairing()); });
        reserved = result.get();
        if (reserved) {
            const auto expected = field("expected_pair_id");
            if (action == "remove")
                ok = store.Remove(expected);
            else {
                auto* record = cJSON_GetObjectItemCaseSensitive(request, "record");
                char* raw = cJSON_PrintUnformatted(record);
                if (raw) {
                    ok = store.Replace(expected, raw);
                    cJSON_free(raw);
                }
            }
        }
    } else if (action == "status")
        ok = true;
    paired = store.Load(config);
    cJSON* reply = cJSON_CreateObject();
    cJSON_AddStringToObject(reply, "request_id", id.c_str());
    cJSON_AddBoolToObject(reply, "ok", ok);
    cJSON_AddItemToObject(reply, "firmware_trial", cJSON_Parse(FirmwareTrialStatus().c_str()));
    cJSON_AddBoolToObject(reply, "paired", paired);
    cJSON_AddStringToObject(reply, "pair_id", paired ? config.id.c_str() : "");
    cJSON_AddBoolToObject(reply, "restart_required",
                          BackendRuntime::Get().PairingRestartRequired());
    cJSON_AddStringToObject(
        reply, "error",
        ok ? "" : (action == "confirm_firmware" ? "firmware_confirmation_rejected" :
        (mutation && FirmwareTrialRestricted() ? "firmware_trial_requires_confirmation_and_restart" :
        (mutation && !reserved ? "return_to_original_first" : "pairing_write_unconfirmed"))));
    uint8_t mac[6]{};
    esp_read_mac(mac, ESP_MAC_WIFI_STA);
    char identity[13];
    snprintf(identity, sizeof(identity), "%02x%02x%02x%02x%02x%02x", mac[0], mac[1], mac[2], mac[3],
             mac[4], mac[5]);
    cJSON_AddStringToObject(reply, "device_id", identity);
    char* raw = cJSON_PrintUnformatted(reply);
    if (raw) {
        std::string response = "\nSION1 " + std::string(raw) + "\n";
        usb_serial_jtag_write_bytes(response.data(), response.size(), pdMS_TO_TICKS(1000));
        cJSON_free(raw);
    }
    cJSON_Delete(request);
    cJSON_Delete(reply);
}
void StartUsbPairing() {
#if CONFIG_SION_DUAL_BACKEND
    static bool started = false;
    if (started)
        return;
    usb_serial_jtag_driver_config_t config{.tx_buffer_size = 2048, .rx_buffer_size = 8192};
    if (usb_serial_jtag_driver_install(&config) != ESP_OK)
        return;
    if (xTaskCreate(
            [](void*) {
                std::string line;
                bool overflow = false;
                int64_t last = esp_timer_get_time();
                char chunk[256];
                for (;;) {
                    int size = usb_serial_jtag_read_bytes(chunk, sizeof(chunk), pdMS_TO_TICKS(100));
                    auto now = esp_timer_get_time();
                    if (now - last > 5000000) {
                        line.clear();
                        overflow = false;
                    }
                    if (size <= 0)
                        continue;
                    last = now;
                    for (int i = 0; i < size; ++i) {
                        char c = chunk[i];
                        if (c == '\n') {
                            if (!overflow)
                                Process(line);
                            line.clear();
                            overflow = false;
                        } else if (c != '\r' && !overflow) {
                            if (line.size() >= 8192) {
                                line.clear();
                                overflow = true;
                            } else
                                line.push_back(c);
                        }
                    }
                }
            },
            "sion_pair", 12288, nullptr, 1, nullptr) == pdPASS)
        started = true;
    else
        usb_serial_jtag_driver_uninstall();
#endif
}
}  // namespace sion
