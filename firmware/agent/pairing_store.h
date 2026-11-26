// SPDX-License-Identifier: MIT
#pragma once
#include <string>
namespace sion::agent {
enum class PairingState { Empty, Paired, Revoked, Unavailable, Corrupt, StorageError };
struct PairingStatus {
    PairingState state=PairingState::Unavailable;
    std::string id; // Non-secret identity; UI need only display state.
};
enum class PairingWrite { Saved, Unchanged, Conflict, Invalid, Unavailable, Corrupt, StorageError, NoSpace, Uncertain };
// Single serialized owner. Call only after resource drain for mutations. No
// transport is started here, no factory namespace is opened, no implicit reset.
class AgentPairingStore {
public:
    PairingStatus Read(std::string* private_record=nullptr);
    PairingWrite Replace(const std::string& expected_id,const std::string& record);
    PairingWrite Remove(const std::string& expected_id);
    PairingWrite WriteRelay(const std::string& expected_id,const std::string* record);
private:
    PairingWrite Save(const std::string& expected_id,const std::string& record);
};
const char* PairingStateText(PairingState state);
}
