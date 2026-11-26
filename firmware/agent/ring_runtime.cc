// SPDX-License-Identifier: MIT
#include "ring_runtime.h"
#include "ring_port.h"
#include <esp_timer.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>

namespace hal_bridge { i2c_master_bus_handle_t board_get_i2c_bus(); }

namespace sion::agent {
namespace {
class BoardRingPort final : public RingPort {
    EspRingPort port_;
public:
    bool Open() override { return port_.Open(hal_bridge::board_get_i2c_bus()); }
    bool Show(const RingFrame& frame) override { return port_.Show(frame); }
    bool Close() override { return port_.Close(); }
};
BoardRingPort port;
RingEngine engine(port);
TaskHandle_t worker = nullptr;
}

RingEngine& DeviceRing() { return engine; }
bool StartRingWorker() {
    if (worker) return true;
    return xTaskCreate([](void*) {
        while (true) {
            engine.Pump(static_cast<uint64_t>(esp_timer_get_time() / 1000));
            const TickType_t ticks = pdMS_TO_TICKS(10);
            vTaskDelay(ticks ? ticks : 1);
        }
    }, "sion_ring", 3072, nullptr, 1, &worker) == pdPASS;
}

}
