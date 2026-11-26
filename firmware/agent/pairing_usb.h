// SPDX-License-Identifier: MIT
#pragma once
#include "pairing_service.h"
namespace sion::agent {
class AgentCarrier;
AgentCarrier& DeviceUsbAudio();
PairingMaintenance& DevicePairing();
bool StartPairingUsb();
// True while a USB host is enumerating the device, not merely powering it.
bool DeviceUsbHostPresent();
// Called only by the UI owner after checking all resources are idle.
bool OpenDevicePairingWindow(uint64_t now);
}
