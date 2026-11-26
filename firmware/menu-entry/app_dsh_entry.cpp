// SPDX-License-Identifier: MIT
#include "app_dsh_entry.h"
#include "menu_device.h"
#include "menu_ota_status.h"
#include <apps/common/home_indicator/home_indicator.h>
#include <esp_system.h>
#include <hal/hal.h>
#include <cstring>

namespace {
const char* boot_requirement()
{
    if (esp_cpu_get_core_id() != 0) return "This entry requires the main CPU.";
    if (!sion_menu_selector_installed())
        return "DSH launcher support is unavailable.";
    const auto* running = esp_ota_get_running_partition();
    const auto* target = esp_partition_find_first(ESP_PARTITION_TYPE_APP, ESP_PARTITION_SUBTYPE_APP_TEST, "dsh_agent");
    if (!running || !target || target->address != 0xe10000 || target->size != 0x1ec000 ||
        (running->subtype != ESP_PARTITION_SUBTYPE_APP_OTA_0 && running->subtype != ESP_PARTITION_SUBTYPE_APP_OTA_1))
        return "DSH.AGENT is unavailable for this layout.";
    if (const char* block = sion_menu_ota_launch_block(running)) return block;
    esp_app_desc_t desc{};
    if (esp_ota_get_partition_description(target, &desc) != ESP_OK ||
        std::strncmp(desc.version, "dsh-agent-v", sizeof("dsh-agent-v") - 1) != 0)
        return "DSH.AGENT has no compatible image.";
    return nullptr;
}
}

AppDshEntry::AppDshEntry()
{
    setAppInfo().name = "DSH.AGENT";
    static uint32_t color = 0x538BD7;
    setAppInfo().userData = &color;
}

void AppDshEntry::onOpen()
{
    const char* message = boot_requirement();
    if (!message) {
        sion_menu_arm(sion_menu_memory(), SION_MENU_ENTER_DSH);
        esp_restart();
    }
    LvglLockGuard lock;
    page_ = lv_obj_create(lv_screen_active());
    lv_obj_set_size(page_, LV_PCT(100), LV_PCT(100));
    auto* label = lv_label_create(page_);
    lv_label_set_text(label, message);
    lv_label_set_long_mode(label, LV_LABEL_LONG_WRAP);
    lv_obj_set_width(label, LV_PCT(90));
    lv_obj_center(label);
    view::create_home_indicator([this] { close(); }, 0xB8D3FD, 0x26206A, page_);
}

void AppDshEntry::onRunning()
{
    LvglLockGuard lock;
    view::update_home_indicator();
}

void AppDshEntry::onClose()
{
    LvglLockGuard lock;
    view::destroy_home_indicator();
    if (page_) lv_obj_delete(page_);
    page_ = nullptr;
}
