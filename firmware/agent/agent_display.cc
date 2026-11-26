// LCD/port configuration derived from M5Stack StackChan stackchan_display.cc.
// SPDX-FileCopyrightText: 2026 M5Stack Technology CO LTD
// SPDX-License-Identifier: MIT
#include "agent_display.h"
#include "device_trace.h"
#include "direct_frames.h"
#include <algorithm>
#include <atomic>
#include <esp_heap_caps.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include <freertos/task.h>
#include <src/display/lv_display_private.h>
#include <esp_err.h>
#include <esp_lvgl_port.h>
#include <esp_psram.h>
#include <src/misc/cache/lv_cache.h>
#include <vector>

LV_FONT_DECLARE(BUILTIN_TEXT_FONT);

namespace sion::agent {
namespace {
// Direct frame mode (direct_frames.h). One worker; bands of 24 rows in two internal DMA buffers.
constexpr int kBandRows = 24;
AgentDisplay* g_display = nullptr;
struct DirectState {
    SemaphoreHandle_t done = nullptr;      // One give per finished band transfer (color-done ISR).
    SemaphoreHandle_t lock = nullptr;      // Guards the request below.
    TaskHandle_t worker = nullptr;
    uint16_t* band[2] = {};
    const uint8_t* pixels = nullptr;
    uint16_t w = 0, h = 0, x = 0, y = 0;
    bool pending = false;
    std::atomic<bool> active{false}, busy{false};
    std::atomic<int> inflight{0};           // Band transfers whose completion is not LVGL's.
} direct;

void PushFrame(const uint8_t* pixels, uint16_t w, uint16_t h, uint16_t x, uint16_t y) {
    auto* disp = g_display->GetLvglDisplay();
    // LVGL is paused, but its last flush may still be on the bus.
    for (int i = 0; disp->flushing && i < 100; ++i) vTaskDelay(1);
    int buffer = 0, outstanding = 0;
    for (int row = 0; row < h; row += kBandRows) {
        const int rows = std::min<int>(kBandRows, h - row);
        if (outstanding == 2) {           // Reuse the older buffer once its transfer is done.
            xSemaphoreTake(direct.done, pdMS_TO_TICKS(200));
            --outstanding;
        }
        auto* out = direct.band[buffer];
        for (int r = 0; r < rows; ++r) {
            const uint8_t* in = pixels + (size_t(row + r) * w) * 2;
            for (int c = 0; c < w; ++c) out[r * w + c] = uint16_t(in[2 * c + 1] | (in[2 * c] << 8));   // To panel order.
        }
        direct.inflight.fetch_add(1);
        ++outstanding;
        if (esp_lcd_panel_draw_bitmap(g_display->Panel(), x, y + row, x + w, y + row + rows, out) != ESP_OK) {
            direct.inflight.fetch_sub(1);
            --outstanding;
            break;
        }
        buffer ^= 1;
    }
    while (outstanding > 0) {
        xSemaphoreTake(direct.done, pdMS_TO_TICKS(200));
        --outstanding;
    }
}

void DirectWorker(void*) {
    for (;;) {
        ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
        for (;;) {
            xSemaphoreTake(direct.lock, portMAX_DELAY);
            if (!direct.pending || !direct.active.load()) {
                direct.busy.store(false);
                xSemaphoreGive(direct.lock);
                break;
            }
            const auto* pixels = direct.pixels;
            const auto w = direct.w, h = direct.h, x = direct.x, y = direct.y;
            direct.pending = false;
            direct.busy.store(true);
            xSemaphoreGive(direct.lock);
            PushFrame(pixels, w, h, x, y);
        }
    }
}
}

bool DirectFramesBegin() {
    if (!g_display) return false;
    if (!direct.worker) {
        for (auto*& band : direct.band) {
            band = static_cast<uint16_t*>(heap_caps_malloc(320 * kBandRows * 2, MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL));
            if (!band) return false;
        }
        direct.done = xSemaphoreCreateCounting(8, 0);
        direct.lock = xSemaphoreCreateMutex();
        if (!direct.done || !direct.lock) return false;
        if (xTaskCreatePinnedToCore(DirectWorker, "frames", 3072, nullptr, 2, &direct.worker, 1) != pdPASS) {
            direct.worker = nullptr;
            return false;
        }
    }
    if (!direct.active.load()) {
        auto* disp = g_display->GetLvglDisplay();
        lv_display_enable_invalidation(disp, false);
        disp->inv_p = 0;                     // Drop areas LVGL had not drawn yet.
        direct.active.store(true);
    }
    return true;
}
void DirectFramesShow(const uint8_t* pixels, uint16_t w, uint16_t h, uint16_t x, uint16_t y) {
    if (!direct.worker) return;
    xSemaphoreTake(direct.lock, portMAX_DELAY);
    if (direct.active.load()) {
        direct.pixels = pixels; direct.w = w; direct.h = h; direct.x = x; direct.y = y;
        direct.pending = true;
        direct.busy.store(true);
    }
    xSemaphoreGive(direct.lock);
    xTaskNotifyGive(direct.worker);
}
void DirectFramesEnd() {
    if (!direct.active.load()) return;
    xSemaphoreTake(direct.lock, portMAX_DELAY);
    direct.active.store(false);
    direct.pending = false;
    xSemaphoreGive(direct.lock);
    for (int i = 0; direct.busy.load() && i < 500; ++i) vTaskDelay(1);
    auto* disp = g_display->GetLvglDisplay();
    lv_display_enable_invalidation(disp, true);
    lv_obj_invalidate(lv_screen_active());
}

AgentDisplay::AgentDisplay(esp_lcd_panel_io_handle_t io, esp_lcd_panel_handle_t panel,
                          int width, int height, int offset_x, int offset_y,
                          bool mirror_x, bool mirror_y, bool swap_xy) : io_(io), panel_(panel) {
    ESP_ERROR_CHECK(io && panel && width > 0 && width <= 320 && height > 0 && height <= 240
                    ? ESP_OK : ESP_ERR_INVALID_ARG);
    width_ = width; height_ = height;
    std::vector<uint16_t> row(width, 0);
    for (int y = 0; y < height; ++y)
        ESP_ERROR_CHECK(esp_lcd_panel_draw_bitmap(panel, 0, y, width, y + 1, row.data()));
    const auto on = esp_lcd_panel_disp_on_off(panel, true);
    ESP_ERROR_CHECK(on == ESP_ERR_NOT_SUPPORTED ? ESP_OK : on);

    lv_init();
#if CONFIG_SPIRAM
    const auto size = esp_psram_get_size();
    if (size >= 8 * 1024 * 1024) lv_image_cache_resize(2 * 1024 * 1024, true);
    else if (size >= 2 * 1024 * 1024) lv_image_cache_resize(512 * 1024, true);
#endif
    lvgl_port_cfg_t port = ESP_LVGL_PORT_INIT_CONFIG();
    port.task_priority = 3;
#if CONFIG_SOC_CPU_CORES_NUM > 1
    port.task_affinity = 1;
#endif
    ESP_ERROR_CHECK(lvgl_port_init(&port));
    lvgl_port_display_cfg_t config{};
    config.io_handle = io; config.panel_handle = panel;
    config.buffer_size = static_cast<uint32_t>(width * 20);
    config.hres = width; config.vres = height;
    config.rotation.swap_xy = swap_xy;
    config.rotation.mirror_x = mirror_x; config.rotation.mirror_y = mirror_y;
    config.color_format = LV_COLOR_FORMAT_RGB565;
    config.flags.buff_dma = 1; config.flags.swap_bytes = 1;
    display_ = lvgl_port_add_disp(&config);
    ESP_ERROR_CHECK(display_ ? ESP_OK : ESP_ERR_NO_MEM);

    LvglLock();
    // Fence any queued pixel transfers before replacing the port's ready callback.
    ESP_ERROR_CHECK(esp_lcd_panel_io_tx_param(io_, -1, nullptr, 0));
    const esp_lcd_panel_io_callbacks_t callbacks{.on_color_trans_done = OnColorDone};
    ESP_ERROR_CHECK(esp_lcd_panel_io_register_event_callbacks(io_, &callbacks, this));
    lv_display_add_event_cb(display_, OnFlushStart, LV_EVENT_FLUSH_START, this);
    if (offset_x || offset_y) lv_display_set_offset(display_, offset_x, offset_y);
    // Keep existing Latin metrics and retain the upstream Chinese glyph source.
    interface_font_ = *LV_FONT_DEFAULT;
    interface_font_.fallback = &BUILTIN_TEXT_FONT;
    auto* theme = lv_theme_default_init(display_, lv_palette_main(LV_PALETTE_BLUE),
                                       lv_palette_main(LV_PALETTE_RED), false, &interface_font_);
    ESP_ERROR_CHECK(theme ? ESP_OK : ESP_ERR_NO_MEM);
    lv_display_set_theme(display_, theme);
    g_display = this;
    LvglUnlock();
}
AgentDisplay::~AgentDisplay() {
    // Board lifetime: callers must release pages/touch before destroying this owner.
    LvglLock();
    ESP_ERROR_CHECK(esp_lcd_panel_io_tx_param(io_, -1, nullptr, 0));
    const esp_lcd_panel_io_callbacks_t callbacks{};
    ESP_ERROR_CHECK(esp_lcd_panel_io_register_event_callbacks(io_, &callbacks, nullptr));
    ESP_ERROR_CHECK(lvgl_port_remove_disp(display_));
    LvglUnlock();
    // The pinned port only requests task termination here; no hot recreation.
    ESP_ERROR_CHECK(lvgl_port_deinit());
}
void AgentDisplay::OnFlushStart(lv_event_t* event) {
    auto& self = *static_cast<AgentDisplay*>(lv_event_get_user_data(event));
    if (!lv_display_flush_is_last(self.display_)) return;
    const auto revision = diagnostics::TakePageForFlush();
    if (!revision) return;
    diagnostics::Record(diagnostics::Lane::Lvgl, diagnostics::Event::PageFlushStarted, revision);
    self.flushing_page_.store(revision, std::memory_order_release);
}
bool AgentDisplay::OnColorDone(esp_lcd_panel_io_handle_t, esp_lcd_panel_io_event_data_t*, void* context) {
    // The pinned StackChan SPI host uses its non-IRAM interrupt configuration.
    // Single-buffer LVGL cannot submit the next chunk until flush_ready below.
    auto& self = *static_cast<AgentDisplay*>(context);
    // A direct frame band (LVGL is paused while those run): not LVGL's flush.
    if (direct.inflight.load() > 0) {
        direct.inflight.fetch_sub(1);
        BaseType_t woken = pdFALSE;
        xSemaphoreGiveFromISR(direct.done, &woken);
        return woken == pdTRUE;
    }
    const auto revision = self.flushing_page_.load(std::memory_order_acquire);
    self.flushing_page_.store(0, std::memory_order_relaxed);
    if (revision) diagnostics::Record(diagnostics::Lane::Lcd, diagnostics::Event::PageFlushCompleted, revision);
    lv_display_flush_ready(self.display_);
    return false;
}
bool AgentDisplay::Lock(int timeout_ms) { return lvgl_port_lock(timeout_ms); }
void AgentDisplay::Unlock() { lvgl_port_unlock(); }
void AgentDisplay::LvglLock() { ESP_ERROR_CHECK(Lock(30000) ? ESP_OK : ESP_ERR_TIMEOUT); }
void AgentDisplay::LvglUnlock() { Unlock(); }
}
