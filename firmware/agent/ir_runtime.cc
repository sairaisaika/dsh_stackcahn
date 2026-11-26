// SPDX-License-Identifier: MIT
#include "ir_runtime.h"
#include <driver/rmt_rx.h>
#include <driver/rmt_tx.h>
#include <esp_timer.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <freertos/task.h>
#include <atomic>
#include <mutex>

namespace sion::agent {
namespace {
// Manual pin map: IR_SEND G5, IR_REC G10 (IRM56384, output low while it sees carrier).
constexpr gpio_num_t kSendPin = GPIO_NUM_5, kReceivePin = GPIO_NUM_10;
constexpr uint32_t kResolutionHz = 1000000;   // 1 us ticks
constexpr size_t kSymbols = 48;               // One RMT block; an NEC frame is 34 symbols.

class BoardIr final : public IrPort {
public:
    bool Start() {
        rmt_tx_channel_config_t tx{};
        tx.gpio_num = kSendPin; tx.clk_src = RMT_CLK_SRC_DEFAULT; tx.resolution_hz = kResolutionHz;
        tx.mem_block_symbols = kSymbols; tx.trans_queue_depth = 4;
        if (rmt_new_tx_channel(&tx, &tx_) != ESP_OK) return false;
        rmt_carrier_config_t carrier{};
        carrier.frequency_hz = 38000; carrier.duty_cycle = 0.33f;
        rmt_copy_encoder_config_t copy{};
        if (rmt_apply_carrier(tx_, &carrier) != ESP_OK || rmt_new_copy_encoder(&copy, &encoder_) != ESP_OK ||
            rmt_enable(tx_) != ESP_OK) return false;
        rmt_rx_channel_config_t rx{};
        rx.gpio_num = kReceivePin; rx.clk_src = RMT_CLK_SRC_DEFAULT; rx.resolution_hz = kResolutionHz;
        rx.mem_block_symbols = kSymbols;
        done_ = xQueueCreate(2, sizeof(rmt_rx_done_event_data_t));
        if (!done_ || rmt_new_rx_channel(&rx, &rx_) != ESP_OK) return false;
        rmt_rx_event_callbacks_t callbacks{};
        callbacks.on_recv_done = [](rmt_channel_handle_t, const rmt_rx_done_event_data_t* data, void* queue) {
            BaseType_t woken = pdFALSE;
            xQueueSendFromISR(static_cast<QueueHandle_t>(queue), data, &woken);
            return woken == pdTRUE;
        };
        if (rmt_rx_register_event_callbacks(rx_, &callbacks, done_) != ESP_OK || rmt_enable(rx_) != ESP_OK) return false;
        return Arm() && xTaskCreate([](void* self) { static_cast<BoardIr*>(self)->Run(); }, "sion_ir", 4096, this, 2, nullptr) == pdPASS;
    }
    bool Queue(uint16_t address, uint8_t command, uint8_t repeats) override {
        uint32_t expected = 0;
        const uint32_t request = 0x80000000u | (uint32_t(repeats) << 24) | (uint32_t(command) << 16) | address;
        return send_.compare_exchange_strong(expected, request);
    }
    int TakeSendResult() override { return result_.exchange(-1); }
    bool Take(IrCode& code) override {
        std::lock_guard<std::mutex> lock(mutex_);
        if (!count_) return false;
        code = codes_[head_]; head_ = (head_ + 1) % 8; --count_; return true;
    }
private:
    rmt_channel_handle_t tx_ = nullptr, rx_ = nullptr;
    rmt_encoder_handle_t encoder_ = nullptr;
    QueueHandle_t done_ = nullptr;
    rmt_symbol_word_t received_[kSymbols]{};
    std::atomic<uint32_t> send_{0};
    std::atomic<int> result_{-1};
    std::mutex mutex_;
    IrCode codes_[8]{};
    unsigned head_ = 0, count_ = 0;
    uint64_t quiet_until_ = 0;

    static uint64_t Now() { return static_cast<uint64_t>(esp_timer_get_time() / 1000); }
    bool Arm() {
        rmt_receive_config_t config{};
        config.signal_range_min_ns = 1250;        // Shorter is noise.
        config.signal_range_max_ns = 12000000;    // A 12 ms gap ends a frame.
        return rmt_receive(rx_, received_, sizeof received_, &config) == ESP_OK;
    }
    bool Transmit(const std::vector<IrPulse>& pulses) {
        rmt_symbol_word_t symbols[kSymbols]{};
        size_t n = 0;
        for (size_t i = 0; i < pulses.size() && n < kSymbols; i += 2, ++n) {
            symbols[n].level0 = 1; symbols[n].duration0 = pulses[i].us;
            symbols[n].level1 = 0; symbols[n].duration1 = i + 1 < pulses.size() ? pulses[i + 1].us : 1;
        }
        rmt_transmit_config_t config{};
        return rmt_transmit(tx_, encoder_, symbols, n * sizeof(rmt_symbol_word_t), &config) == ESP_OK &&
               rmt_tx_wait_all_done(tx_, 300) == ESP_OK;
    }
    void Run() {
        for (;;) {
            rmt_rx_done_event_data_t data{};
            if (xQueueReceive(done_, &data, pdMS_TO_TICKS(20)) == pdTRUE) {
                std::vector<IrPulse> pulses;
                for (size_t i = 0; i < data.num_symbols; ++i) {
                    const auto& s = data.received_symbols[i];
                    // The receiver pulls low while it sees carrier: low is a mark.
                    if (s.duration0) pulses.push_back({s.level0 == 0, static_cast<uint16_t>(s.duration0)});
                    if (s.duration1) pulses.push_back({s.level1 == 0, static_cast<uint16_t>(s.duration1)});
                }
                IrCode code;
                const auto now = Now();
                if (now >= quiet_until_ && NecDecode(pulses, code)) {   // Ignore our own echo.
                    code.at = now;
                    std::lock_guard<std::mutex> lock(mutex_);
                    if (count_ == 8) { head_ = (head_ + 1) % 8; --count_; }
                    codes_[(head_ + count_) % 8] = code; ++count_;
                }
                Arm();
            }
            const uint32_t request = send_.load();
            if (!(request & 0x80000000u)) continue;
            const uint16_t address = request & 0xffff;
            const uint8_t command = (request >> 16) & 0xff, repeats = (request >> 24) & 0x7f;
            quiet_until_ = Now() + 150 + repeats * 110;
            bool ok = Transmit(NecFrame(address, command));
            for (uint8_t i = 0; ok && i < repeats; ++i) { vTaskDelay(pdMS_TO_TICKS(40)); ok = Transmit(NecRepeat()); }
            result_.store(ok ? 0 : 1);
            send_.store(0);
        }
    }
};
BoardIr ir;
bool ir_ready = false;
}
IrPort* DeviceIr() { return ir_ready ? &ir : nullptr; }
bool StartInfraredWorker() { return ir_ready = ir.Start(); }
}
