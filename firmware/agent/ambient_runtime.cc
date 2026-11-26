// SPDX-License-Identifier: MIT
#include "ambient_runtime.h"
#include "bmi270_agent.h"
#include "ina226.h"
#include "device_trace.h"
#include "hal/drivers/bmi270/BMI270_SensorAPI/bmi270.h"
#include "ltr553.h"
#include "si12t.h"
#include <driver/i2c_master.h>
#include <esp_timer.h>
#include <esp_rom_sys.h>
#include <cstring>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>

namespace hal_bridge { i2c_master_bus_handle_t board_get_i2c_bus(); }

namespace sion::agent {
namespace {
class BoardSensorBus {
public:
    explicit constexpr BoardSensorBus(uint8_t address, uint32_t speed = 100000) : address_(address), speed_(speed) {}

    bool Open() {
        i2c_device_config_t config{};
        config.dev_addr_length = I2C_ADDR_BIT_LEN_7;
        config.device_address = address_;
        config.scl_speed_hz = speed_;
        const auto bus = hal_bridge::board_get_i2c_bus();
        return bus && !device_ && i2c_master_bus_add_device(bus, &config, &device_) == ESP_OK;
    }

    bool Read(uint8_t reg, uint8_t* bytes, size_t size) {
        return i2c_master_transmit_receive(device_, &reg, 1, bytes, size, 10) == ESP_OK;
    }

    bool Write(uint8_t reg, uint8_t value) {
        const uint8_t bytes[] = {reg, value};
        return i2c_master_transmit(device_, bytes, sizeof bytes, 10) == ESP_OK;
    }

    bool Close() {
        if (device_ && i2c_master_bus_rm_device(device_) != ESP_OK) return false;
        device_ = nullptr;
        return true;
    }

protected:
    i2c_master_dev_handle_t device_ = nullptr;
private:
    uint8_t address_;
    uint32_t speed_;
};

constexpr size_t ImuTransferBytes = 32;
class BoardImuBus final : public BoardSensorBus {
public:
    BoardImuBus() : BoardSensorBus(0x69, 400000) {}

    bool Initialize() {
        struct bmi2_dev driver{};
        driver.intf = BMI2_I2C_INTF;
        driver.intf_ptr = this;
        driver.read_write_len = ImuTransferBytes;
        driver.read = [](uint8_t reg, uint8_t* data, uint32_t length, void* context) -> BMI2_INTF_RETURN_TYPE {
            auto& bus = *static_cast<BoardImuBus*>(context);
            return bus.Read(reg, data, length) ? BMI2_OK : BMI2_E_COM_FAIL;
        };
        driver.write = [](uint8_t reg, const uint8_t* data, uint32_t length, void* context) -> BMI2_INTF_RETURN_TYPE {
            if (length > ImuTransferBytes) return BMI2_E_COM_FAIL;
            auto& bus = *static_cast<BoardImuBus*>(context);
            uint8_t packet[ImuTransferBytes + 1] = {reg};
            std::memcpy(packet + 1, data, length);
            return i2c_master_transmit(bus.device_, packet, length + 1, 10) == ESP_OK ? BMI2_OK : BMI2_E_COM_FAIL;
        };
        driver.delay_us = [](uint32_t us, void*) {
            if (us < 1000) esp_rom_delay_us(us);
            else vTaskDelay(pdMS_TO_TICKS((us + 999) / 1000) + 1);
        };
        return bmi270_init(&driver) == BMI2_OK;
    }

    void WaitForRegisterWrite() { esp_rom_delay_us(500); }
};

BoardSensorBus ambient_bus(0x23);
Ltr553 ambient_sensor(ambient_bus);
AmbientEngine ambient(ambient_sensor);
BoardSensorBus touch_bus(0x68);
Si12t touch_sensor(touch_bus);
HeadTouchEngine head_touch(touch_sensor);
BoardImuBus imu_bus;
Bmi270Agent imu_sensor(imu_bus);
ImuEngine imu(imu_sensor);
BoardSensorBus power_bus(0x41, 400000);
Ina226Monitor<BoardSensorBus> power_monitor(power_bus);
struct BoardPower final : PowerReader {
    PowerSample Latest(uint64_t now) const override { return power_monitor.Latest(now); }
} power_reader;
}

AmbientEngine& DeviceAmbient() { return ambient; }
HeadTouchEngine& DeviceHeadTouch() { return head_touch; }
ImuEngine& DeviceImu() { return imu; }
const PowerReader& DevicePower() { return power_reader; }

namespace {
// Boot-lane facts about why a sensor reports no data (v67: the IMU went dark
// with no record). Open failures by step; read streaks once per streak.
void TraceSensorFaults() {
    using diagnostics::Event;
    static unsigned seen[3]{};
    static bool streak = false;
    const unsigned failures[3]{ambient.OpenFailures(), head_touch.OpenFailures(), imu.OpenFailures()};
    for (unsigned sensor = 0; sensor < 3; ++sensor) {
        if (failures[sensor] == seen[sensor]) continue;
        if (failures[sensor] > seen[sensor])
            diagnostics::Record(diagnostics::Lane::Boot, Event::SensorOpenFailed,
                (sensor << 16) | (sensor == 2 ? imu_sensor.OpenFailure() : 0));
        seen[sensor] = failures[sensor];
    }
    const bool failing = imu_sensor.NotReady() >= 10 || imu_sensor.ReadErrors() >= 10;
    if (failing && !streak)
        diagnostics::Record(diagnostics::Lane::Boot, Event::SensorOpenFailed,
            (2u << 16) | (imu_sensor.ReadErrors() >= 10 ? 0x11u : 0x10u));
    streak = failing;
}
}

bool StartSensorWorker() {
    return xTaskCreate([](void*) {
        for (;;) {
            ambient.Pump(static_cast<uint64_t>(esp_timer_get_time() / 1000));
            head_touch.Pump(static_cast<uint64_t>(esp_timer_get_time() / 1000));
            imu.Pump(static_cast<uint64_t>(esp_timer_get_time() / 1000));
            TraceSensorFaults();
            power_monitor.Pump(static_cast<uint64_t>(esp_timer_get_time() / 1000));
            const auto ticks = pdMS_TO_TICKS(10);   // The IMU samples every 20 ms.
            vTaskDelay(ticks ? ticks : 1);
        }
    }, "sion_sensors", 4096, nullptr, 1, nullptr) == pdPASS;
}
}
