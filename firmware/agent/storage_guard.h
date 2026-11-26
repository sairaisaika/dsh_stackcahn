// SPDX-License-Identifier: MIT
#pragma once
#include <esp_partition.h>
namespace sion::agent {
// Sion 16 MiB profile only. Placement remains an installation decision.
const esp_partition_t* AgentConfigPartition();
}
