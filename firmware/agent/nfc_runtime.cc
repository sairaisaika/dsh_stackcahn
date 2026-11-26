// SPDX-License-Identifier: MIT
#include "nfc_runtime.h"
#include <driver/i2c_master.h>
#include <esp_timer.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <atomic>
#include <mutex>

namespace hal_bridge { i2c_master_bus_handle_t board_get_i2c_bus(); }

namespace sion::agent {
namespace {
// ST25R3916 on the internal bus (shared with the IMU, head touch and PY32), I2C 0x50.
constexpr uint8_t kAddress = 0x50;
constexpr uint32_t kSpeed = 400000;
constexpr uint32_t kPollMs = 250;
// A page read waits up to this many polls (about 2 s) for the card to answer:
// a card that is only just in range misses single polls.
constexpr unsigned kReadAttempts = 8;

class NfcBus {
public:
    bool Open() {
        i2c_device_config_t config{};
        config.dev_addr_length = I2C_ADDR_BIT_LEN_7;
        config.device_address = kAddress;
        config.scl_speed_hz = kSpeed;
        const auto bus = hal_bridge::board_get_i2c_bus();
        return bus && !device_ && i2c_master_bus_add_device(bus, &config, &device_) == ESP_OK;
    }
    void Close() { if (device_ && i2c_master_bus_rm_device(device_) == ESP_OK) device_ = nullptr; }
    bool Write(const uint8_t* bytes, size_t n) { return i2c_master_transmit(device_, bytes, n, 10) == ESP_OK; }
    bool Transfer(const uint8_t* tx, size_t n, uint8_t* rx, size_t m) {
        return i2c_master_transmit_receive(device_, tx, n, rx, m, 10) == ESP_OK;
    }
    uint64_t Micros() { return static_cast<uint64_t>(esp_timer_get_time()); }
    void SleepMs(uint32_t ms) { vTaskDelay(pdMS_TO_TICKS(ms) + 1); }
private:
    i2c_master_dev_handle_t device_ = nullptr;
};

class BoardNfc final : public NfcPort {
public:
    bool Ready() const override { return ready_.load(); }
    void Enable(bool on) override {
        std::lock_guard<std::mutex> lock(mutex_);
        on_ = on;
        ++generation_;
        count_ = 0;
        read_pending_ = read_done_ = false;   // A pending read is dropped with the session
        stats_ = {};
    }
    bool RequestRead(uint8_t page, uint8_t count) override {
        std::lock_guard<std::mutex> lock(mutex_);
        if (!on_ || read_pending_ || read_done_ || !count || count > NfcRead::kMaxPages) return false;
        read_ = {};read_.page = page;read_.count = count;
        read_pending_ = true;read_attempts_ = 0;
        return true;
    }
    bool TakeRead(NfcRead& read, NfcCard& card) override {
        std::lock_guard<std::mutex> lock(mutex_);
        if (!read_done_) return false;
        read = read_; card = read_card_; read_done_ = false;
        return true;
    }
    NfcPollStats Stats() override {
        std::lock_guard<std::mutex> lock(mutex_);
        return stats_;
    }
    bool Take(NfcEvent& event) override {
        std::lock_guard<std::mutex> lock(mutex_);
        if (!count_) return false;
        event = events_[head_]; head_ = (head_ + 1) % 8; --count_;
        return true;
    }
    void Run() {
        if (!bus_.Open()) { vTaskDelete(nullptr); return; }
        if (!reader_.Begin()) { bus_.Close(); vTaskDelete(nullptr); return; }   // Not this chip or setup failed
        ready_ = true;
        uint32_t seen = 0;
        bool field = false;
        for (;;) {
            uint32_t generation = 0;
            bool on = false, reading = false;
            NfcRead read;
            {
                std::lock_guard<std::mutex> lock(mutex_);
                generation = generation_; on = on_; reading = read_pending_;
                if (reading) read = read_;
            }
            if (generation != seen) { seen = generation; presence_.Reset(); reader_.ResetStats(); }
            if (!on) {
                if (field) field = !reader_.FieldOff();
                vTaskDelay(pdMS_TO_TICKS(kPollMs) + 1);
                continue;
            }
            NfcCard card;
            const auto result = reader_.PollOnce(card, reading ? &read : nullptr);
            if (reading) {
                std::lock_guard<std::mutex> lock(mutex_);
                const bool retry = read.code == NfcRead::Code::NoCard && ++read_attempts_ < kReadAttempts;
                if (generation_ == generation && read_pending_ && !retry) {
                    if (result == St25r3916<NfcBus>::Poll::BusError) read.code = NfcRead::Code::Failed;
                    read_ = read; read_card_ = result == St25r3916<NfcBus>::Poll::Card ? card : NfcCard{};
                    read_pending_ = false; read_done_ = true;
                }
            }
            {
                std::lock_guard<std::mutex> lock(mutex_);
                if (generation_ == generation) stats_ = reader_.stats();
            }
            field = result == St25r3916<NfcBus>::Poll::BusError;   // Off unless the bus failed on the way
            if (result != St25r3916<NfcBus>::Poll::BusError) {
                const uint64_t now = static_cast<uint64_t>(esp_timer_get_time() / 1000);
                presence_.Note(result == St25r3916<NfcBus>::Poll::Card, card, now, [&](const NfcEvent& event) {
                    std::lock_guard<std::mutex> lock(mutex_);
                    if (generation_ != seen) return;   // Enabled afresh meanwhile
                    if (count_ == 8) { head_ = (head_ + 1) % 8; --count_; }
                    events_[(head_ + count_) % 8] = event; ++count_;
                });
            }
            vTaskDelay(pdMS_TO_TICKS(result == St25r3916<NfcBus>::Poll::BusError ? 1000 : kPollMs) + 1);
        }
    }
private:
    NfcBus bus_;
    St25r3916<NfcBus> reader_{bus_};
    NfcPresence presence_;
    std::atomic<bool> ready_{false};
    std::mutex mutex_;
    bool on_ = false;
    uint32_t generation_ = 0;
    NfcEvent events_[8]{};
    NfcRead read_{};
    NfcCard read_card_{};
    bool read_pending_ = false, read_done_ = false;
    unsigned head_ = 0, count_ = 0, read_attempts_ = 0;
    NfcPollStats stats_{};
};
BoardNfc nfc;
bool nfc_started = false;
}
NfcPort* DeviceNfc() { return nfc_started ? &nfc : nullptr; }
bool StartNfcWorker() {
    return nfc_started = xTaskCreate([](void* self) { static_cast<BoardNfc*>(self)->Run(); },
                                     "sion_nfc", 4096, &nfc, 1, nullptr) == pdPASS;
}
}
