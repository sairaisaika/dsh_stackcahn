// SPDX-License-Identifier: MIT
#pragma once
#include "ir_nec.h"
namespace sion::agent {
// Starts the RMT channels and the IR worker; false leaves infrared unavailable.
bool StartInfraredWorker();
IrPort* DeviceIr();   // nullptr until started successfully
}
