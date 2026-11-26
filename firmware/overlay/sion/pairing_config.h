// SPDX-License-Identifier: MIT
#pragma once
#include <cJSON.h>
#include <string>
#include "endpoint_policy.h"
namespace sion {
struct PairingConfig {
    std::string id, control_key, local_url, local_token, ca, cert, key;
};
inline bool Hex(const std::string& s, size_t size) {
    return s.size() == size && s.find_first_not_of("0123456789abcdef") == std::string::npos;
}
inline bool ParsePairing(const std::string& input, PairingConfig& output, bool allow_no_lan = false) {
    if (input.empty() || input.size() > 4096 || input.find('\0') != std::string::npos)
        return false;
    const char* end = nullptr;
    cJSON* json = cJSON_ParseWithLengthOpts(input.c_str(), input.size() + 1, &end, true);
    if (!json)
        return false;
    PairingConfig p;
    auto read = [&](const char* name, std::string& value) {
        auto* item = cJSON_GetObjectItemCaseSensitive(json, name);
        if (!cJSON_IsString(item))
            return false;
        value = item->valuestring;
        return true;
    };
    const auto* version = cJSON_GetObjectItemCaseSensitive(json, "version");
    bool ok = cJSON_IsObject(json) && cJSON_GetArraySize(json) == 9 && cJSON_IsNumber(version) &&
              version->valuedouble == 1 && read("pair_id", p.id) &&
              read("control_key", p.control_key) && read("local_url", p.local_url) &&
              read("local_token", p.local_token) && read("ca", p.ca) && read("cert", p.cert) &&
              read("key", p.key);
    auto* role = cJSON_GetObjectItemCaseSensitive(json, "role");
    ok = ok && cJSON_IsString(role) && std::string(role->valuestring) == "sion-device" &&
         Hex(p.id, 32) && Hex(p.control_key, 64) && Hex(p.local_token, 64) &&
         p.control_key != p.local_token &&
         ((allow_no_lan && p.local_url.empty()) ||
          (p.local_url.rfind("wss://", 0) == 0 && ValidLocalEndpoint(p.local_url))) &&
         p.ca.size() <= 1024 && p.cert.size() <= 1024 &&
         p.key.size() <= 512 && p.ca.rfind("-----BEGIN CERTIFICATE-----", 0) == 0 &&
         p.cert.rfind("-----BEGIN CERTIFICATE-----", 0) == 0 &&
         p.key.rfind("-----BEGIN PRIVATE KEY-----", 0) == 0;
    cJSON_Delete(json);
    if (ok)
        output = std::move(p);
    return ok;
}
inline bool ParseAgentPairing(const std::string& input, PairingConfig& output) {
    return ParsePairing(input, output, true);
}
}  // namespace sion
