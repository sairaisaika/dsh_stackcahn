// SPDX-License-Identifier: MIT
#include "camera_runtime.h"
#include "camera_port.h"
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <esp_timer.h>
namespace sion::agent {
namespace {
EspCameraPort port;
CameraEngine engine(port);
TaskHandle_t worker=nullptr;
}
CameraEngine& DeviceCamera(){return engine;}
bool StartCameraWorker() {
    if(worker) return true;
    return xTaskCreate([](void*) {
        while(true) {
            engine.Pump(static_cast<uint64_t>(esp_timer_get_time()/1000));
            // Yield between acquisition/encoding/close steps. Same priority as
            // main, below audio; no forced deletion during SDK IO.
            const TickType_t delay=pdMS_TO_TICKS(10);
            vTaskDelay(delay?delay:1);
        }
    },"sion_camera",12288,nullptr,1,&worker)==pdPASS;
}
}
