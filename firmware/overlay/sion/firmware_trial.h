// SPDX-License-Identifier: MIT
#pragma once
#include <string>
namespace sion {
void StartFirmwareTrial();
// True for the entire trial boot, including after confirmation. Pairing/local
// control only becomes available following a deliberate subsequent reboot.
bool FirmwareTrialRestricted();
std::string FirmwareTrialStatus();
bool ConfirmFirmwareTrial(const std::string& nonce, const std::string& image, bool observed);
[[noreturn]] void RefuseProvisioningDuringPreservation();
}  // namespace sion
