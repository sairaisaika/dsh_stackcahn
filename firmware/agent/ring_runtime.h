// SPDX-License-Identifier: MIT
#pragma once
#include "ring_engine.h"

namespace sion::agent {
RingEngine& DeviceRing();
bool StartRingWorker();
}
