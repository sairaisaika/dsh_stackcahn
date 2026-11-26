// SPDX-License-Identifier: MIT
#pragma once
#include "ambient_engine.h"
#include "ina226.h"

namespace sion::agent {
AmbientEngine& DeviceAmbient();
HeadTouchEngine& DeviceHeadTouch();
ImuEngine& DeviceImu();
const PowerReader& DevicePower();
bool StartSensorWorker();
}
