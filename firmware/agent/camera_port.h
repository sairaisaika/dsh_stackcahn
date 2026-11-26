// SPDX-License-Identifier: MIT
#pragma once
#include "camera_engine.h"

namespace sion::agent {
// One board-lifetime instance, accessed exclusively by its camera worker.
// Initialization reuses the pinned board's DVP pins and existing I2C bus.
// An uncertain SDK teardown failure is latched: callers must not recreate this
// object to bypass it or claim release. No destructor performs hidden hardware IO.
class EspCameraPort final:public CameraPort {
public:
    bool Open() override;
    Result Read(uint8_t* target,size_t capacity,CameraImageInfo& info) override;
    bool Close() override;
private:
    int fd_=-1;
    bool initialized_=false,streaming_=false,poisoned_=false;
    void* mapping_=nullptr;
    size_t mapping_size_=0;
    CameraBuffer input_;
    void* encoder_=nullptr;
    unsigned discard_=0;
};
}
