// SPDX-License-Identifier: MIT
#pragma once
#include "camera_engine.h"
namespace sion::agent {
CameraEngine& DeviceCamera();
// Application owner only, idempotent. Starts an idle worker, no sensor IO.
// The board-lifetime worker stays alive across Home; Stop closes its resources.
bool StartCameraWorker();
}
