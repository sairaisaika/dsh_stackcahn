// SPDX-License-Identifier: MIT
#pragma once
#include <atomic>
#include <display/display.h>
#include <esp_lcd_panel_io.h>
#include <esp_lcd_panel_ops.h>

namespace sion::agent {
// Board-lifetime LCD/LVGL owner. Agent pages and Avatar remain application-owned.
// This does not instantiate the factory chat renderer or its global modifiers.
class AgentDisplay final : public Display {
public:
    AgentDisplay(esp_lcd_panel_io_handle_t io, esp_lcd_panel_handle_t panel,
                 int width, int height, int offset_x, int offset_y,
                 bool mirror_x, bool mirror_y, bool swap_xy);
    ~AgentDisplay() override;
    AgentDisplay(const AgentDisplay&) = delete;
    AgentDisplay& operator=(const AgentDisplay&) = delete;
    lv_disp_t* GetLvglDisplay() const { return display_; }
    esp_lcd_panel_handle_t Panel() const { return panel_; }
    void LvglLock();
    void LvglUnlock();
protected:
    bool Lock(int timeout_ms = 0) override;
    void Unlock() override;
private:
    static void OnFlushStart(lv_event_t* event);
    static bool OnColorDone(esp_lcd_panel_io_handle_t, esp_lcd_panel_io_event_data_t*, void* context);
    esp_lcd_panel_io_handle_t io_;
    esp_lcd_panel_handle_t panel_;
    lv_disp_t* display_ = nullptr;
    std::atomic<uint32_t> flushing_page_{0};
    lv_font_t interface_font_{};
};
}
