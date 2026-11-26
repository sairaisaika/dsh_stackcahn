// SPDX-License-Identifier: MIT
#include "motion_runtime.h"
#include "motion_hardware.h"
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <esp_timer.h>
// Fixed official board bridge. Avoid importing unrelated LVGL/camera headers.
namespace hal_bridge {i2c_master_bus_handle_t board_get_i2c_bus();}
namespace sion::agent {
namespace {
EspMotionPort port(hal_bridge::board_get_i2c_bus);
MotionEngine engine(port);
TaskHandle_t worker=nullptr;
}
MotionEngine& DeviceMotion(){return engine;}
bool StartMotionWorker() {
    if(worker)return true;
    return xTaskCreate([](void*) {
        while(true) {
            engine.Pump(static_cast<uint64_t>(esp_timer_get_time()/1000));
            const TickType_t delay=pdMS_TO_TICKS(10);
            vTaskDelay(delay?delay:1);
        }
    },"sion_motion",6144,nullptr,1,&worker)==pdPASS;
}
}
