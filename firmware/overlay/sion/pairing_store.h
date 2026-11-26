// SPDX-License-Identifier: MIT
#pragma once
#include "pairing_config.h"
namespace sion {
// Owns only sion_pair / slot0, slot1, active. Never erases a partition.
class PairingStore {
public:
    bool Load(PairingConfig& config, std::string* raw = nullptr);
    bool Replace(const std::string& expected_id, const std::string& record);
    bool Remove(const std::string& expected_id);

private:
    bool Save(const std::string& expected_id, const std::string& record);
};
}  // namespace sion
