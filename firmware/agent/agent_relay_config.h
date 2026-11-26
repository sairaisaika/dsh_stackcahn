// SPDX-License-Identifier: MIT
#pragma once
#include <string>

namespace sion::agent {
struct AgentRelayConfig {
    std::string origin, room, token, ca, ssid, password, revision;
};
enum class RelayState { Unavailable, Empty, Ready, Invalid, StorageError };
struct RelayStatus {
    RelayState state = RelayState::Unavailable;
    std::string revision;
};
inline constexpr char RelayBlobKey[] = "relay";
inline constexpr size_t MaxRelayRecord = 4096;

bool ParseAgentRelayConfig(const std::string& text, const std::string& pair_id, AgentRelayConfig& config);
bool ReadAgentRelayConfig(const std::string& pair_id, AgentRelayConfig& config);
RelayStatus ReadAgentRelayStatus(const std::string& pair_id);
bool ValidAgentRelayCA(const std::string& pem);
}
