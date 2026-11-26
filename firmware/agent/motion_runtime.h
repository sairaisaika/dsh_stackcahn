// SPDX-License-Identifier: MIT
#pragma once
#include "motion_engine.h"
namespace sion::agent {
MotionEngine& DeviceMotion();
// App thread only, idempotent. Starts an idle task with permission disabled;
// never powers motors, opens UART or reads calibration until an accepted Begin.
// Worker persists across Home; Stop releases resources, not the task itself.
bool StartMotionWorker();
}
