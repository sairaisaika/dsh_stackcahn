// SPDX-License-Identifier: MIT
#pragma once
#include "nfc_st25r3916.h"
namespace sion::agent {
// Starts the NFC worker: it sets up the ST25R3916 on the internal I2C bus and
// then polls while the session has it enabled. False only when the task could
// not start; a missing or failed chip leaves Ready() false and nothing else changes.
bool StartNfcWorker();
NfcPort* DeviceNfc();   // nullptr until the worker started
}
